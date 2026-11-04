# CSP Enforcement Strategy across Monorepo Applications

Date: 2026-07-28

Status: accepted

## Context

The Menuza monorepo contains two primary React Router web applications:

- `apps/app`: Main end-user application.
- `apps/admin`: Enterprise administrative dashboard.

`apps/app` and `apps/admin` both send an enforcing `Content-Security-Policy`.

## Rationale

1. `apps/app` serves production end users with strict boundaries and enforcable
   origins, making active CSP blocking (`reportOnly: false`) critical for XSS
   mitigation and security posture.
2. `apps/admin` hosts dynamic administrative widgets that vary across staging
   and tenant setups. It sends an enforcing `Content-Security-Policy`, so
   browsers block violations.

## Verification

Both applications set explicit security response headers
(`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Strict-Transport-Security`).
