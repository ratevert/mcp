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
const DEFAULT_HEADERS = {
  accept: "application/json",
  "user-agent": "ratevert-mcp/0.3.0",
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
    return PUBLIC_SITE_URL;
  }

  if (/^https?:\/\//.test(path)) {
    return path;
  }

  return `${PUBLIC_SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

async function requestJson(path) {
  const response = await fetch(`${RATEVERT_API_BASE_URL}${path}`, {
    headers: DEFAULT_HEADERS,
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

  return {
    ...payload,
    sourceSite: SOURCE_SITE,
    results: payload.results.map((result) => ({
      ...result,
      canonicalUrl: buildAbsoluteUrl(result.defaultHref),
    })),
  };
}

export async function getRate({ base, quote }) {
  const params = new URLSearchParams({ base, quote });
  const payload = await requestJson(`/api/rate?${params.toString()}`);

  return {
    ...payload,
    sourceSite: payload.sourceSite ?? SOURCE_SITE,
    sourceUrl: buildAbsoluteUrl(payload.sourceUrl ?? payload.canonicalPath ?? "/"),
  };
}

export async function compareAssets({ source, targets }) {
  const params = new URLSearchParams({ source });

  for (const target of targets) {
    params.append("target", target);
  }

  const payload = await requestJson(`/api/compare?${params.toString()}`);

  return {
    ...payload,
    sourceSite: payload.sourceSite ?? SOURCE_SITE,
    sourceUrl: buildAbsoluteUrl(payload.sourceUrl ?? "/"),
  };
}
