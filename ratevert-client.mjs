function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

const RATEVERT_API_BASE_URL = normalizeUrl(
  process.env.RATEVERT_MCP_API_BASE_URL ??
    process.env.RATEVERT_MCP_INTERNAL_API_BASE_URL ??
    "http://127.0.0.1:3001",
);
const PUBLIC_SITE_URL = normalizeUrl(process.env.RATEVERT_MCP_SITE_URL ?? "https://ratevert.com");
const SOURCE_SITE = new URL(PUBLIC_SITE_URL).hostname;
const PUBLIC_SITE_ORIGIN = new URL(PUBLIC_SITE_URL).origin;
const UPSTREAM_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.RATEVERT_MCP_UPSTREAM_TIMEOUT_MS ?? "5000", 10) || 5_000,
);
const MAX_UPSTREAM_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.RATEVERT_MCP_MAX_UPSTREAM_CONCURRENCY ?? "20", 10) || 20,
);
let activeUpstreamRequests = 0;
const DEFAULT_HEADERS = {
  accept: "application/json",
  "user-agent": "ratevert-mcp/0.3.1",
};

export class RatevertApiError extends Error {
  constructor(message, { code = "ratevert_api_error", details = null, status = 500 } = {}) {
    super(message);
    this.name = "RatevertApiError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

function buildAbsoluteUrl(path) {
  if (!path) {
    return `${PUBLIC_SITE_URL}/`;
  }

  try {
    const candidate = new URL(path, `${PUBLIC_SITE_URL}/`);

    if (candidate.origin === PUBLIC_SITE_ORIGIN && ["http:", "https:"].includes(candidate.protocol)) {
      return candidate.href;
    }
  } catch {
    // Invalid or off-origin citations fall back to the public Ratevert site.
  }

  return `${PUBLIC_SITE_URL}/`;
}

function buildPublicPath(path) {
  try {
    const candidate = new URL(path, `${PUBLIC_SITE_URL}/`);

    if (candidate.origin === PUBLIC_SITE_ORIGIN && ["http:", "https:"].includes(candidate.protocol)) {
      return `${candidate.pathname}${candidate.search}${candidate.hash}`;
    }
  } catch {
    // Invalid or off-origin paths fall back to the Ratevert home page.
  }

  return "/";
}

function sanitizePublicOutput(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizePublicOutput);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (["canonicalUrl", "sourceUrl"].includes(key)) {
        return [key, buildAbsoluteUrl(entry)];
      }

      if (["canonicalPath", "defaultHref", "href"].includes(key)) {
        return [key, buildPublicPath(entry)];
      }

      return [key, sanitizePublicOutput(entry)];
    }),
  );
}

async function requestJson(path) {
  if (activeUpstreamRequests >= MAX_UPSTREAM_CONCURRENCY) {
    throw new RatevertApiError("Ratevert is busy. Try again shortly.", {
      code: "upstream_busy",
      status: 503,
    });
  }

  activeUpstreamRequests += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(`${RATEVERT_API_BASE_URL}${path}`, {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const error = payload?.error ?? {};

      throw new RatevertApiError(
        error.message ?? `Request failed with status ${response.status}.`,
        {
          code: error.code ?? "ratevert_api_error",
          details: error.details ?? null,
          status: response.status,
        },
      );
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new RatevertApiError("Ratevert upstream request timed out.", {
        code: "upstream_timeout",
        status: 504,
      });
    }

    throw error;
  } finally {
    clearTimeout(timer);
    activeUpstreamRequests -= 1;
  }
}

export async function searchAssets({ query, market = "all", limit = 10 }) {
  const params = new URLSearchParams({
    market,
    page: "1",
    pageSize: String(limit),
  });

  if (query.trim()) {
    params.set("q", query.trim());
  }

  const payload = await requestJson(`/api/search?${params.toString()}`);

  const safePayload = sanitizePublicOutput(payload);

  return {
    ...safePayload,
    sourceSite: SOURCE_SITE,
    results: safePayload.results.map((result) => ({
      ...result,
      canonicalUrl: buildAbsoluteUrl(result.defaultHref),
    })),
  };
}

export async function getRate({ base, quote }) {
  const params = new URLSearchParams({ base, quote });
  const payload = await requestJson(`/api/rate?${params.toString()}`);

  const safePayload = sanitizePublicOutput(payload);

  return {
    ...safePayload,
    sourceSite: SOURCE_SITE,
    sourceUrl: buildAbsoluteUrl(safePayload.sourceUrl ?? safePayload.canonicalPath ?? "/"),
  };
}

export async function compareAssets({ source, targets }) {
  const params = new URLSearchParams({ source });

  for (const target of targets) {
    params.append("target", target);
  }

  const payload = await requestJson(`/api/compare?${params.toString()}`);

  const safePayload = sanitizePublicOutput(payload);

  return {
    ...safePayload,
    sourceSite: SOURCE_SITE,
    sourceUrl: buildAbsoluteUrl(safePayload.sourceUrl ?? "/"),
  };
}
