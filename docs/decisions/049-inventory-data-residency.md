# ADR 049: Inventory data residency and plane split

- **Status:** Accepted
- **Date:** 2026-11-09
- **Related:**
  [ADR 045 — Tenant Customer Data Residency](./045-tenant-data-residency.md),
  [ADR 047 — Staffing Data Residency](./047-staffing-data-residency.md),
  [ADR 048 — Reservations Data Residency](./048-reservations-data-residency.md),
  [Inventory plan](../inventory-plan.md)

## Context

Menuza is adding restaurant inventory: items and units, storage areas, stock
counts, waste, deliveries and suppliers, then ordering, recipes and dish costs,
stock used by sales, prep and transfers. Operators use it in the App; staff use
it on paired Station tablets.

Discount definitions live in the US control plane because the order context that
carries them comes from the App. Inventory is different in three ways:

1. **Stock is used by sales, and sales are regional.** Web and QR orders
   (`restaurant_orders`) and Station sales (`pos_orders`) live in the regional
   tenant database. Deducting stock must be queued in the sale's own transaction
   and settled after commit, as loyalty does.
2. **Station writes go browser-direct (and offline) to the region**, like time
   clock punches.
3. **Records name people.** Counts, waste and deliveries record which staff
   member or operator acted; suppliers carry business contacts (a person's name,
   phone and email). KSA operators also expect purchasing records and supplier
   tax invoices to stay in-region.

## Decision

1. **All inventory data lives in the regional tenant database** (`inv_*` tables
   in `packages/tenant-db`, served by `apps/tenant-api`), for both `us` and
   `ksa` organizations: the item catalogue, suppliers and prices, recipes,
   counts, the stock ledger, deliveries, waste, prep and transfers.
2. **The control plane keeps only feature flags and permissions** (`inventory.*`
   flags, five `*:inventory*:any` permissions; migration `0040_inventory`). No
   App loader reads or joins inventory rows.
3. **The App UI is client-rendered against tenant-api** with a short-lived
   `inv+jwt` operator token minted at `/<orgSlug>/inventory-token`, carrying
   grants, feature flags and `locationIds` only. Station uses its device secret
   plus a staff session.
4. **Cross-plane traffic is ids and counts only.** Recipes reference opaque
   control-plane menu item, variant and option ids; menu names are joined in the
   browser, never copied into the region. Auto sold out (later) posts
   `{orgId, locationId, entityType, entityId, available}` to an App resource
   route; alerts post `{orgId, eventId, kind, locationId, count}`. Neither
   carries staff or supplier data.
5. **The region reads organization flags from the App**
   (`GET /resources/inventory/context?orgId=`, internal token), cached and
   fail-closed, like loyalty.
6. **Invoice photos are stored in-region**, and any automated reading of them
   for a KSA organization runs on an in-region model only.

## Consequences

- The menu editor shows dish costs by calling tenant-api from the browser; the
  App never sees costs server-side.
- A node kill switch (`INVENTORY_ENABLED`) stops operator and Station inventory
  routes without losing sale-side deductions, which keep queuing.
- Person erasure must cover inventory actor columns and supplier contacts;
  `person-erasure-pii-columns.test.ts` lists them with reasons.
- Reports on inventory are regional report subjects, like other tenant data.
