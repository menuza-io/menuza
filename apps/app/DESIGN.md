---
name: Operator app
description: Task-first design guidance for the operator workspace
---

# Design System: Operator App

## Overview

**Creative North Star: "A calm control room"**

The operator app is a working environment, not a showcase. Prioritize scanning,
predictable navigation, and clear next actions across dashboard, website editor,
catalog, marketing, team collaboration, and settings. Inherit the
repository-root `DESIGN.md`; this file only adds operator-app decisions.

## Colors

Use the semantic roles in `app/styles/tailwind.css` for page, sidebar, card,
action, feedback, and focus states. Keep light, dark, and system themes equally
usable. The deployment changes their actual appearance.

## Typography

Keep page titles, section headings, field labels, supporting copy, and tabular
values distinct by role. Allow navigation labels and error text to expand in
translation.

## Layout

The app shell and organization switcher orient users before task content.
Preserve navigation hierarchy in the sidebar and offer compact equivalents at
narrow widths. On dense tables, reports, and editors, keep primary actions and
context visible without crowding the content. Mirror directional placement in
Arabic.

## Elevation & Depth

Use shared card, popover, dialog, and sheet patterns to distinguish content from
temporary tasks. Overlays should have an obvious exit and preserve the
underlying task context.

## Components

Build from `packages/ui` variants and slots; `app/components/app-sidebar.tsx`
owns the shell. Forms need labels, validation messages, pending and success
states. The marketing email designer is a full-screen draft with an explicit
Save, not an implicit edit to the journey. Mark browser-to-regional-API customer
views distinctly from control-plane settings without exposing customer data
through server rendering.

## Do's and Don'ts

### Do:

- **Do** use existing shared component variants and theme roles before adding a
  one-off style.
- **Do** keep permission, loading, empty, and error states understandable in the
  same layout.

### Don't:

- **Don't** build new operator screens with storefront branding or a hardcoded
  clone palette.
- **Don't** make destructive or publish actions look like ordinary navigation.
