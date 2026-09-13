# Report-only CSP

Date: 2023-07-14 (Superseded: 2024)

Status: superseded by enforced CSP

## Context

The original Epic Stack used a report-only
[Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
during initial setup.

In Menuza, production applications (`apps/web`, `apps/sites`, `apps/app`, and
`apps/admin`) enforce strict Content Security Policy headers by default to
guarantee tenant isolation and defense-in-depth against cross-site scripting
(XSS) and injection attacks.

## Decision

Supersede report-only CSP in favor of enforced blocking CSP with tailored
directives per application surface (`apps/sites/src/middleware.ts`,
`apps/web/src/middleware.ts`).

## Consequences

- Direct blocking of untrusted scripts, objects, and connect sources.
- Safe-by-default security posture across all public and authenticated operator
  surfaces.
