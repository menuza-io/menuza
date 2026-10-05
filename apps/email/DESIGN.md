---
name: Transactional email
description: Brand-adaptable guidance for email templates and previews
---

# Design System: Transactional Email

## Overview

**Creative North Star: "The message first"**

Email recipients need to recognize the sender, understand the event, and
complete one action. `apps/email` previews templates from `packages/email`; the
shared package owns their layout and elements. Follow the root `DESIGN.md` for
accessibility, but respect email-client limitations.

## Colors

`packages/email/src/theme.ts` mirrors the operator app's semantic theme roles
with email-safe values. When a downstream project's app theme changes, update
that mirror as well; this guide does not define its values. Preserve readable
text, link, and action states in clients with differing appearance settings.

## Typography

Lead with the event or required action, then brief explanation and supporting
detail. Keep preview text, headings, code, links, and footer distinct. Use
email-safe fallback typefaces.

## Layout

Use the existing `EmailLayout` header, content cards, and footer so clients
retain a stable reading order. On narrow mail views, content remains
single-column and links remain usable without hover.

## Components

Reuse shared layout, card, button, code, heading, note, paragraph, quote,
details, and steps elements. Critical actions need a visible button and, when
applicable, a fallback URL. Use a client-compatible raster logo and strings from
the brand config rather than embedded template identity.

## Do's and Don'ts

### Do:

- **Do** preview and render-test each template, including missing or long
  dynamic content.
- **Do** keep transactional hierarchy clear when images do not load.

### Don't:

- **Don't** assume browser CSS variables, advanced color formats, SVG logos, or
  JavaScript work in email clients.
