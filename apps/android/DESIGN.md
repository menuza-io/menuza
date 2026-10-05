---
name: Android customer app
description:
  Lightweight native customer guidance using published organization branding
---

# Design System: Android Customer App

## Overview

**Creative North Star: "A familiar native doorway"**

This framework-only Kotlin app mirrors the iOS customer journey without shipping
an additional UI framework. The same published organization theme drives its
connect, phone verification, name, and profile screens. Follow the root
`DESIGN.md`.

## Colors

`ui/ThemePalette.kt` resolves semantic roles from `core/theme/SiteTheme.kt`,
including a fallback before branding arrives. Use these roles for every view and
for announcement states; keep state labels visible independently of appearance.

## Typography

Resolve supported organization heading and body roles through the palette. Allow
system font scaling, translated labels, and device fallbacks without clipping.

## Layout

Build with programmatic platform views and native touch, focus, keyboard, and
screen-reader behavior. Keep each auth step focused. Rebuild directional layout
when the language changes; preserve the reading direction of phone numbers and
codes.

## Shapes

Use the organization's resolved shape setting consistently for cards, buttons,
and fields rather than a hardcoded default.

## Components

Extend `ui/components/ThemedControls.kt` for shared header, announcement, card,
button, and field behavior. Loading, disabled, and failure states should mirror
the iOS journey. Keep new UI within the app's size budget; do not add a UI
framework for a cosmetic change.

## Do's and Don'ts

### Do:

- **Do** test universal and white-label branding, fallback themes, and Arabic
  layouts.
- **Do** keep the customer journey recognizable alongside the storefront and iOS
  app.

### Don't:

- **Don't** import operator-app branding or add AndroidX/Compose just to restyle
  a control.
