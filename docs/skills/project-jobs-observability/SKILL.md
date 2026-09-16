---
name: project-jobs-observability
description:
  Guide Cloudflare cron triggers, Workflows, internal jobs, retries, logging,
  health checks, and operational telemetry in this project.
---

# Project jobs and observability

## When to use this skill

Use this skill when adding scheduled work, Workflows, cron-to-App calls,
tenant-api fanout, storage migration processing, health checks, logging,
metrics, or operational error handling.

## Jobs-cron is an orchestrator

`apps/jobs-cron` is a Cloudflare Worker. It authenticates before calling App or
tenant-api with `INTERNAL_COMMAND_TOKEN` and uses the following UTC schedules:

| Schedule    | Target                                                                  |
| ----------- | ----------------------------------------------------------------------- |
| `0 2 * * *` | App audit-log archival                                                  |
| `0 3 * * *` | App MCP-token cleanup                                                   |
| `0 4 * * *` | App GDPR erasure                                                        |
| `0 5 * * *` | App form-submission retention                                           |
| hourly      | Both configured regional tenant-api nodes for marketing engagement sync |

Keep scheduled handlers thin. They should call the existing authenticated App
resource routes or tenant-api system routes rather than duplicating domain logic
inside the Worker. Use `APP_BASE_URL` for App and
`TENANT_API_URL`/`TENANT_API_URL_KSA` for regional fanout.

## Internal authentication and privacy

Internal calls use `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>` with timing-
safe comparison. Validate body schemas, IDs, and allowed regions at every
receiver; never treat the Worker’s network location as authorization.

Jobs-cron may coordinate a tenant operation, but it must not collect or log
customer PII. For KSA, engagement sync goes directly to the KSA tenant-api;
customer email content and records must not pass through App or jobs-cron.

## Workflows and retries

Current Workflows include `StorageMigrationWorkflow` and
`MarketingJourneyWorkflow`. Workflow event IDs should be deterministic where the
caller has a stable run ID (`journey-${runId}` for journey instances). Use
stable, descriptive `step.do()` names and make every step safe to retry.

For batch work:

- Bound each request’s work and return progress.
- Make writes idempotent and record per-item failures.
- Retry transient network/SQLite failures; do not retry invalid input forever.
- On terminal failure, call the existing completion/error path before throwing.
- Avoid generating duplicate customer messages or payments on replay; use the
  existing journey idempotency and execution records.

## Observability

Use `@repo/observability` for structured logs/wide events and preserve request
IDs, service name/version, route, region, and safe error context. Do not log
tokens, password/OTP material, full email/phone values, message bodies, or
customer payloads. Health endpoints should be cheap, uncached, and report only
service/dependency status.

When adding an external dependency, update health checks and failure telemetry;
do not make liveness depend on a slow third-party API unless the service cannot
operate without it. Test both success and failure/partial-fanout behavior.

## References

- [Scheduled jobs](../../scheduled-jobs.md)
- [Monitoring](../../monitoring.md)
- [Performance monitoring](../../performance-monitoring.md)
- [Jobs Worker](../../../apps/jobs-cron/src/index.ts)
- [Workflow implementation](../../../apps/jobs-cron/src/marketing-journey-workflow.ts)
- [Observability package](../../../packages/observability/README.md)
