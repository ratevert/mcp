import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.RATEVERT_MCP_TEST_URL ?? "http://127.0.0.1:3010/mcp");
const shouldTestRateLimits = process.env.RATEVERT_MCP_TEST_RATE_LIMITS === "1";
const expectedMaxComparisonRequests = Number.parseInt(
  process.env.RATEVERT_MCP_MAX_COMPARISON_RATE_LIMIT_MAX_REQUESTS ?? "10",
  10,
);
const expectedPairRequests = Number.parseInt(
  process.env.RATEVERT_MCP_PAIR_RATE_LIMIT_MAX_REQUESTS ?? "20",
  10,
);
const client = new Client({
  name: "ratevert-mcp-smoke-test",
  version: "0.3.0",
});
const transport = new StreamableHTTPClientTransport(endpoint);

function getTool(name, tools) {
  const tool = tools.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected ${name} tool to be registered.`);
  return tool;
}

function assertToolResult(result, view) {
  assert.equal(result.isError ?? false, false, `${view} should not return an MCP error.`);
  assert.equal(result.structuredContent?.view, view);
  assert.ok(result.structuredContent?.sourceUrl, `${view} should include a source URL.`);
}

function assertSearchResult(result, market) {
  assertToolResult(result, "search");
  assert.equal(result.structuredContent.market, market);
  assert.ok(result.structuredContent.total >= 1, `${market} search should return at least one result.`);

  if (market !== "all") {
    assert.equal(result.structuredContent.results[0]?.market, market);
  }
}

function assertRateLimitResult(result, name) {
  assert.equal(result.isError, true, `${name} should return an MCP rate-limit error.`);
  assert.equal(result.structuredContent?.error?.code, "rate_limit_exceeded");
  assert.equal(result.structuredContent?.error?.status, 429);
  assert.ok(result.structuredContent?.error?.details?.retryAfterSeconds >= 1);
}

function assertToolResultOrRateLimit(result, view, name) {
  if (result.isError) {
    assertRateLimitResult(result, name);
    return false;
  }

  assertToolResult(result, view);
  return true;
}

async function callUntilRateLimited({ call, maxAllowedRequests, name, view }) {
  let rateLimitResult = null;
  let successfulBeforeLimit = 0;

  for (let index = 0; index <= maxAllowedRequests; index += 1) {
    const result = await call();

    if (result.isError) {
      assertRateLimitResult(result, name);
      rateLimitResult = result;
      break;
    }

    assertToolResult(result, view);
    successfulBeforeLimit += 1;
  }

  assert.ok(rateLimitResult, `${name} should rate-limit within ${maxAllowedRequests + 1} calls.`);

  return {
    result: rateLimitResult,
    successfulBeforeLimit,
  };
}

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const search = await client.callTool({
    name: "search_assets",
    arguments: {
      query: "btc",
    },
  });
  const etfSearch = await client.callTool({
    name: "search_assets",
    arguments: {
      query: "spy",
      market: "etfs",
    },
  });
  const fundSearch = await client.callTool({
    name: "search_assets",
    arguments: {
      query: "vfiax",
      market: "funds",
    },
  });
  const rate = await client.callTool({
    name: "get_rate",
    arguments: {
      base: "nvda",
      quote: "eur",
    },
  });
  const conversion = await client.callTool({
    name: "convert_amount",
    arguments: {
      amount: 5000,
      from: "usd",
      to: "btc",
    },
  });
  const comparison = await client.callTool({
    name: "compare_assets",
    arguments: {
      source: "btc",
      targets: ["usd", "eur", "nvda"],
    },
  });
  const limitHandoff = await client.callTool({
    name: "compare_assets",
    arguments: {
      source: "btc",
      targets: ["usd", "eur", "jpy", "nvda"],
    },
  });

  const searchTool = getTool("search_assets", tools);
  getTool("get_rate", tools);
  getTool("convert_amount", tools);
  getTool("compare_assets", tools);
  assert.ok(searchTool.inputSchema?.properties?.market?.enum?.includes("etfs"), "search_assets should accept etfs.");
  assert.ok(searchTool.inputSchema?.properties?.market?.enum?.includes("funds"), "search_assets should accept funds.");
  assert.equal(searchTool.inputSchema?.properties?.market?.enum?.includes("commodities"), false, "search_assets should not advertise commodities.");
  assertSearchResult(search, "all");
  assertSearchResult(etfSearch, "etfs");
  assertSearchResult(fundSearch, "funds");
  if (shouldTestRateLimits) {
    assertToolResultOrRateLimit(rate, "rate", "preflight pair rate limit");
  } else {
    assertToolResult(rate, "rate");
  }

  const comparisonPassed = shouldTestRateLimits
    ? assertToolResultOrRateLimit(comparison, "comparison", "preflight comparison rate limit")
    : (assertToolResult(comparison, "comparison"), true);

  if (comparisonPassed) {
    assert.equal(comparison.structuredContent.totalAssets, 4);
  }
  assertToolResult(conversion, "conversion");
  assert.equal(conversion.structuredContent.amount, 5000);
  assert.ok(Number.isFinite(conversion.structuredContent.convertedAmount));
  assert.ok(conversion.structuredContent.retrieved_at);
  assert.equal(limitHandoff.structuredContent?.view, "limit");
  assert.equal(limitHandoff.structuredContent.totalAssets, 5);
  assert.equal(limitHandoff.structuredContent.freeAssetLimit, 4);

  let pairRateLimit = null;
  let comparisonRateLimit = null;
  let pairRateLimitSuccessfulBeforeLimit = null;
  let comparisonRateLimitSuccessfulBeforeLimit = null;

  if (shouldTestRateLimits) {
    const pairLimitCheck = await callUntilRateLimited({
      call: () =>
        client.callTool({
          name: "get_rate",
          arguments: {
            base: "aapl",
            quote: "cad",
          },
        }),
      maxAllowedRequests: expectedPairRequests,
      name: "pair rate limit",
      view: "rate",
    });
    pairRateLimit = pairLimitCheck.result;
    pairRateLimitSuccessfulBeforeLimit = pairLimitCheck.successfulBeforeLimit;

    const comparisonLimitCheck = await callUntilRateLimited({
      call: () =>
        client.callTool({
          name: "compare_assets",
          arguments: {
            source: "eth",
            targets: ["usd", "eur", "nvda"],
          },
        }),
      maxAllowedRequests: expectedMaxComparisonRequests,
      name: "comparison rate limit",
      view: "comparison",
    });
    comparisonRateLimit = comparisonLimitCheck.result;
    comparisonRateLimitSuccessfulBeforeLimit = comparisonLimitCheck.successfulBeforeLimit;
  }

  console.log(
    JSON.stringify(
      {
        comparison,
        comparisonRateLimit,
        comparisonRateLimitSuccessfulBeforeLimit,
        conversion,
        endpoint: endpoint.href,
        etfSearch,
        fundSearch,
        limitHandoff,
        pairRateLimit,
        pairRateLimitSuccessfulBeforeLimit,
        rate,
        search,
        tools: tools.tools.map((tool) => ({
          name: tool.name,
          readOnlyHint: tool.annotations?.readOnlyHint ?? null,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await transport.close();
  await client.close?.();
}
