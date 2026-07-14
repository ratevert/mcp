import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test, { after, before } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const UPDATED_AT = "2026-07-14T09:00:00.000Z";
const NUMERIC_UPDATED_AT = 1784058929;
const NUMERIC_UPDATED_AT_ISO = new Date(NUMERIC_UPDATED_AT * 1000).toISOString();
let appServer;
let endpoint;
let upstreamServer;

function asset(code, market = "fiat") {
  return {
    code,
    id: `${market}:${code.toLowerCase()}`,
    logoUrl: null,
    market,
    marketCap: null,
    name: code === "USD" ? "US Dollar" : code === "BTC" ? "Bitcoin" : "Euro",
    slug: code.toLowerCase(),
    subtitle: null,
    updatedAt: code === "BTC" ? NUMERIC_UPDATED_AT : UPDATED_AT,
    usdPrice: code === "BTC" ? 100000 : code === "EUR" ? 1.25 : 1,
  };
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server) {
  return new Promise((resolve) => {
    const listener = server.listen(0, "127.0.0.1", () => {
      resolve({
        port: listener.address().port,
        server: listener,
      });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createFakeRatevertApi() {
  return createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    if (url.pathname === "/api/search") {
      const market = url.searchParams.get("market") ?? "all";
      const query = url.searchParams.get("q") ?? "";
      const result = asset(query.toUpperCase() === "BTC" ? "BTC" : "EUR", market === "all" ? "crypto" : market);
      writeJson(response, 200, {
        page: 1,
        pageSize: 10,
        results: [{ ...result, defaultHref: `/${result.slug}/usd` }],
        total: 1,
        totalPages: 1,
      });
      return;
    }

    if (url.pathname === "/api/rate") {
      const baseCode = (url.searchParams.get("base") ?? "").toUpperCase();
      const quoteCode = (url.searchParams.get("quote") ?? "").toUpperCase();

      if (baseCode === "UNKNOWN" || quoteCode === "UNKNOWN") {
        writeJson(response, 404, {
          error: { code: "unknown_asset", message: "Unknown asset." },
        });
        return;
      }

      const base = asset(baseCode || "USD", baseCode === "BTC" ? "crypto" : "fiat");
      const quote = asset(quoteCode || "EUR", quoteCode === "BTC" ? "crypto" : "fiat");
      const rate = base.code === "USD" && quote.code === "EUR" ? 1.25 : base.code === "USD" && quote.code === "BTC" ? 0.00001 : 0.8;

      writeJson(response, 200, {
        base,
        canonicalPath: `/${base.slug}/${quote.slug}`,
        canonicalUrl: `https://ratevert.test/${base.slug}/${quote.slug}`,
        normalized: false,
        quote,
        rate,
        sourceSite: "ratevert.test",
        sourceUrl: `https://ratevert.test/${base.slug}/${quote.slug}`,
      });
      return;
    }

    if (url.pathname === "/api/compare") {
      const sourceCode = (url.searchParams.get("source") ?? "USD").toUpperCase();
      const targetCodes = url.searchParams.getAll("target").map((code) => code.toUpperCase());

      if (targetCodes.length > 3) {
        writeJson(response, 400, {
          error: {
            code: "comparison_limit_exceeded",
            message: "Too many assets.",
          },
        });
        return;
      }

      const source = asset(sourceCode);
      writeJson(response, 200, {
        comparisons: targetCodes.map((code, index) => ({
          asset: asset(code, code === "BTC" ? "crypto" : "fiat"),
          canonicalPath: `/${source.slug}/${code.toLowerCase()}`,
          canonicalUrl: `https://ratevert.test/${source.slug}/${code.toLowerCase()}`,
          normalized: false,
          rate: index + 1.25,
        })),
        limit: 4,
        source,
        sourceSite: "ratevert.test",
        sourceUrl: `https://ratevert.test/${source.slug}/compare`,
        totalAssets: 1 + targetCodes.length,
      });
      return;
    }

    writeJson(response, 404, { error: { code: "not_found", message: "Not found." } });
  });
}

async function withClient(callback) {
  const client = new Client({ name: "ratevert-mcp-contract-test", version: "0.3.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`));

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await transport.close();
    await client.close?.();
  }
}

before(async () => {
  upstreamServer = createFakeRatevertApi();
  const { port: upstreamPort } = await listen(upstreamServer);
  process.env.RATEVERT_MCP_API_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
  process.env.RATEVERT_MCP_ALLOWED_ORIGINS = "https://ratevert.test";
  process.env.RATEVERT_MCP_PAIR_RATE_LIMIT_MAX_REQUESTS = "2";
  process.env.RATEVERT_MCP_PAIR_RATE_LIMIT_WINDOW_MS = "300000";

  const { createMcpApplication, getClientIp } = await import(`./server.mjs?contract-test=${Date.now()}`);
  assert.equal(
    getClientIp({
      get: () => "198.51.100.99",
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
    }),
    "127.0.0.1",
    "Forwarded client-IP headers must not override Express trust-proxy resolution.",
  );
  const app = createMcpApplication({ trustProxy: false });
  const { port: appPort, server } = await listen(app);
  appServer = server;
  endpoint = `http://127.0.0.1:${appPort}`;
});

after(async () => {
  await Promise.all([close(appServer), close(upstreamServer)]);
});

test("lists the four read-only tools without ChatGPT widget resources", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, ["compare_assets", "convert_amount", "get_rate", "search_assets"]);
    assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
  });

  const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("registerResource("), false, "No widget resource may remain registered.");
  assert.equal(source.includes("openai/outputTemplate"), false, "No ChatGPT widget metadata may remain.");
});

