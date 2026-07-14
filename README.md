# Ratevert MCP

Ratevert MCP is a public, read-only [Model Context Protocol](https://modelcontextprotocol.io/)
server for searching and converting currencies, stocks, crypto, ETFs, and
funds. It is designed for AI agents that need a canonical asset identity, an
exact current conversion, source freshness when available, and a Ratevert URL
to cite.

The hosted endpoint is:

```text
https://ratevert.com/api/mcp
```

It requires no API key. Public usage is rate-limited and a comparison request
may include up to four total assets (one source plus three targets).

## Tools

| Tool | What it does |
| --- | --- |
| `search_assets` | Finds a canonical Ratevert currency, stock, ETF, fund, or crypto asset. |
| `get_rate` | Returns the current one-unit rate for two assets with a canonical pair URL. |
| `convert_amount` | Converts one stated amount and returns the exact rate, rounded display value, freshness, and source URL. |
| `compare_assets` | Compares one source asset with up to three target assets in one request. |

## Connect an agent

Use the same remote Streamable HTTP endpoint in any MCP-compatible client.

### Claude Code

```bash
claude mcp add --transport http ratevert https://ratevert.com/api/mcp
```

### ChatGPT, Codex, OpenClaw, and Hermes

Add a remote HTTP MCP server in the client configuration, name it `Ratevert`,
and set the URL to `https://ratevert.com/api/mcp`. ChatGPT availability depends
on the account and Developer Mode features provided by OpenAI; Ratevert is not
published as a ChatGPT store plugin.

Human documentation and connection guidance: [ratevert.com/mcp](https://ratevert.com/mcp).

## Run locally

Requirements:

- Node.js 20 or newer
- npm 10 or newer

```bash
npm ci
cp .env.example .env
npm start
```

The server binds to `127.0.0.1:3010` by default, exposing
`http://127.0.0.1:3010/mcp`. It calls `RATEVERT_MCP_API_BASE_URL` for public
Ratevert API data. When you host it behind a reverse proxy, keep
`RATEVERT_MCP_TRUST_PROXY` limited to that known proxy and overwrite incoming
forwarding headers at the proxy boundary.

## Validate

```bash
npm test
npm run verify:release
npm pack --dry-run
```

For a deployed endpoint:

```bash
RATEVERT_MCP_TEST_URL=https://ratevert.com/api/mcp npm run smoke
```

Do not enable the optional rate-limit loop in production without using a
separate test address: it intentionally sends repeated requests.

## Data and limitations

Ratevert MCP is informational and read-only. Market data may be delayed or
unavailable. Results include a retrieval timestamp and source freshness when
the upstream asset data exposes it. The service is not investment, trading,
tax, or payment advice.

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting guidance.
