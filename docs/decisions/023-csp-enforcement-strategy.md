# CSP Enforcement Strategy across Monorepo Applications

Date: 2026-07-28

Status: accepted

## Context

The Menuza monorepo contains two primary React Router web applications:

- `apps/app`: Main end-user application.
- `apps/admin`: Enterprise administrative dashboard.

While `apps/app` enforces Content Security Policy (`reportOnly: false`),
`apps/admin` uses `reportOnly: true`.

## Rationale

1. `apps/app` serves production end users with strict boundaries and enforcable
   origins, making active CSP blocking (`reportOnly: false`) critical for XSS
   mitigation and security posture.
2. `apps/admin` embeds external preview frames (e.g. Builder.io, Novu workflows)
   and dynamic administrative widgets that vary across staging and tenant
   setups. Operating in `reportOnly: true` prevents admin dashboard breakage
   during integration configuration while capturing violation logs for auditing.

## Verification

Both applications set explicit security response headers
(`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Strict-Transport-Security`).
