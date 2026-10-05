# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds storefront truth.

## Platform

web

## Users

End customers of each organization: they browse the published site, buy from the
shop, sign in with phone-number OTP, and manage their profile and order history.
First-time visitors read the organization's marketing pages. Organization
editors use `?preview=true` for live preview from the operator app's website
editor.

## Product Purpose

The customer-facing storefront, served per organization on its subdomain (and
custom domains). It renders the organization's published website and its
shop, plus a phone-OTP customer account.

## Positioning

Published content and customer data take different paths on purpose. Pages are
edge-cached published HTML, while every customer-authenticated call goes from
the browser directly to the organization's regional API; this app's servers
never see customer PII, and it must stay that way (no server-side auth BFF, no
customer session cookies).

## Operating Context

- Astro SSR on Cloudflare Workers (KV and assets); port 3008 behind the local
  HTTPS proxy with organization subdomains (`npm run dev:sites`).
- The host resolves the organization (subdomain or custom domain); published
  pages are fetched from the operator app and edge-cached in production (short
  TTL with stale-while-revalidate).
- The regional API URL for the organization's data region is injected into the
  page; browser-side auth, forms, profile, and order calls use it directly.
  Cloudflare Turnstile protects public form blocks when configured.

## Capabilities and Constraints

- Published CMS pages from typed blocks (header, footer, hero, features,
  content, cards, CTA, FAQ, gallery, testimonials, video, form) with 404 logging
  and redirect hit tracking.
- Shop: single-product purchase with hosted or inline card checkout; order
  status and receipts.
- Customer account: `/login` → `/verify` → `/complete-name` (phone only, name
  collected after the first OTP), profile, order history, saved payment methods.
- Constraints: customer tokens live in localStorage, never cookies. Six locales
  with locale-prefixed URLs (default unprefixed), hreflang alternates, and full
  right-to-left support. Per-organization theming (base color, radius,
  light/dark/system, heading and body fonts, custom uploads) compiles to CSS;
  per-organization analytics pixels load with the page.

## Accessibility & Inclusion

Locale-prefixed URLs in six locales with hreflang alternates, full right-to-left
layouts, and per-organization light/dark/system theming.
