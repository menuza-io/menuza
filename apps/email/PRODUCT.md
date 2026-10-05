# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds email-template truth.

## Platform

web

## Users

Developers designing and previewing the transactional emails. The recipients are
the platform's own users: operators (verification, password reset, invites,
security alerts, invoices) and organization team members (comment and mention
notifications).

## Product Purpose

A dev-only preview and export wrapper around the shared email template package:
the React Email server renders the product's transactional set with a shared
email design system, and render tests assert the CTA and brand invariants of
every template.

## Operating Context

`npm run dev -w email` (port 3012; not part of the all-in-one dev command).
Templates and the theme live in the shared package; sending is provider-backed
with a webhook layer.

## Capabilities and Constraints

Template set (as shipped): signup verification, forgot password, email change
and email-change notice, organization invite, trial ending, new-device sign-in,
invoice, contact notification, comment and mention notifications. Shared
components: layout (brand header and footer), card, button, code, heading,
eyebrow, note, paragraph, quote, details, steps, link.

Constraints (durable for email design): email clients render neither oklch nor
CSS custom properties, so colors stay literal hex mirrored from the app's
tokens; logos are raster images, not SVG; brand strings interpolate from the
brand config and are never hardcoded; 600px mobile breakpoint; every template
carries preview props for the preview server and the render tests.
