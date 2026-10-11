# Staffing data placement

Date: 2026-10-11

Status: accepted (data placement); implementation is phased

## Context

Workforce records introduce employee and applicant names, contact details, pay,
schedules, punches, and eventually documents. Operator identity already lives in
the US control plane, but many workers do not need an operator account.
Representing every worker as a membership would also increase billed seats.

The regional-data rules in [ADR 045](./045-tenant-data-residency.md) prohibit a
US server proxy for KSA PII and reject cross-region migration. Those boundaries
must also cover workforce records before the first staffing schema is added.

## Decision

- Keep **all staffing records and enforcement rules** in the organization's
  regional tenant database, for both US and KSA organizations. This includes
  roster, positions, assignments, rates, availability, shifts, punches,
  timesheets, applicants, onboarding, notifications, and authoritative audit.
- Keep operator identity, membership, permissions, flags, billing, and location
  configuration in the existing control plane. Future public job postings may
  live there only if they contain no applicant or employee PII.
- Staff are distinct from operator members. A regional staff record may
  optionally link to a control-plane user through an opaque ID. Creating a staff
  record must not create a membership or change the seat quantity.
- Operators obtain short-lived, permission-scoped credentials from App. Staff
  data travels between the browser and the regional tenant-api, never through
  App loaders, App actions, Sites SSR, or Admin.
- Kiosk and future employee self-service credentials must be distinct from both
  operator and customer credentials. Customer auth is not staff auth.
- Documents, backups, sensitive audit values, and any processing of staff PII
  must stay in-region. Cross-plane notifications and audit mirrors contain only
  opaque references and generic events.
- Region changes continue to destroy the old tenant database, not migrate it.
  Before the roster pilot, implement a staffing-specific guard and direct
  export-to-browser flow. Whether to block a switch once employment records
  exist remains a release-gating decision.

## Rejected alternatives

- **US roster with regional sensitive fields:** schedules and availability are
  themselves personal data, and every useful view still needs a browser-side
  join. It introduces two placements without eliminating latency.
- **All workforce data in US D1:** incompatible with the regional-data rule.
- **Regional membership and billing:** duplicates existing operator auth and
  couples clock-only workers to seats.
- **US schedule cache or PII BFF:** creates another copy or transits KSA PII
  through the US.

## Consequences

Staff screens must be client-rendered with loading, error, and token-refresh
states. Labor costs can be joined with regional order data without crossing
planes. Staff without operator accounts can use a paired kiosk without a seat.

The initial pilot targets single-location US organizations. The same storage and
API design must support KSA, but this is not approval for KSA launch, labor-law
defaults, e-sign, or new providers. Login-email policy, retention, regional
backups, and region-switch handling require explicit release review.

See [staffing plan](../staffing-plan.md) and
[tenant data residency](../tenant-data-residency.md).
