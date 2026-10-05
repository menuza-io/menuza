---
name: iOS customer app
description: Native customer guidance driven by published organization branding
---

# Design System: iOS Customer App

## Overview

**Creative North Star: "A familiar native doorway"**

The SwiftUI app is a small companion to an organization's website: connect, sign
in by phone, verify, complete a name, and manage a profile. Whether universal or
white-label, it should feel like that organization's product, not like the
operator app. Inherit the root `DESIGN.md`.

## Colors

`Sources/TenantApp/Theme/ThemePalette.swift` resolves the published site theme
against the device appearance. Read semantic roles from the environment in every
control, including feedback and focus. Use the theme's fallback while branding
loads.

## Typography

Use the organization's supported heading and body roles when available, and a
legible native fallback otherwise. Let Dynamic Type and localized strings expand
naturally.

## Layout

Use SwiftUI's native safe areas, focus, keyboard, and navigation behavior. Keep
the connection, phone, code, name, and profile steps short and distinct. The
Arabic layout follows right-to-left direction without reversing phone numbers or
verification codes.

## Shapes

Derive card and control geometry from the resolved organization theme. Keep
touch areas, borders, and corner treatment consistent across screens.

## Components

Build from `Sources/TenantApp/Components/ThemedControls.swift` and the theme
parser in `Sources/TenantKit/Theme`. Buttons expose loading and disabled states;
fields expose labels and validation feedback. Native screens do not duplicate
the published page builder or shop.

## Do's and Don'ts

### Do:

- **Do** verify light, dark, and system appearance against different published
  themes.
- **Do** keep account flows accessible when the branding payload is incomplete.

### Don't:

- **Don't** embed one tenant's branding or the operator app theme in customer
  screens.
