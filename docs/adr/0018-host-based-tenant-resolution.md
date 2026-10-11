# ADR-0018: The school comes from the verified host, never from client input

- **Status:** Accepted (client direction, 2026-10-11; design approved as D1–D6)
- **Date:** 2026-10-11
- **Blueprint reference:** `docs/blueprint/04-target-architecture.md` §6, §17.2–17.3; `docs/design/m2-tenancy-kernel.md` §3.6

## Context

If any request field could choose the school, every endpoint would need to defend against it. A host is chosen by the browser and is bound to cookies, so it is the natural, unforgeable-in-practice selector.

## Decision

- **API.** Every route under `/api/v1` is school-scoped. An `onRequest` hook normalises the request host (lower-case; port and trailing dot removed; IP literals and malformed values rejected) and resolves it through `resolve_tenant()` (60-second in-process cache keyed by host). Unknown, unverified or deleted hosts get a generic `TENANT_NOT_FOUND` that names no school. School ids in headers, query strings or bodies are ignored.
- **Proxies.** Fastify honours `X-Forwarded-Host` only from `TRUSTED_PROXIES` (default: loopback). In production that list holds the reverse proxy and web server addresses.
- **Web (Next.js 16).**
  - `src/proxy.ts` runs once per request on the original path. It refuses direct requests to the internal `/_tenant` route, refuses malformed hosts, and overwrites `X-Forwarded-Host` with the real host.
  - `next.config.ts` `beforeFiles` rewrites then map every non-platform host to `/_tenant/<host>/…`, so rendered and cached pages are keyed by host.
  - Platform hosts (`PLATFORM_HOSTS`) serve the status page.
  - _Implementation note:_ rewriting inside the proxy does not work in Next 16. The proxy is invoked a second time for the rewritten path, with the internal Host, and can't tell its own rewrite from a direct request. Config rewrites run after the proxy without re-invoking it.
- **Domains.** Subdomains now; custom domains later on the same `tenant_domain` model (Q-TEN-5).

## Consequences

- Tests prove host normalisation, trusted-proxy behaviour, ignored client ids, per-host rendering and refusal of the internal route (T-ISO-10–13, T-ISO-19).
- Local school sites: `http://acme.localhost:3000`, `http://beta.localhost:3000` (browsers resolve `*.localhost` to loopback).
- A local reverse proxy (Caddy with HTTPS for `*.localhost`) is deferred to M4, when secure session cookies need HTTPS; nothing in M2 depends on it.
