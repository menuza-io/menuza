# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds the jobs worker's truth.

## Platform

web

## Users

None human. It is triggered by cron, and its HTTP endpoints are called only by
the operator app with the shared internal token.

## Product Purpose

The scheduled-maintenance and durable-workflow worker: cron triggers POST to
authenticated job routes on the operator app (audit-log archival, token cleanup,
GDPR erasure, form-submission retention), an hourly job syncs engagement on both
regional nodes, and Cloudflare Workflows run storage migrations and long-running
marketing journeys (delays up to weeks, retries, cycle detection).

## Positioning

Zero-PII by test: the worker only ever calls internal-token-authenticated
routes, and the marketing-journey workflow carries only customer identifiers and
unrendered journey templates to the regional tenant API; a test enforces that
injected customer PII is dropped from payloads and never logged.

## Operating Context

Cloudflare Worker with cron triggers and Workflows; included in `npm run dev`;
deployed at a jobs subdomain in production. Auth is a single shared secret with
timing-safe comparison; the workflow picks the regional API per the
organization's data region.

## Capabilities and Constraints

HTTP surface: health (public), storage-migration start, marketing-journey start,
cancel, and status (all internal-token authenticated).

Open item: one declared job route (form-submission retention) is not yet
registered as a cron trigger.
