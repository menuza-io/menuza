# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds browser-extension truth.

## Platform

web

## Users

Operators of the main app who install it in their browser, and developers
extending the scaffold. It is a starter/demo companion, more scaffold than
product feature.

## Product Purpose

Shows the user's operator-app login status and can inject a small status widget
onto sites the user explicitly allows, per host.

## Positioning

Permission-first: the content script runs only on hosts the user explicitly
allows (per-host flags in extension storage), never by default.

## Operating Context

Manifest V3 via Vite for both Chrome and Firefox (per-browser build targets). A
background worker polls the operator session cookie on the brand domain every 30
seconds and broadcasts auth changes; the widget renders in a shadow DOM card
using the shared UI components.

## Capabilities and Constraints

Popup (active host, login status, reload, link into the app's login), per-host
allow and disable, auto-reinjection on allowed tabs.

Constraints: it reads the operator session cookie only and stores no credentials
or PII; externally-connectable is limited to the product domain. Open item:
strings are English-only with no localization yet.
