import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  compareAssets as compareRatevertAssets,
  getRate as getRatevertRate,
  RatevertApiError,
  searchAssets as searchRatevertAssets,
} from "./ratevert-client.mjs";

function parseIntEnv(name, fallback) {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

function parseOriginList(value, fallback) {
  return new Set(
    (value ?? fallback)
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          return null;
        }
      })
      .filter((origin) => Boolean(origin)),
  );
}

const PORT = parseIntEnv("RATEVERT_MCP_PORT", 3010);
const PUBLIC_SITE_URL = normalizeUrl(process.env.RATEVERT_MCP_SITE_URL ?? "https://ratevert.com");
const PUBLIC_SITE_ORIGIN = new URL(PUBLIC_SITE_URL).origin;
const PUBLIC_MCP_URL = normalizeUrl(process.env.RATEVERT_MCP_PUBLIC_URL ?? `${PUBLIC_SITE_URL}/api/mcp`);
const PUBLIC_DOCS_URL = normalizeUrl(process.env.RATEVERT_MCP_DOCS_URL ?? `${PUBLIC_SITE_URL}/mcp`);
const PUBLIC_PRIVACY_URL = normalizeUrl(
  process.env.RATEVERT_MCP_PRIVACY_URL ?? `${PUBLIC_SITE_URL}/privacy-policy`,
);
const SUPPORT_EMAIL = process.env.RATEVERT_MCP_SUPPORT_EMAIL ?? "info@ratevert.com";
const SOURCE_SITE = new URL(PUBLIC_SITE_URL).hostname;
const FREE_ASSET_LIMIT = parseIntEnv(
  "RATE_FREE_ASSET_LIMIT",
  parseIntEnv("NEXT_PUBLIC_RATE_FREE_ASSET_LIMIT", 4),
);
const RATE_LIMIT_WINDOW_MS = parseIntEnv("RATEVERT_MCP_RATE_LIMIT_WINDOW_MS", 60_000);
const RATE_LIMIT_MAX_REQUESTS = parseIntEnv("RATEVERT_MCP_RATE_LIMIT_MAX_REQUESTS", 120);
const MAX_COMPARISON_RATE_LIMIT_WINDOW_MS = parseIntEnv(
  "RATEVERT_MCP_MAX_COMPARISON_RATE_LIMIT_WINDOW_MS",
  300_000,
);
const MAX_COMPARISON_RATE_LIMIT_MAX_REQUESTS = parseIntEnv(
  "RATEVERT_MCP_MAX_COMPARISON_RATE_LIMIT_MAX_REQUESTS",
  10,
);
const PAIR_RATE_LIMIT_WINDOW_MS = parseIntEnv("RATEVERT_MCP_PAIR_RATE_LIMIT_WINDOW_MS", 300_000);
const PAIR_RATE_LIMIT_MAX_REQUESTS = parseIntEnv("RATEVERT_MCP_PAIR_RATE_LIMIT_MAX_REQUESTS", 20);
const REQUEST_BODY_LIMIT = process.env.RATEVERT_MCP_REQUEST_BODY_LIMIT ?? "64kb";
const TRUST_PROXY = process.env.RATEVERT_MCP_TRUST_PROXY ?? "loopback";
const ALLOWED_ORIGINS = parseOriginList(
  process.env.RATEVERT_MCP_ALLOWED_ORIGINS,
  `${PUBLIC_SITE_ORIGIN},https://chatgpt.com,https://claude.ai`,
);
const MARKET_OPTIONS = ["all", "fiat", "stocks", "etfs", "funds", "crypto"];
const MarketSchema = z.enum(MARKET_OPTIONS);
const rateLimitStore = new Map();

function formatRate(value) {
  const absolute = Math.abs(value);
  const maximumFractionDigits =
    absolute >= 1000 ? 2 : absolute >= 1 ? 6 : absolute >= 0.01 ? 8 : 10;

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(value);
}

