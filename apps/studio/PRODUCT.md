# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds the dev database tool's truth.

## Platform

web

## Users

Developers only, during local work. This is internal tooling, not a product
surface: it opens a visual database browser against the control-plane schema
(users, organizations, sessions, roles, permissions, audit logs, and the rest of
the platform model).

## Product Purpose

A thin dev-only wrapper that runs the Drizzle Studio UI for inspecting and
editing the control-plane SQLite database locally.

## Operating Context

Loopback-bound (127.0.0.1, port 3003), started by `npm run dev`. It has no
build, no CI, and no deploy target.

## Capabilities and Constraints

One capability: browse, query, and edit the control-plane database visually.
Hard constraint: it has no authentication of its own, so it must never be
deployed or exposed beyond the developer machine.
