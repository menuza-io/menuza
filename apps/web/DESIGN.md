---
name: Marketing site
description: Content-led guidance for the public product website
---

# Design System: Marketing Site

## Overview

**Creative North Star: "Show the work"**

This Astro site persuades through real product content, editorial rhythm, and a
clear route to signup. Its pages are assembled from CMS blocks, so the design
must survive different copy, images, and block sequences. Follow the root
`DESIGN.md` without importing operator-dashboard density into public pages.

## Colors

Use the semantic brand, surface, text, border, and action roles defined in
`src/styles/tailwind.css`. The active deployment chooses their values. Verify
text, links, and calls to action in both available themes.

## Typography

Create a readable progression from hero statement through section heading,
explanation, evidence, and action. Preserve comfortable line lengths and account
for translated and CMS-authored copy without truncation.

## Layout

Compose pages from `src/components/site` sections and the existing hero and
marketing-block library. Let imagery and evidence have room; adapt section
rhythm and navigation to narrow screens rather than shrinking desktop
composition. Support the site's right-to-left locales.

## Elevation & Depth

Use section seams, frames, surface changes, and restrained reveal effects to
establish rhythm. Motion is supplementary and must yield to reduced-motion
preferences.

## Components

Prefer existing CMS-backed blocks, header/footer navigation, forms, FAQ,
pricing, and CTA components. A new block must work when content is short, long,
missing, or reordered by an editor. Consent UI must remain clear before
analytics loads.

## Do's and Don'ts

### Do:

- **Do** use published CMS content and the shared brand config for claims and
  identity.
- **Do** make each block coherent on its own and in a sequence.

### Don't:

- **Don't** freeze example copy, brand treatments, or fixed theme values into
  the system.
- **Don't** invent testimonials, performance claims, or customer logos.
