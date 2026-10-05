---
name: SaaS template
description:
  Shared, brand-independent design guidance for the template's interfaces
---

# Design System: SaaS Template

## Overview

**Creative North Star: "One system, many brands"**

This repository supplies interaction patterns and semantic roles, not a fixed
visual identity. A downstream project chooses its own theme. Keep the operator
tools, public marketing pages, organization sites, mobile apps, and emails
recognizable as parts of the same product without making them visually
identical.

Use the nearest app's `DESIGN.md` for surface-specific rules. The implemented
component or theme source is authoritative for its actual values; this document
deliberately contains none.

**Key Characteristics:**

- Task-first operator interfaces; content-first public pages.
- Shared behavior and accessibility, with independent brand expression.
- Customer-facing surfaces take their identity from each organization's
  published branding.

## Colors

**The Semantic Role Rule.** Use roles such as background, foreground, primary
action, muted content, border, focus, and destructive state. Their appearance
belongs to the consuming app's theme, not this guide. Preserve readable contrast
and visible states in light, dark, and system modes where supported. Never use
an accent alone to communicate meaning.

## Typography

Use a clear hierarchy of page title, section heading, body, label, and
supporting text. Let the active project theme supply typefaces and scale; let
published organization branding supply supported customer-facing fonts. Keep
long-form reading, dense controls, and localized text legible without relying on
a particular font's metrics.

## Layout

Use responsive composition rather than fixed screen assumptions. Operator tools
prioritize navigation, scanable data, and reversible actions; marketing pages
prioritize reading order and calls to action; storefronts prioritize published
content and purchase flows. Mirror directional layout for right-to-left locales
without reversing numbers, codes, or media indiscriminately.

## Elevation & Depth

Separate page, card, overlay, and selected states with the existing surface
roles, boundaries, and elevation conventions of each app. Depth should explain
interaction or grouping, not decorate every container.

## Shapes

Use the active app's shape scale consistently across controls and containers.
Organization-branded surfaces derive shape from the published theme. Do not copy
a sample project's corner treatment into another deployment.

## Components

Web operator interfaces use the primitives and variants in `packages/ui`;
callers should not restyle their internals. The marketing site uses its Astro
section and block components; organization sites render published blocks. Expo,
SwiftUI, and Android use their own platform components rather than importing web
styling. Email uses `packages/email` components and an email-safe theme. Keep
focus, disabled, loading, error, and empty states part of each component's
design.

## Do's and Don'ts

### Do:

- **Do** read the relevant app guide and the current component/theme
  implementation before adding a surface.
- **Do** route project branding through the appropriate brand config or
  published organization theme.
- **Do** test keyboard or native accessibility, reduced motion, narrow screens,
  and right-to-left layouts where supported.

### Don't:

- **Don't** hardcode this template's example palette, font, spacing, or shape
  choices into a reusable design brief.
- **Don't** treat operator authentication UI and customer authentication UI as
  one shared flow.
- **Don't** put customer data in a storefront server-rendered UI to simplify
  presentation.
