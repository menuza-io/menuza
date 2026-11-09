# Inventory: production readiness plan

Status as of 2026-11-09, branch `pr/inventory` (HEAD `12b1ce67d`, 22 inventory
commits on top of `main`, nothing pushed). All five phases of
[inventory-plan.md](inventory-plan.md) are built. This document is the result of
five independent read-only reviews and says what stands between the branch and a
production launch.

The full reports are in [inventory-review/](inventory-review/):

| #   | Review                                            | Report                                                                                                                                               |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Region security and data integrity                | [1-region-security](inventory-review/1-region-security.md), [1a](inventory-review/1a-station-routes.md), [1b](inventory-review/1b-data-integrity.md) |
| 2   | Money, units and rules (domain logic)             | [2-domain-logic](inventory-review/2-domain-logic.md)                                                                                                 |
| 3   | Migrations, rollout, operations, verification run | [3-deploy-and-verification](inventory-review/3-deploy-and-verification.md)                                                                           |
| 4   | App UI, UX, i18n, accessibility                   | [4-app-ui](inventory-review/4-app-ui.md)                                                                                                             |
| 5   | Station offline sync and product fit              | [5-station-and-product-fit](inventory-review/5-station-and-product-fit.md)                                                                           |

**How much to trust this.** The findings come from reviewing agents. The domain
review reproduced eight of its findings with throwaway tests; the security
review verified by reading code paths and did not run anything beyond the App
guard test; the App and Station reviews read code and ran targeted tests but no
browser. Nobody ran Playwright, a dev server, or the app against a real tenant
database (machine rules). Treat the severities as a strong starting point and
re-verify each item when you fix it (every item has a suggested regression test
in its report).

## Verdict

**Not ready to merge or enable for customers yet, but close in shape.** There
are no security blockers and no high-severity security findings. What is left is
(a) one failing CI gate, (b) a handful of real correctness bugs in counts, batch
recording and cost, (c) the Station multi-tablet counting behaviour, (d) a
missing Settings screen, and (e) deploy hygiene and docs. About 4–6 focused
working days of fixes by one engineer, plus a real end-to-end pass.

## What was verified green

Run serially by review 3 (all pass unless noted):

| Check                                      | Result                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `tsc`: inventory, tenant-api, station, app | pass                                                                   |
| `@repo/inventory` vitest                   | 14 files, 290 tests                                                    |
| `@repo/tenant-db` vitest                   | 26 files, 267 tests                                                    |
| tenant-api inventory suites (3 batches)    | 378 tests                                                              |
| Station vitest (stock, kitchen)            | 157 tests                                                              |
| App vitest (inventory paths)               | 63 files, 740 tests                                                    |
| jobs-cron `index.test.ts`                  | 54 tests                                                               |
| Lingui check                               | pass                                                                   |
| oxlint / App ESLint                        | 0 errors (8 + 4 warnings)                                              |
| Full tenant-api vitest                     | 4566 pass, **27 fail** (25 other-session, 1 inventory, 1 scratch file) |

No `.skip` / `.todo` / `.only` / `TODO` / `FIXME` in the changed files. Security
sweep found sound token, grant, scope, impersonation and location enforcement,
cost-omission on every response path including idempotent replays, chunked `IN`
lists, working append-only triggers, strict request bodies and no SSRF surface.

Not run by anyone: Playwright (App and Station), a browser, an Arabic/RTL visual
check, a real object-storage round trip, Durable Object runtime, KSA node, a
two-tablet offline scenario.

## Findings by priority

IDs refer to the report that owns the finding. "S/M/L" is rough effort (S under
half a day, M about a day, L several days).

### P0: fix before anything else (blockers)

