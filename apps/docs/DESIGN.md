---
name: Documentation site
description: Readable, navigable guidance for the hosted docs
---

# Design System: Documentation Site

## Overview

**Creative North Star: "Find it, understand it, use it"**

This is a Mintlify reading surface for setup, architecture, security, and
integrations. Favor clear information hierarchy and working examples over
expressive page design. Follow the root `DESIGN.md`.

## Colors

The docs platform owns rendering; `docs.json` configures the deployed project's
theme roles and logos. Keep links, notices, and code examples distinct and
legible in the platform's supported appearances without prescribing a starter
palette here.

## Typography

Structure MDX with descriptive headings, short paragraphs, lists, and code
blocks. Make commands copyable and separate notes, warnings, and prerequisites
by meaning rather than decoration alone.

## Layout

Keep navigation in `docs.json`, not per-page sidebars. A reader should be able
to move from overview to task, example, and related reference without losing
context. Long pages need useful heading structure and mobile-friendly code
examples.

## Components

Use the platform's cards, callouts, accordions, and code groups only where they
help comprehension. Keep examples consistent with the current codebase and treat
placeholder platform links and sample API endpoints as unfinished, not as
product guidance.

## Do's and Don'ts

### Do:

- **Do** give each page one clear question or workflow to answer.
- **Do** keep link labels and callout purposes understandable without visual
  styling.

### Don't:

- **Don't** invent a separate UI kit inside the MDX pages.
