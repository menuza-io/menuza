---
name: Organization sites
description: Published-branding guidance for customer-facing sites and commerce
---

# Design System: Organization Sites

## Overview

**Creative North Star: "The organization's front door"**

The storefront belongs visually to the organization whose site is published.
Preserve the root guide's accessibility and interaction rules, but resolve
appearance from the organization's published theme and content. The site can
show editorial pages, a shop, and a customer account without becoming several
disconnected products.

## Colors

`src/layouts/SiteLayout.astro` supplies the organization's theme and
`src/styles/tailwind.css` bridges its semantic roles to components. Use those
roles for surfaces, text, actions, feedback, and focus. Respect the
organization's light, dark, or system choice.

## Typography

Use the published heading and body roles where supplied. Keep product
information, prices, form labels, and longer localized text readable when
uploaded or fallback fonts have different metrics.

## Layout

`src/components/SitePage.astro` places announcements, header, published blocks,
and footer in reading order. Blocks must compose in arbitrary published
sequences. On shop screens, keep product details, totals, and checkout
progression understandable on small screens. Mirror layout for right-to-left
locales.

## Shapes

Buttons, cards, and fields inherit the organization's shape settings. Keep
related controls consistent rather than copying the operator app's silhouette.

## Components

Use the block renderer for published content; keep account and shop states
distinct from marketing blocks. Phone verification and customer profile
interactions call the regional API directly from the browser. Show purchase
progress and failure states in words as well as appearance. Preview should
reflect the latest published-theme draft without changing the live site.

## Do's and Don'ts

### Do:

- **Do** test each new block with different organization themes and translated
  content.
- **Do** keep checkout and authentication usable when a request fails.

### Don't:

- **Don't** introduce a universal storefront brand over the organization's
  published identity.
- **Don't** move customer tokens or PII into server-rendered pages or site
  cookies.