| ID       | What                                                                                                                                                                                                                                                                                                                                                   | Effort |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| D-01     | `person-erasure-pii-columns.test.ts` fails: `inv_transfers.note` (migration 0038) is missing from `ALLOWED_COLUMNS`. Required CI gate. Decide whether the note can hold PII, then add it with a reason.                                                                                                                                                | S      |
| D-03     | Do **not** commit the uncommitted `workers/tenant-org.ts` / `migrations.ts` legacy-inventory hunk. Production never had the prototype tables (only the unpushed local `wip/inventory-v1` branch did), and the hunk breaks 25 tests (`db.all is not a function`). Add `/api/inventory/tick` to `isTick` in `tenant-org.ts:181` only (D-04), separately. | S      |
| D-02     | 61 of 67 local dev tenant DBs are stuck at migration 0034 because the prototype tables collide with 0035/0037. A dev-only problem: delete those dev DBs (or make a dev-only rename shape-based) rather than shipping prototype handling to production.                                                                                                 | S      |
| A1–A4    | Station counting (below).                                                                                                                                                                                                                                                                                                                              | M–L    |
| H1       | Domain: double deduction on batch / prep (below).                                                                                                                                                                                                                                                                                                      | M      |
| H2       | Domain: batch-counted made items vanish from food cost (below).                                                                                                                                                                                                                                                                                        | M      |
| H3       | Domain: wrong currency stamped (USD) on a fresh org's first quantity-only delivery (below).                                                                                                                                                                                                                                                            | S–M    |
| H-1 (UI) | No Inventory Settings screen (below).                                                                                                                                                                                                                                                                                                                  | M      |
| H-2 (UI) | Counting screen shows green "Saved" for an entry the region refused (below).                                                                                                                                                                                                                                                                           | S      |

### P1: correctness and integrity (fix before the first real customer)

**Station counting (review 5, Part A; review 1a)**

- **A1 (high).** Changing a row's unit after the first entry was sent
  double-counts: the live key includes the unit
  (`inventory-counts-service.ts:76`), the old-unit entry stays live, and Clear
  clears only the current unit. Fix: make the region treat one item × area as
  one live entry (or make the client clear the other units), and test the sent
  case.
- **A2 (high).** Start-count joins a count that is already `in_review`
  (`OPEN_STATUSES`, `inventory-counts-service.ts:63`); every entry then gets 409
  `count_closed`. Fix: join only `counting`; show "ready for review" and offer a
  new count.
