# Security Audit Baseline

## Current Controls
- Session token verification on protected routes.
- Canonical field writes constrained by explicit IDs.
- Structured server-side flows for booking/block actions.

## Implemented Hardening
- Security headers on key API endpoints.
- Basic rate limiting for anti-abuse.
- Request ID propagation for auditability.
- Retry policy limits unsafe POST retries by default.

## Required Next Controls
- Schema validation for all mutable API payloads.
- Strong authz boundaries for admin-only actions.
- Secrets scanning and dependency vulnerability scanning in CI.
- CSP and stricter CORS policy review per endpoint.

## Audit Log Minimum Fields
- `request_id`
- `route`
- `action`
- `actor` (if authenticated)
- `contact_id`/`resource_id`
- `outcome`
- `latency_ms`
