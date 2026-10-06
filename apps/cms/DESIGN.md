---
name: CMS integration
description: Design boundary for the embedded marketing content editor
---

# Design System: CMS Integration

## Overview

**Creative North Star: "Edit where the content lives"**

This directory has no independently maintained frontend. The marketing CMS
editor is embedded in `apps/web`, whose `DESIGN.md` governs the public pages and
their CMS-backed blocks. Use the root `DESIGN.md` for shared principles. This
file exists to prevent inventing a second CMS identity for a wrapper directory.

## Components

Use the existing editor's controls for authoring. Define any new public block in
the marketing site's component library so preview and published output agree.
Keep editing affordances distinguishable from the page being edited.

## Do's and Don'ts

### Do:

- **Do** check the actual implementation in `apps/web` before changing
  editor-adjacent UI.

### Don't:

- **Don't** copy a third-party editor theme into this template as a global
  visual rule.