function formatConvertedAmount(value) {
  const absolute = Math.abs(value);
  const maximumFractionDigits =
    absolute >= 1000 ? 2 : absolute >= 1 ? 6 : absolute >= 0.01 ? 8 : 10;

  return {
    display: new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value),
    maximumFractionDigits,
  };
}

export function getClientIp(request) {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function getRequestPolicy() {
  return {
    compareAssetLimit: FREE_ASSET_LIMIT,
    maxRequests: RATE_LIMIT_MAX_REQUESTS,
    maxComparisonRateLimitMaxRequests: MAX_COMPARISON_RATE_LIMIT_MAX_REQUESTS,
    maxComparisonRateLimitWindowMs: MAX_COMPARISON_RATE_LIMIT_WINDOW_MS,
    pairRateLimitMaxRequests: PAIR_RATE_LIMIT_MAX_REQUESTS,
    pairRateLimitWindowMs: PAIR_RATE_LIMIT_WINDOW_MS,
    plan: "free",
    rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
  };
}

function cleanupRateLimitStore(now) {
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

function consumeRateLimit({ key, maxRequests, now = Date.now(), windowMs }) {
  cleanupRateLimitStore(now);

  let entry = rateLimitStore.get(key);

  if (!entry || entry.resetAt <= now) {
    entry = {
      count: 0,
      resetAt: now + windowMs,
    };
  }

  if (entry.count >= maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

    return {
      allowed: false,
      limit: maxRequests,
      retryAfterSeconds,
      resetAt: entry.resetAt,
      windowMs,
    };
  }

  entry.count += 1;
  rateLimitStore.set(key, entry);

  return {
    allowed: true,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - entry.count),
    resetAt: entry.resetAt,
    windowMs,
  };
}

function applyRateLimit(request, response) {
  const policy = getRequestPolicy();
  const ip = getClientIp(request);
  const rateLimit = consumeRateLimit({
    key: `global:${ip}`,
    maxRequests: policy.maxRequests,
    windowMs: policy.rateLimitWindowMs,
  });

  if (!rateLimit.allowed) {
    const retryAfterSeconds = rateLimit.retryAfterSeconds;

    response.setHeader("Retry-After", String(retryAfterSeconds));
    response.status(429).json({
      error: {
        code: "rate_limit_exceeded",
        details: {
          limit: rateLimit.limit,
          retryAfterSeconds,
          windowMs: rateLimit.windowMs,
        },
        message: "Too many Ratevert MCP requests for the free plan. Try again shortly.",
      },
    });
    return null;
  }

  response.setHeader("X-RateLimit-Limit", String(rateLimit.limit));
  response.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
  response.setHeader("X-RateLimit-Reset", String(Math.ceil(rateLimit.resetAt / 1000)));

  return {
    ip,
    policy,
    requestId: randomUUID(),
  };
}

function logEvent(event, payload) {
  console.info(
    JSON.stringify({
      event,
      ts: new Date().toISOString(),
      ...payload,
    }),
  );
}

function buildToolError(error, fallbackMessage) {
  if (error instanceof RatevertApiError) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      structuredContent: {
        error: {
          code: error.code,
          details: error.details,
          status: error.status,
        },
      },
      isError: true,
    };
  }

  console.error("Unexpected MCP tool error", error);

  return {
    content: [{ type: "text", text: `Error: ${fallbackMessage}` }],
    structuredContent: {
      error: {
        code: "internal_error",
        details: null,
        status: 500,
      },
    },
    isError: true,
  };
}

function normalizeRateLimitPart(value) {
  return String(value).trim().toLowerCase();
}

function buildMcpRateLimitError({ limit, message, retryAfterSeconds, windowMs }) {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    structuredContent: {
      error: {
        code: "rate_limit_exceeded",
        details: {
          limit,
          retryAfterSeconds,
          windowMs,
        },
        status: 429,
      },
    },
    isError: true,
  };
}

