---
name: Browser extension
description: Compact, permission-first interface guidance
---

# Design System: Browser Extension

## Overview

**Creative North Star: "A small, honest status panel"**

The popup communicates login and per-host permission, then offers a few clear
actions. It is a companion to the operator app, not another dashboard. Follow
the root `DESIGN.md`.

## Colors

The popup uses shared UI roles through `src/index.css`. The injected widget uses
its own `src/content/content.css` inside a shadow root. Make status readable in
text as well as appearance; do not rely on a host page's theme.

## Typography

Favor concise status, a readable host name, and unambiguous action labels. Make
long host names wrap or truncate without hiding which host is being granted
access.

## Layout

Keep the compact popup's current host, login state, permission state, and next
action in one reading path. The page widget should remain contained and should
not obscure the host site's primary controls.

## Components

Reuse `packages/ui` button and card variants in the popup and scope widget
styling to its shadow DOM. Show checking, allowed, disabled, unsupported, and
error states distinctly. Granting permission is an explicit per-host action,
never an implicit result of opening the popup.

## Do's and Don'ts

### Do:

- **Do** keep the extension's visible identity sourced from the shared brand
  config.
- **Do** make the effect of Allow and Disable clear before interaction.

### Don't:

- **Don't** mimic or overwrite the host site's visual identity.
