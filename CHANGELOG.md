# Changelog

## 0.3.0 - 2026-07-14

- Added `convert_amount` for exact single-value conversions.
- Added canonical source URLs, retrieval timestamps, and source freshness to
  rate and comparison results when upstream data provides it.
- Retired the ChatGPT widget/resource layer in favor of standard, read-only
  Streamable HTTP MCP.
- Added Origin, method, body-size, trusted-proxy, and deterministic rate-limit
  hardening.
- Added mocked protocol contract coverage for all public tools and error paths.