function checkToolRateLimit({ key, maxRequests, message, windowMs }) {
  const rateLimit = consumeRateLimit({
    key,
    maxRequests,
    windowMs,
  });

  if (rateLimit.allowed) {
    return null;
  }

  return buildMcpRateLimitError({
    limit: rateLimit.limit,
    message,
    retryAfterSeconds: rateLimit.retryAfterSeconds,
    windowMs: rateLimit.windowMs,
  });
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  // Ratevert's market feeds use Unix seconds while fiat feeds use ISO strings.
  // JavaScript Date expects milliseconds for numeric input, so normalize epoch
  // seconds before exposing source freshness to MCP clients.
  const timestamp = typeof value === "number" && value > 0 && value < 100_000_000_000 ? value * 1000 : value;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function getEarliestFreshness(values) {
  const timestamps = values
    .map(normalizeTimestamp)
    .filter((value) => value)
    .sort();

  return timestamps[0] ?? null;
}

function buildFreshness(payload) {
  return {
    as_of: getEarliestFreshness(payload),
    retrieved_at: new Date().toISOString(),
  };
}

function buildSearchOutput(payload, { market, query }) {
  const sourceUrl = payload.results[0]?.canonicalUrl ?? PUBLIC_SITE_URL;

  return {
    endpoint: PUBLIC_MCP_URL,
    market,
    query,
    results: payload.results,
    retrieved_at: new Date().toISOString(),
    sourceSite: payload.sourceSite,
    sourceUrl,
    total: payload.total,
    view: "search",
  };
}

function buildRateOutput(payload) {
  return {
    ...payload,
    ...buildFreshness([payload.base?.updatedAt, payload.quote?.updatedAt]),
    sourceSite: payload.sourceSite ?? SOURCE_SITE,
    sourceUrl: payload.sourceUrl,
    view: "rate",
  };
}

function buildComparisonOutput(payload) {
  return {
    ...payload,
    ...buildFreshness([
      payload.source?.updatedAt,
      ...(payload.comparisons ?? []).map((entry) => entry.asset?.updatedAt),
    ]),
    sourceSite: payload.sourceSite ?? SOURCE_SITE,
    sourceUrl: payload.sourceUrl,
    view: "comparison",
  };
}

function buildLimitHandoffOutput({ source, targets }) {
  const totalAssets = 1 + targets.length;
  const parameters = new URLSearchParams({ source });

  for (const target of targets) {
    parameters.append("target", target);
  }

  return {
    freeAssetLimit: FREE_ASSET_LIMIT,
    limit: FREE_ASSET_LIMIT,
    message: `Ratevert compares up to ${FREE_ASSET_LIMIT} total assets directly. Larger comparisons continue on Ratevert.`,
    requestedAssets: [source, ...targets],
    sourceSite: SOURCE_SITE,
    sourceUrl: `${PUBLIC_SITE_URL}/multi-market-converter?${parameters.toString()}`,
    totalAssets,
    view: "limit",
  };
}

function createServer(context) {
  const server = new McpServer(
    {
      name: "Ratevert",
      version: "0.3.0",
      icons: [
        {
          src: `${PUBLIC_SITE_URL}/favicon.ico`,
          mimeType: "image/x-icon",
        },
      ],
      websiteUrl: PUBLIC_SITE_URL,
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    "search_assets",
    {
      title: "Search Ratevert assets",
      description:
        "Resolve a canonical Ratevert currency, stock, ETF, fund, or crypto asset before requesting a rate or comparison.",
      inputSchema: {
        query: z.string().min(1).max(120).describe('Asset name or code, for example "btc", "nvda", or "euro".'),
        market: MarketSchema.optional().describe(
          "Optional market filter: all, fiat, stocks, etfs, funds, or crypto.",
        ),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum matches to return."),
      },
      annotations: {
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ query, market = "all", limit = 10 }) => {
      try {
        const payload = await searchRatevertAssets({ query, market, limit });
        const output = buildSearchOutput(payload, { market, query });

        logEvent("search_assets", {
          ip: context.ip,
          market,
          queryLength: query.length,
          requestId: context.requestId,
          resultCount: payload.results.length,
        });

        return {
          content: [
            {
              type: "text",
              text: payload.results.length
                ? `Found ${payload.results.length} matching Ratevert assets. Source: ${output.sourceUrl}`
                : `No Ratevert assets matched that query. Source: ${output.sourceUrl}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return buildToolError(error, "Failed to search Ratevert assets.");
      }
    },
  );

  server.registerTool(
    "get_rate",
    {
      title: "Get an exact pair rate",
      description:
        "Return the current one-unit conversion rate for exactly two Ratevert assets with a canonical source URL and freshness metadata.",
      inputSchema: {
        base: z.string().min(1).max(120).describe('Base asset code or alias, for example "btc" or "nvidia-corporation".'),
        quote: z.string().min(1).max(120).describe('Quote asset code or alias, for example "usd" or "euro".'),
      },
      annotations: {
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ base, quote }) => {
      const pairKey = [normalizeRateLimitPart(base), normalizeRateLimitPart(quote)].join("/");
      const pairRateLimitError = checkToolRateLimit({
        key: `pair:${context.ip}:${pairKey}`,
        maxRequests: context.policy.pairRateLimitMaxRequests,
        message: `Ratevert MCP allows ${context.policy.pairRateLimitMaxRequests} requests per pair per IP every ${Math.round(context.policy.pairRateLimitWindowMs / 1000)} seconds. Try this pair again shortly.`,
        windowMs: context.policy.pairRateLimitWindowMs,
      });

      if (pairRateLimitError) {
        logEvent("get_rate_rate_limit", {
          ip: context.ip,
          requestId: context.requestId,
        });
        return pairRateLimitError;
      }

      try {
        const payload = await getRatevertRate({ base, quote });
        const output = buildRateOutput(payload);

        logEvent("get_rate", {
          base: payload.base.code,
          ip: context.ip,
          quote: payload.quote.code,
          requestId: context.requestId,
          sourceUrl: output.sourceUrl,
        });

        return {
          content: [
            {
              type: "text",
              text: `1 ${payload.base.code} = ${formatRate(payload.rate)} ${payload.quote.code}\nSource: ${output.sourceUrl}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return buildToolError(error, "Failed to resolve the requested pair rate.");
      }
    },
  );

  server.registerTool(
    "convert_amount",
    {
      title: "Convert an amount between two assets",
      description:
        "Convert a stated amount using the current Ratevert pair rate. Returns the original and converted values, rate, display rounding, freshness metadata, and canonical source URL.",
      inputSchema: {
        amount: z.number().finite().min(0).describe("Non-negative amount to convert."),
        from: z.string().min(1).max(120).describe('Source asset code or alias, for example "usd".'),
        to: z.string().min(1).max(120).describe('Target asset code or alias, for example "btc".'),
      },
      annotations: {
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ amount, from, to }) => {
      const pairKey = [normalizeRateLimitPart(from), normalizeRateLimitPart(to)].join("/");
      const pairRateLimitError = checkToolRateLimit({
        key: `pair:${context.ip}:${pairKey}`,
        maxRequests: context.policy.pairRateLimitMaxRequests,
        message: `Ratevert MCP allows ${context.policy.pairRateLimitMaxRequests} requests per pair per IP every ${Math.round(context.policy.pairRateLimitWindowMs / 1000)} seconds. Try this pair again shortly.`,
        windowMs: context.policy.pairRateLimitWindowMs,
      });

      if (pairRateLimitError) {
        logEvent("convert_amount_rate_limit", {
          ip: context.ip,
          requestId: context.requestId,
        });
        return pairRateLimitError;
      }

      try {
        const payload = await getRatevertRate({ base: from, quote: to });
        const convertedAmount = amount * payload.rate;

        if (!Number.isFinite(convertedAmount)) {
          throw new RatevertApiError("The converted amount is outside the supported numeric range.", {
            code: "invalid_amount",
            status: 400,
          });
        }

        const rateOutput = buildRateOutput(payload);
        const display = formatConvertedAmount(convertedAmount);
        const output = {
          amount,
          as_of: rateOutput.as_of,
          base: payload.base,
          canonicalPath: payload.canonicalPath,
          canonicalUrl: payload.canonicalUrl,
          convertedAmount,
          convertedDisplay: display.display,
          displayRounding: {
            maximumFractionDigits: display.maximumFractionDigits,
          },
          from: payload.base,
          quote: payload.quote,
          rate: payload.rate,
          retrieved_at: rateOutput.retrieved_at,
          sourceSite: rateOutput.sourceSite,
          sourceUrl: rateOutput.sourceUrl,
          to: payload.quote,
          view: "conversion",
        };

        logEvent("convert_amount", {
          base: payload.base.code,
          ip: context.ip,
          quote: payload.quote.code,
          requestId: context.requestId,
        });

        return {
          content: [
            {
              type: "text",
              text: `${formatRate(amount)} ${payload.base.code} = ${display.display} ${payload.quote.code}\nRate: 1 ${payload.base.code} = ${formatRate(payload.rate)} ${payload.quote.code}\nSource: ${output.sourceUrl}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return buildToolError(error, "Failed to convert the requested amount.");
      }
    },
  );

  server.registerTool(
    "compare_assets",
    {
      title: "Compare one asset against multiple targets",
      description:
        `Compare one Ratevert asset against multiple targets across supported markets. Free requests are limited to ${FREE_ASSET_LIMIT} total assets including the source.`,
      inputSchema: {
        source: z.string().min(1).max(120).describe('Source asset identifier, for example "btc".'),
        targets: z
          .array(z.string().min(1).max(120))
          .min(1)
          .max(12)
          .describe(`Target asset identifiers. The free limit is ${FREE_ASSET_LIMIT} total assets including the source.`),
      },
      annotations: {
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ source, targets }) => {
      const totalAssets = 1 + targets.length;

      if (totalAssets === context.policy.compareAssetLimit) {
        const comparisonRateLimitError = checkToolRateLimit({
          key: `compare:max-assets:${context.ip}`,
          maxRequests: context.policy.maxComparisonRateLimitMaxRequests,
          message: `Ratevert MCP allows ${context.policy.maxComparisonRateLimitMaxRequests} requests per IP every ${Math.round(context.policy.maxComparisonRateLimitWindowMs / 1000)} seconds for ${context.policy.compareAssetLimit}-asset comparisons. Try again shortly.`,
          windowMs: context.policy.maxComparisonRateLimitWindowMs,
        });

        if (comparisonRateLimitError) {
          logEvent("compare_assets_rate_limit", {
            ip: context.ip,
            requestId: context.requestId,
            targetCount: targets.length,
            totalAssets,
          });
          return comparisonRateLimitError;
        }
      }

      try {
        const payload = await compareRatevertAssets({ source, targets });
        const output = buildComparisonOutput(payload);
        const summary = payload.comparisons
          .map((entry) => `1 ${payload.source.code} = ${formatRate(entry.rate)} ${entry.asset.code}`)
          .join("\n");

        logEvent("compare_assets", {
          ip: context.ip,
          requestId: context.requestId,
          source: payload.source.code,
          sourceUrl: output.sourceUrl,
          targetCount: targets.length,
        });

        return {
          content: [{ type: "text", text: `${summary}\nSource: ${output.sourceUrl}` }],
          structuredContent: output,
        };
      } catch (error) {
        if (error instanceof RatevertApiError && error.code === "comparison_limit_exceeded") {
          const output = buildLimitHandoffOutput({ source, targets });

          logEvent("compare_assets_limit", {
            ip: context.ip,
            requestId: context.requestId,
            targetCount: targets.length,
            totalAssets: output.totalAssets,
          });

          return {
            content: [{ type: "text", text: `${output.message}\nSource: ${output.sourceUrl}` }],
            structuredContent: output,
          };
        }

        return buildToolError(error, `Failed to compare more than ${context.policy.compareAssetLimit} free assets.`);
      }
    },
  );

  return server;
}

function originGuard(request, response, next) {
  const origin = request.get("origin");

  if (!origin || ALLOWED_ORIGINS.has(origin)) {
    next();
    return;
  }

  response.status(403).json({
    error: {
      code: "origin_not_allowed",
      message: "This Origin is not allowed to call the Ratevert MCP endpoint.",
    },
  });
}

function requireJsonRequest(request, response, next) {
  if (request.is("application/json")) {
    next();
    return;
  }

  response.status(415).json({
    error: {
      code: "unsupported_media_type",
      message: "Ratevert MCP expects an application/json request body.",
    },
  });
}

export function createMcpApplication({ trustProxy = TRUST_PROXY } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy === "false" ? false : trustProxy);
  app.get("/", (_request, response) => {
    const policy = getRequestPolicy();

    response.json({
      docsUrl: PUBLIC_DOCS_URL,
      endpoint: PUBLIC_MCP_URL,
      freeAssetLimit: FREE_ASSET_LIMIT,
      name: "Ratevert",
      plan: "free",
      privacyPolicyUrl: PUBLIC_PRIVACY_URL,
      rateLimits: {
        global: { maxRequests: policy.maxRequests, windowMs: policy.rateLimitWindowMs },
        maxAssetComparisons: {
          assetCount: policy.compareAssetLimit,
          maxRequests: policy.maxComparisonRateLimitMaxRequests,
          windowMs: policy.maxComparisonRateLimitWindowMs,
        },
        pairs: {
          maxRequests: policy.pairRateLimitMaxRequests,
          windowMs: policy.pairRateLimitWindowMs,
        },
      },
      supportEmail: SUPPORT_EMAIL,
      tools: ["search_assets", "get_rate", "convert_amount", "compare_assets"],
      version: "0.3.0",
      websiteUrl: PUBLIC_SITE_URL,
    });
  });

  app.get("/healthz", (_request, response) => {
    response.json({ endpoint: PUBLIC_MCP_URL, ok: true, version: "0.3.0" });
  });

  app.post("/mcp", originGuard, requireJsonRequest, express.json({ limit: REQUEST_BODY_LIMIT }), async (request, response) => {
    const context = applyRateLimit(request, response);

    if (!context) {
      return;
    }

    response.setHeader("Cache-Control", "no-store");
    const server = createServer(context);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });

    response.on("close", () => {
      void transport.close();
      void server.close?.();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP transport error", error);

      if (!response.headersSent) {
        response.status(500).json({
          error: {
            code: "internal_error",
            message: "Internal MCP server error.",
          },
        });
      }
    }
  });

  app.all("/mcp", (_request, response) => {
    response.status(405).json({
      error: {
        code: "method_not_allowed",
        message: "Use POST when connecting to the MCP endpoint.",
      },
    });
  });

  app.use((error, _request, response, next) => {
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({
        error: {
          code: "invalid_json",
          message: "Ratevert MCP received invalid JSON.",
        },
      });
      return;
    }

    next(error);
  });

  return app;
}

export function startMcpServer() {
  const app = createMcpApplication();

  return app.listen(PORT, "127.0.0.1", () => {
    console.log(
      JSON.stringify({
        docsUrl: PUBLIC_DOCS_URL,
        endpoint: PUBLIC_MCP_URL,
        freeAssetLimit: FREE_ASSET_LIMIT,
        port: PORT,
        rateLimitMaxRequests: RATE_LIMIT_MAX_REQUESTS,
        rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
        status: "listening",
        supportEmail: SUPPORT_EMAIL,
        version: "0.3.0",
      }),
    );
  });
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
// PM2 loads ESM through its fork wrapper, so `process.argv[1]` points to the
// wrapper rather than this file. Its per-process id is the explicit runtime
// signal that this module should own the listener.
const runningUnderPm2 = Boolean(process.env.pm_id);

if (invokedAsScript || runningUnderPm2) {
  startMcpServer();
}