- **A3 (high).** One tablet's "Send for review" closes the count for everyone
  and the whole entries request is refused, so already-accepted replays fail
  too. Fix: send per device (the plan's "ends the tablet's part"), the count
  moves to `in_review` only when a manager closes it or all joined devices sent;
  make late entries for an `in_review` count accepted or reported per entry,
  never silently lost.
- **A4 (high).** `SyncSheet.tsx:213` promises a manager can see refused entries
  in the App, but they are never stored and "Clear these" deletes the only copy.
  Fix: either store refused entries region-side (a small `inv_refused_entries`
  or audit rows) or change the wording and keep the rows until discarded.
- **A5.** A deferred photo or a delivery that always 500s blocks the strict
  queue for about 21 minutes or forever. Fix: per-kind lanes, or skip-after-N
  with a visible stuck item.
- A6–A12 (medium): bucket CORS for browser PUT undocumented, contract version
  never bumped and a schema-failing response loops as retry, `dropLocalCount`
  never called so closed counts stay as "In progress", `madeAt` uses the raw
  device clock, no double-tap guard on delivery/waste submit, two counters on
  one shelf are summed, deliveries without an order can only pick items that
  already have a supplier product.

**Domain logic (review 2)**

- **H1.** `recordBatch` and `generatePrep` (finishing a prep task) never check
  `batchCounted` (`inventory-batch-service.ts:60-197`,
  `inventory-prep-service.ts:341-413`); sales already expand non-batch made
  items into ingredients (`engine/expand.ts:157`), so ingredients are taken out
  twice (flour fell 600 g for 4 pizzas, then 1000 g again for one batch). Fix:
  refuse (409) or no-op batch/prep for items where `batchCounted` is off, and
  hide prep suggestions for them. Test: the repro in the report.
- **H2.** Batch-counted made items never get an average cost
  (`inventory-batch-service.ts:187-197`), so their later sales and waste carry
  no value and food cost reads 0% (`inventory-sales-service.ts:468-479`). Fix:
  on batch, value the made item at the ingredient cost ÷ yield and update its
  average; test food cost after batch + sales.
- **H3.** `resolveInventoryCurrency` falls back to USD
  (`inventory-purchasing-service.ts:882-904`) and the confirm-prices dialog has
  no currency field, so a SAR org gets locked into USD and later SAR deliveries
  fail with `currency_mismatch`. Fix: one currency per organization, set once
  from the org/location (and enforced, M7); never default to USD.
- **H4.** Cancelling a delivery restores the last cost but not the weighted
  average (`inventory-purchasing-service.ts:1626-1717`). Fix: recompute the
  average from remaining deliveries, or write a correcting entry.
- **Mediums:** M1 count approval compares against live on-hand and wipes a
  delivery that arrived between counting and approval (same as D-2 in review 1b;
  decide the rule: compare at the count's `startedAt` and keep later movements);
  M2 auto sold out restores dishes when the last count passes 7 days even though
  stock is still zero; M3 food-cost sales window vs ledger window use different
  dates; M4 dish food-cost % ignores VAT-inclusive prices; M5 level suggestions
  ignore `batch_used`; M6 phantom "on order" after an unlinked delivery
  under-orders; M8 `confirmDeliveryPrices` takes today's on-hand as "stock
  before this delivery". Lows are in the report.

**Region integrity and security (reviews 1, 1b)** — no blocker or high; all
medium:

- **M-1.** `deliveryDetail` returns the signed invoice-photo URL to tokens
  without the cost grant; the photo shows prices. Omit it (or require the cost
  grant) like money.
- **M-2.** `PATCH /items/:id` can change `baseUnit` unless the item has
  movements, silently relabelling recipes, packs, levels, prep levels and open
  orders. Forbid when anything references the item.
- **S-1 / D-3.** A delivery replayed more than 48 hours after the first posts
  stock again (`lib/inventory-write.ts:44,175-186`); `inv_deliveries` has no
  client id. Add a unique `client_id` column (new migration) so replays are
  detected forever, not just for the idempotency window.
- **D-1.** Mixed currencies are accepted but value is labelled with the first
  cost row's currency (the appended movements cannot be repaired). Fixed
  together with H3.
- **D-4.** No maximum on delivery money fields; huge values 500 and can make
  later value reads throw. Cap in the contract.
- **D-5.** Without a reservations settings row, business dates are UTC with a
  04:00 day start. An inventory-only org gets wrong day boundaries. Give
  inventory its own timezone setting (lands with the Settings screen).
- **D-6 / M-5.** `sendOrder` emails the supplier before taking the lock;
  concurrent sends email twice and a failed commit leaves the email sent. Take
  the lock and mark `sending` first.
- Lows worth doing with the above: prune `inv_idempotency_keys` (also D-09), add
  `amountMinor` to `MONEY_FIELDS`, restrict org-wide settings changes to tokens
  without a location limit, rate-limit and cache the invoice reader, fix the
  duplicate-`clientId`-in-one-waste-batch 500 that the Station queue retries
  forever (S-3), availability restore without `since` (S-7), notify claims the
  member row before sending so a failed send is never retried (S-8), `madeAt`
  lower bound, restoring an archived item skipping the 5000-item cap.

**App UI (review 4)**

- **H-1.** Build Inventory Settings (`inventory/settings`): target food cost %,
  units system, weekly count day and time, location timezone / day start, "any
  staff can receive". The region has `PUT /settings`; the App only reads it, so
  "count due" can never fire and 30% food-cost target is fixed.
- **H-2.** `rowSaveState` ignores refused entries, so a refused entry shows a
  green "Saved" and re-entering the same value does nothing (`committedRef` is
  not reset). Show "not saved" per row with the reason and let the person retry.
- **M-1** region error codes map to wrong sentences (`limit_reached`,
  `idempotency_conflict`, `already_undone`, `undo_expired` all read "Someone
  else changed this first…"; `not_found` reads "Check your connection"); a retry
  after an ambiguous failure reuses the same `clientId`.
- **M-2** count queue in `localStorage` is flushed only by that count's screen,
  has no user id in the key (another user on a shared tablet sends the previous
  user's entries), two tabs overwrite each other, and quota failures are
  swallowed.
- **M-3** an unusable typed number ("5,5", letters, too large) emits `null` from
  `QuantityStepper` and commits "clear entry", silently deleting a saved count.
- **M-4** plan items not built and not on the acknowledged list: Settings page,
  dishes in the Log waste picker, the item sheet "Used in" section, Food cost
  sort in the menu list, last count shown faintly.
- **M-5** a failed refresh keeps stale data without an error; **M-6** switching
  location shows the previous location's rows until the response lands; **M-7**
  unpluralised sentences (matters for Arabic); **M-8** Arabic wording: "Short"
  translated as `قصير` (short in length) instead of "delivered short"; "item",
  "delivery", "supplier" each use two or three Arabic words.
- Lows: tab links carry every query param, steppers all read "Less/More" without
  the item name, missing `prep` breadcrumb label, raw ISO date in count review,
  a newer region attention kind breaks Today in an older open tab, no tests for
  the location picker, token cache, adjust-stock dialog, setup checklist or any
  RTL screen.

### P2: deploy, ops and documentation

- **D-06.** CI deploys App, tenant-api and jobs-cron in parallel and Station is
  not in `deploy.yml`. A new App against an old tenant-api gets 400 on
  pairing-code creation (the Terminals form always sends `inventoryEnabled` to a
  strict route). Fix: send the field only when the Stock toggle is on, or make
  the region accept it first; document the order.
- **D-05.** The next upstream sync collides with control-plane `0040` and tenant
  `0033`–`0038`. Renumber synced migrations and give them `when` values above
  `1794198507000` (control) and `1794245121651` (tenant) or older databases skip
  them.
- **D-07.** Region switch or deprovision wipes `inv_sold_out`, so dishes the App
  marked unavailable are never restored. Restore availability before wiping.
- **D-08.** Invoice photos reuse the call-recording bucket: credentials now need
  write access and the bucket needs a CORS rule for browser PUT from the App and
  POS origins; CORS on KSA's OCI Object Storage is unverified.
- **D-10.** `.env.example` lacks `INVENTORY_TICK_INTERVAL_SECONDS` and
  `INVOICE_READER_*`; there is no `docs/inventory.md` runbook (the plan says one
  must exist); no App Playwright spec; no `seed:inventory` demo script.
- Housekeeping: the only uncommitted changes in the working tree are
  `apps/tenant-api/workers/tenant-org.ts` and
  `packages/tenant-db/src/migrations.ts` (the legacy-inventory hunk, see D-03).

## Workstreams and order

Do these in order; each is one reviewable PR-sized commit group. Total about 4–6
engineer-days before E2E.

1. **WS0: Unblock CI (half a day).** D-01 allow-list line; add
   `/api/inventory/tick` to `isTick` (D-04) in its own commit; decide D-03/D-02
   (drop the legacy hunk, reset dev DBs). Re-run the full tenant-api suite on an
   unloaded machine and confirm 0 failures.
2. **WS1: Stock and cost correctness (1.5–2 days).** H1, H2, H3 (+D-1, M7), H4,
   M1/D-2 (decide the approval rule first; write it in the plan), M-2 base unit
   lock, D-4 caps, S-1/D-3 delivery `client_id` migration, D-6 order send lock.
   Each with the failing repro from review 2 as a regression test.
3. **WS2: Station multi-tablet counting (1.5 days).** A1–A4, A5, A8, A10, the
   S-3 duplicate-`clientId` 500, A7 contract version bump and schema-failure
   handling. Then the two-tablet offline-to-App integration test (Station vitest
   with a real region test harness, or a Playwright spec against a local region
   that the user runs).
4. **WS3: Settings screen and App fixes (1.5 days).** H-1 settings page
   (including timezone / day start, D-5), H-2 refused-entry state, M-1 error
   mapping, M-2 queue keys and cross-tab safety, M-3 stepper null, M-5/M-6 stale
   data, M-7/M-8 plural and Arabic wording, the small a11y items, missing tests
   (location picker, token cache, adjust-stock, checklist, one RTL screen).
5. **WS4: Hardening and security mediums (half a day).** M-1 invoice-photo URL
   money gating, org-wide settings and location-limited tokens, idempotency
   pruning job, invoice reader rate limit, `amountMinor` in `MONEY_FIELDS`,
   notify retry (S-8), availability restore guard (S-7), `madeAt` bounds (A9),
   archived restore cap.
6. **WS5: Deploy and docs (1 day).** D-06 skew fix, D-07 restore-before-wipe,
   D-08 bucket CORS doc and a startup self-check, env docs, `docs/inventory.md`
   operator guide and runbook (setup, kill switches, rollout order, rollback,
   storage, tick, alerts), update `docs/scheduled-jobs.md` and `docs/pos.md`,
   add Station to the deploy pipeline or document its manual step,
   `seed:inventory`.
7. **WS6: Verification (1 day, needs the machine unloaded).** Full test suites,
   the App Playwright spec for setup → count → delivery → food cost (ask the
   user first: it writes to LibSQL), run the Station spec, manual iPad Safari
   pass for camera, offline and touch targets, an Arabic `?lng=ar` walk through
   every screen, a KSA-node smoke test (in-region email, no Twilio, invoice
   reader region check), and a Durable Object runtime run on `wrangler dev` or
   staging.

## Launch gates

Ship behind the existing flags, turning `inventory.enabled` on for one pilot
organization first. Do not enable for customers until all of these are true:

- WS0, WS1, WS2 and the H-1/H-2 items of WS3 are merged and green.
- Full tenant-api suite: 0 failures; typecheck and Lingui clean.
- The two-tablet offline test and the App setup → count → delivery → food cost
  flow have passed once against a real tenant database.
- `docs/inventory.md` exists and the rollout below has been rehearsed on
  staging.
- Invoice photo upload verified end to end with bucket CORS, or the photo
  feature is left off (`inventory-invoices` upload disabled) for the pilot.

## Rollout order and rollback

From review 3 (details and the version-skew matrix are in its report):

1. Control-plane migration `0040_inventory` (permissions and flags, all off).
2. App (token route, notify and availability resources, UI). The `stationApps`
   claim gains `inventory`; a missing field fails closed.
3. tenant-api US, then KSA (tenant migrations 0033–0038 are additive with safe
   defaults; set `INVENTORY_ENABLED`, `RECORDING_S3_*` with CORS,
   `INVENTORY_TICK_INTERVAL_SECONDS` on Node, `INVOICE_READER_*` only where an
   in-region model exists).
4. jobs-cron (hourly inventory tick fan-out; uses no new cron slot).
5. Station (deploy last; it sends the contract version header).
6. Flags: pilot organization first, then widen.

Rollback: flip `inventory.enabled` off per organization, or
`INVENTORY_ENABLED=false` per node (503 on operator and Station inventory
routes; the sale-side queue keeps queuing, so no sale is lost). Migrations are
additive and not reversed; Station tablets keep their local queue and sync after
re-enable.

## Product gaps and roadmap after launch (review 5, Part B)

Ranked by owner value × frequency ÷ effort. Launch blockers are already in P0–P2
above; the rest are fast-follows.

**Fast-follows (next 2–4 weeks)**

1. Accountant/CSV export: purchases by supplier with VAT, invoice number and
   ZATCA reference; item and count export; report subjects in `packages/reports`
   (the plan promised them in phase 3 and they were not built).
2. Dishes in the Log waste picker (App and Station) now that recipes exist.
3. Auto-create stock items from POS dishes: the strongest lever against the
   "recipe wall" abandonment the plan's own research names.
4. Scheduled opening/closing quick counts (count lists exist; only one weekly
   day can be set today).
5. Food cost from daily/list counts, not only the last two full counts.
6. Receive market and cash-and-carry goods without a preset supplier product.
7. Variance by item over time; dishes over target food cost on Today.
8. Supplier price-list import; Station transfers screen; edit a planned
   transfer; `inventory_sold_out` notification kind; reservations covers nudge
   in prep; DO alarm for sale retries; set prices from read-invoice lines; "Used
   in" section; Food cost sort in the menu list.

**Cut for now:** barcode scanning, lot/expiry/FIFO, WhatsApp API ordering,
allergens, item photos, a second-approver workflow, more Station screens until
WS2 is done. Keep the invoice reader as optional infrastructure behind a runbook
entry.

## Open decisions for the owner of the product

1. **Count approval rule (M1 / D-2).** Compare against ledger at the count's
   start time and keep later movements (recommended), or against live on-hand
   (current behaviour, wipes late deliveries).
2. **Send for review (A3).** Per-tablet send with the count closing when a
   manager approves (recommended), or wait for every device.
3. **One currency per organization (H3).** Recommended and enforced; confirm no
   multi-currency organizations exist.
4. **Kitchen team sees costs?** Still default no; the review found no leak path.
5. **Invoice photos in v1?** Needs bucket CORS and a KSA storage check; consider
   piloting without.
6. **Dev databases.** Delete the 61 stuck local tenant DBs (recommended) or keep
   dev-only legacy handling out of the production path.
