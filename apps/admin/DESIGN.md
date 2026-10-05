---
name: Platform admin
description: Design guidance for the staff-only oversight console
---

# Design System: Platform Admin

## Overview

**Creative North Star: "Clear oversight"**

This is a staff tool for decisions with platform-wide consequences. Follow the
root `DESIGN.md` and the operator app's shared component language, but
prioritize provenance, scope, and safe confirmation over decoration.

## Colors

Use the semantic roles in `app/styles/tailwind.css` and `packages/ui` for
normal, selected, warning, destructive, and focus states. Statuses must remain
intelligible without color.

## Typography

Use a strong hierarchy between the page's scope, entity identifiers, field
labels, and supporting audit details. Keep data legible at table density and in
translated layouts.

## Layout

Preserve the sidebar's platform-level navigation and make organization- or
user-level context explicit on detail pages. Tables, filters, export controls,
and audit trails should remain scannable across screen sizes and right-to-left
layouts.

## Components

Reuse `packages/ui` buttons, cards, dialogs, form controls, and navigation
rather than restyling them. Distinguish read-only inspection from changes to
access, bans, retention, feature flags, or GDPR requests. Show operation scope
and outcomes before and after consequential actions.

## Do's and Don'ts

### Do:

- **Do** keep loading, empty, denied, and error states explicit for
  administrative data.
- **Do** make support impersonation visibly different from normal operator
  access.

### Don't:

- **Don't** present platform-wide actions as casual inline toggles without
  adequate context.
- **Don't** bring customer PII into the control-plane console to complete a
  design.
