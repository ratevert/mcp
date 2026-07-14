# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability.
Email `info@ratevert.com` with a clear reproduction, affected version, impact,
and any suggested mitigation. We will acknowledge reports within five business
days and coordinate a fix before public disclosure when appropriate.

## Scope

This repository contains the public, read-only Ratevert MCP server. Its most
important boundaries are request validation, trusted-proxy configuration, rate
limits, upstream API handling, and safe output construction. Hosted Ratevert
infrastructure, user accounts, billing, and private application code are not
part of this source repository.
