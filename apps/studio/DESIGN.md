---
name: Database studio
description: Design boundaries for the local database browser
---

# Design System: Database Studio

## Overview

**Creative North Star: "Unobstructed inspection"**

This app is a local launch wrapper around Drizzle Studio, not a separately
designed product UI. Follow the root `DESIGN.md` only when adding a genuine
local interface; Drizzle Studio owns the present browser, query, and edit
controls.

## Layout

Keep control-plane entities and their fields easy to inspect without hiding data
behind branding. If a wrapper UI becomes necessary, make the local-only context
explicit and preserve direct access to Studio's existing tools.

## Do's and Don'ts

### Do:

- **Do** leave the third-party tool's interface intact unless a real workflow
  requires a wrapper.

### Don't:

- **Don't** invent theme tokens or component rules for UI this repository does
  not own.
- **Don't** present the loopback-only studio as a deployable public surface.