test("returns canonical source and freshness metadata for rate, comparison, and conversion", async () => {
  await withClient(async (client) => {
    const rate = await client.callTool({
      name: "get_rate",
      arguments: { base: "usd", quote: "eur" },
    });
    const conversion = await client.callTool({
      name: "convert_amount",
      arguments: { amount: 20, from: "usd", to: "eur" },
    });
    const comparison = await client.callTool({
      name: "compare_assets",
      arguments: { source: "usd", targets: ["eur", "btc"] },
    });

    assert.equal(rate.isError ?? false, false);
    assert.equal(rate.structuredContent.view, "rate");
    assert.equal(rate.structuredContent.as_of, UPDATED_AT);
    assert.ok(rate.structuredContent.retrieved_at);
    assert.equal(rate.structuredContent.sourceUrl, "https://ratevert.test/usd/eur");

    assert.equal(conversion.isError ?? false, false);
    assert.equal(conversion.structuredContent.view, "conversion");
    assert.equal(conversion.structuredContent.convertedAmount, 25);
    assert.equal(conversion.structuredContent.convertedDisplay, "25");
    assert.equal(conversion.structuredContent.as_of, UPDATED_AT);

    assert.equal(comparison.isError ?? false, false);
    assert.equal(comparison.structuredContent.view, "comparison");
    assert.equal(comparison.structuredContent.as_of, UPDATED_AT);
    assert.equal(comparison.structuredContent.totalAssets, 3);

    const numericFeedRate = await client.callTool({
      name: "get_rate",
      arguments: { base: "btc", quote: "btc" },
    });
    assert.equal(numericFeedRate.isError ?? false, false);
    assert.equal(numericFeedRate.structuredContent.as_of, NUMERIC_UPDATED_AT_ISO);
  });
});

test("returns safe MCP errors for invalid assets and comparison-limit handoff", async () => {
  await withClient(async (client) => {
    const unknown = await client.callTool({
      name: "get_rate",
      arguments: { base: "unknown", quote: "usd" },
    });
    const handoff = await client.callTool({
      name: "compare_assets",
      arguments: { source: "usd", targets: ["eur", "btc", "jpy", "gbp"] },
    });

    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent.error.code, "unknown_asset");
    assert.equal(handoff.isError ?? false, false);
    assert.equal(handoff.structuredContent.view, "limit");
    assert.equal(handoff.structuredContent.totalAssets, 5);
  });
});

test("enforces deterministic per-pair limits without trusting forwarded headers", async () => {
  await withClient(async (client) => {
    const limited = await client.callTool({
      name: "get_rate",
      arguments: { base: "usd", quote: "eur" },
    });

    assert.equal(limited.isError, true);
    assert.equal(limited.structuredContent.error.code, "rate_limit_exceeded");
    assert.equal(limited.structuredContent.error.status, 429);
  });
});

test("rejects untrusted origins, malformed JSON, and non-JSON requests", async () => {
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "contract-test", version: "0.3.0" },
    },
  });
  const forbiddenOrigin = await fetch(`${endpoint}/mcp`, {
    body: initialize,
    headers: { "content-type": "application/json", origin: "https://untrusted.example" },
    method: "POST",
  });
  const malformed = await fetch(`${endpoint}/mcp`, {
    body: "{not-json",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const unsupported = await fetch(`${endpoint}/mcp`, {
    body: "not-json",
    headers: { "content-type": "text/plain" },
    method: "POST",
  });
  const invalidMethod = await fetch(`${endpoint}/mcp`);

  assert.equal(forbiddenOrigin.status, 403);
  assert.equal((await forbiddenOrigin.json()).error.code, "origin_not_allowed");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_json");
  assert.equal(unsupported.status, 415);
  assert.equal((await unsupported.json()).error.code, "unsupported_media_type");
  assert.equal(invalidMethod.status, 405);
  assert.equal((await invalidMethod.json()).error.code, "method_not_allowed");
});
