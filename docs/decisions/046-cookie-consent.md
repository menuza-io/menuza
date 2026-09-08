# ADR 046: Cookie Consent

## Status

Accepted

## Context

App, Admin, and the marketing web site load analytics (PostHog, Google Analytics via
Partytown) and need a GDPR-style consent signal before enabling non-essential
tracking. Operators and visitors must be able to accept or decline analytics cookies
without breaking shared authentication domains.

## Decision

1. **Shared cookie helper** — `@repo/common/cookie-consent` serializes a single
   HttpOnly cookie (`hasConsented: boolean`) with one-year `maxAge`, `SameSite=Lax`,
   and a domain derived from `sharedCookieDomain()` so App/Admin/Web on the same apex
   share consent state.

2. **Server-side reads** — Layout loaders call `getCookieConsentState(request)` and
   pass the boolean to analytics components. Unset consent (`undefined`) shows the
   banner; explicit `true`/`false` hides it and gates PostHog initialization.

3. **POST endpoints** — App/Admin expose `/resources/cookie-consent`; marketing web
   exposes `/api/cookie-consent`. Actions verify same-origin (`Origin` or `Referer`)
   before setting the cookie. SameSite=Lax remains the primary CSRF defense.

4. **No client-readable flag** — Consent is HttpOnly; the UI reads loader data, not
   `document.cookie`.

## Consequences

- Consent is consistent across subdomains on the operator/marketing apex.
- Analytics scripts must check loader-provided consent before loading.
- Cross-site POST forgery is mitigated by Lax cookies plus origin checks.
- Future CMP integrations should extend `cookie-consent.server.ts` rather than
  duplicating cookie names per app.

## References

- `packages/common/src/cookie-consent.server.ts`
- `apps/app/app/components/privacy-banner.tsx`
- `apps/web/src/components/CookieConsentBanner.astro`
