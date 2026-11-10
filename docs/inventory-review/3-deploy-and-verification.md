# Review 3: migrations, rollout readiness, operations, verification run

Repo: /Users/zama/menuza, branch pr/inventory, HEAD 12b1ce67d (22 inventory
commits over main 23ec5f15a). Scope: tenant migrations 0033-0038, control-plane
0040, rollout/ops, honest verification run. No repo file was edited. The one
generated churn I caused (`packages/database/src/env.ts`, Varlock regeneration,
formatting + `DATABASE_PATH`) was reverted with `git checkout`; `git status` is
back to the two other-session files (`apps/tenant-api/workers/tenant-org.ts`,
`packages/tenant-db/src/migrations.ts`).

Scratch artifacts (outside repo): `.../scratchpad/legacy/` (legacy-DB simulation
scripts and temp DBs), `.../scratchpad/verify/` (all test logs).

---

## PART A: findings

Severity key: blocker = do not merge or ship as is; high = fix before rollout;
medium = fix soon / known gap; low = polish.

### D-01 BLOCKER (CI): PII-column gate fails on `inv_transfers.note` (phase 5 migration 0038)

- Confidence: high (reproduced,
  `npx vitest run src/services/person-erasure-pii-columns.test.ts` fails).
- Where: `packages/tenant-db/drizzle/0038_inventory_transfers.sql`
  (`inv_transfers.note`), gate
  `apps/tenant-api/src/services/person-erasure-pii-columns.test.ts`
  (ALLOWED_COLUMNS block, ~lines 196-216, lists every other inv_*
  note/name/contact column).
- Scenario: the phase 5 commit added a free-text `note` column but did not
  classify it in the gate. Failure text:
  `expected [ 'inv_transfers.note' ] to deeply equal []`. The tenant-api vitest
  job is a required CI gate before deploy, so the PR cannot go green.
- Fix: add `'inv_transfers.note': inventoryStockNote` (or a transfer-specific
  reason: "operator note on a stock transfer or branch request, not about a
  customer") to ALLOWED_COLUMNS. Also consider adding
  `inv_transfers.created_by_id`, `sent_by_id`, `received_by_id` next to the
  other actor ids "so the decision is written down" (they do not match the PII
  pattern so the test does not require it).
- Also run the rest of that file; it was the only failure in it.

### D-02 HIGH (dev machine, and the reason the uncommitted code is wrong): 61 of 67 local tenant DBs are stuck at migration 0034 and cannot migrate to 0035-0038

- Confidence: high (read-only inspection of `packages/database/db/tenant_*.db`
  with `sqlite3 file:...?immutable=1`, plus a reproduction in scratch).
- Evidence: 61 DBs have `__drizzle_migrations` count 35 (max created_at
  1794208010195 = 0034), contain the legacy prototype tables
  (`inv_count_sessions`, `inv_recipes` with `ingredients_json`, `inv_prep_tasks`
  with plan columns, `inv_vendors`, ...) AND
  `legacy_inv_items`/`legacy_inv_storage_areas` (so the other session's
  uncommitted `prepareLegacyInventoryMigration` already ran on them), and have
  no `inv_recipe_lines`. One DB holds 13 legacy `inv_recipes` rows.
- Root cause: the parked prototype (`wip/inventory-v1`, commit 8b179ea11, its
  `0029_inventory.sql`) created 12 `inv_*` tables. Four names collide with the
  new schema: `inv_items`, `inv_storage_areas` (0033), `inv_recipes` (0035),
  `inv_prep_tasks` (0037) (plus indexes `idx_inv_items_category`,
  `idx_inv_storage_areas_location`). The uncommitted code renames only the first
  two. I reproduced: legacy DB + `applyTenantMigrations` =>
  `SQLITE_ERROR: table inv_recipes already exists` at 0035; the batch rolls
  back, the renames persist. Renaming all four first makes the chain apply
  cleanly through 0038 (n=39, max 1794245121651), verified in scratch.
- Impact: every tenant-api request for those 61 orgs on the dev machine fails at
  `getTenantDb` (migration throws) until fixed. No production impact (see D-03).
- A second defect even after adding the two renames: the guard
  `if any __drizzle_migrations.created_at >= INVENTORY_MIGRATION_MILLIS then return`
  skips the repair for exactly these stuck DBs (they already applied 0033/0034).
  The rename must be shape-based, not millis-based: for each of the four tables,
  rename to `legacy_<name>` when it has the legacy shape (`inv_recipes` has
  column `ingredients_json`; `inv_prep_tasks` has `prep_plan_id`/legacy plan
  columns; `inv_items`/`inv_storage_areas` lack the new columns, e.g. no `kind`
  / has none of the 0033 columns), and drop the two colliding indexes. That is
  idempotent and independent of the journal.
- Fix options for the other session (I did not touch the files): (a) extend the
  helper as above, or (b) simply delete/recreate the dev tenant DBs (they are
  demo data) and drop the helper entirely.

### D-03 HIGH (decision): do NOT ship the uncommitted `prepareLegacyInventoryMigration` / `prepareMissingSmsSendEventsMigration` in the DO path; production does not need it

- Confidence: high on facts, medium on the risk call.
- Was a legacy `inv_*` schema ever shipped? No evidence.
  `git log main -S inv_count_sessions` is empty; the prototype exists only in
  `8b179ea11` on the local branch `wip/inventory-v1` ("rejected, not to be
  merged"; its tenant migration 0029 also collided with main's
  `0029_sms_send_events`). `git branch -r --contains 8b179ea11` is empty (never
  pushed), and deploys trigger only from main/dev. So no production or staging
  DO and no OCI KSA file can have the legacy tables. The helper is dev-machine
  hygiene only.
- Risk of committing as is:
  1. It breaks 25 tests today: `src/lib/tenant-org-alarm.test.ts` (20 of 23) and
     `workers/tenant-org.test.ts` (5) fail with
     `TypeError: db.all is not a function`
     (`packages/tenant-db/src/migrations.ts:43`), because those tests mock
     `drizzle: () => ({})`. This is the known failure, confirmed, and it is
     caused solely by the uncommitted lines (stack trace points at
     `prepareLegacyInventoryMigration`).
  2. In the Durable Object path it adds two `sqlite_master` queries to every
     cold start for no benefit.
  3. It is incomplete (D-02), so it gives false confidence.
  4. `INVENTORY_MIGRATION_MILLIS = 1794198847837` (migrations.ts:~25) duplicates
     the journal `when` of `0033_inventory`. If 0033 is ever regenerated or
     renumbered during an upstream-sync rebase (see D-05) the constant silently
     drifts; nothing ties them together.
  5. `prepareMissingSmsSendEventsMigration` is a separate dev-only repair (a
     local file whose `__drizzle_migrations.max(created_at)` came from the wip
     0029 `when` 1793982272651, which is later than main's 0029_sms `when`
     1793942129603, so drizzle skipped 0029_sms). It is unrelated to inventory
     and also has no test. Same reasoning: not needed in prod. For a DB at head
     it is a no-op.
- Recommendation: do not commit the `tenant-org.ts` hunk. If dev repair is
  wanted, keep it only in the Node `applyTenantMigrations` path, make it
  shape-based, derive any timestamp from the journal, and add a vitest that
  builds a legacy DB (my scratch `legacy/sim.mts` shows how: copy journal
  entries 0-28, swap in the wip `0029_inventory.sql` with `when` 1793982272651).
  Otherwise delete the 61 dev DBs.

### D-04 MEDIUM: Workers inventory follow-up alarm is never armed (`isTick` omits `/api/inventory/tick`)

- Confidence: high (code read; `armForRequest` returns `'skipped'` when
  `tickResult` is null).
- Where: `apps/tenant-api/workers/tenant-org.ts:181-184`
  (`const isTick = staff || reservations || loyalty`), consumed by
  `maybeArmAlarm`; module defined in
  `apps/tenant-api/src/lib/inventory-alarm.ts`
  (`tickPath: '/api/inventory/tick'`, `isActivityPath: () => false`), registered
  in `apps/tenant-api/workers/index.ts:60-66`.
- Scenario: the hourly fan-out forwards `/api/inventory/tick` to each org DO.
  The response body (`needsFollowUp`, `nextDueAt`) is only parsed for the three
  listed paths, so for inventory `tickResult` is null and the 5-minute retry
  alarm is never armed. Because the inventory module's `isActivityPath` is
  false, nothing else arms it. Effect on the US Workers node: failed App alerts
  and failed sale-usage settles (`inv_outbox`, backoff 30 s to 1 h) and the
  auto-sold-out `deferred` retry only retry hourly. `docs/scheduled-jobs.md`
  ("armed only by such a tick") and `inventory-alarm.ts` promise sub-hourly. The
  KSA Node interval is unaffected.
- Fix: add `|| pathname === '/api/inventory/tick'` to `isTick` (better: derive
  from `registeredOrgTickModules().some(m => m.tickPath === pathname)`), plus a
  test in `workers/tenant-org.test.ts` (it mocks staff/rsv/loyalty only) that an
  inventory tick reporting `needsFollowUp` sets the alarm.
- Related fragility (low): the inventory tick module is registered in
  `workers/index.ts` while staff/rsv/loyalty register in `tenant-org.ts`. It
  works because the DO class is exported from the same entry, but a test or
  build that imports only `tenant-org.ts` runs an alarm with no inventory
  module. Prefer registering next to the others (needs `runInventoryTickForOrg`
  import in `tenant-org.ts`).

### D-05 MEDIUM: migration numbering and `when` collisions on the next upstream sync

- Confidence: medium-high.
- Evidence: menuza numbers = upstream + offset (control plane +10: menuza 0039 =
  upstream 0029; tenant +12: menuza 0032 = upstream 0020). `upstream/main`
  currently ends at control 0029 / tenant 0020. The next upstream migrations
  (control 0030, tenant 0021) will land on top of menuza's inventory 0040 /
  0033-0038. Past syncs renumber and rewrite `when` (0031 `1794192580948` ->
  0032 `1794192581948`, +1000 ms).
- Hazard: Drizzle only applies migrations with `when` greater than the latest
  applied `created_at`. Control plane: last `when` 1794198507000 (0040). Tenant:
  last `when` 1794245121651 (0038). Any synced migration with an older `when`,
  appended after these, is silently skipped on every DB that already applied
  inventory (this is exactly the failure class that produced the
  "sms_send_events skipped" dev DBs). Rule for the sync: renumber after 0040 /
  0038 and set `when` > those values; regenerate snapshots; re-run
  `migration-journal.test.ts`.
- Mitigation now: none blocking; add the rule to the sync checklist (AGENTS.md /
  sync skill).

### D-06 MEDIUM: rollout order is not enforced by CI, and App-before-tenant-api has a real skew bug

- Confidence: high.
- CI facts: `.github/workflows/deploy.yml`: `migrate-control-plane-d1` (D1
  `migrations apply DB --remote`) then `trigger-cf-deploys` fires Workers Builds
  for App, Admin, Sites, web, jobs-cron and tenant-api US in parallel
  (`scripts/trigger-cf-builds.mjs`); `deploy-tenant-api-oci` (KSA, optional
  Ashburn) runs separately and later. Station is not in the `affected` list or
  any deploy job at all (per-brand Pages build, outside this workflow). So the
  AGENTS.md rule "deploy App before tenant-api" is a manual rule only.
- Skew bug (new App, old tenant-api): the Terminals "create pairing code" form
  always sends `inventoryEnabled`
  (`apps/app/app/components/pos/terminals-manager.tsx:1388`, value `false` when
  Stock is not allowed), and the old region's `createCodeSchema` is
  `z.strictObject` (`apps/tenant-api/src/routes/operator-pos.ts:~88-98`). Until
  a node is upgraded, pairing-code creation answers 400 for every org on it (KSA
  OCI lags the US Worker by minutes). The reverse skew (old App, new tenant-api)
  is safe: the `stationApps` reader is lenient (`operator-orders.ts`
  `readStationApps`, missing `inventory` => false, fail closed).
- Fix: send the key only when true
  (`...(inventoryAllowed && inventoryEnabled ? { inventoryEnabled: true } : {})`),
  which also removes the ordering constraint for pairing; keep the claim rule
  for the toggle.

### D-07 MEDIUM: auto-sold-out dishes can be stranded by a data-region switch or deprovision

- Confidence: medium (read from code, not exercised).
- Where: `apps/app/app/routes/resources+/inventory.availability.ts` (only the
  region can ask to give a dish back, matched against its own `inv_sold_out`
  rows) and AGENTS.md ("Changing Customer data region wipes the old tenant DB").
- Scenario: an org has dishes auto-set `unavailable` in the control plane
  (`OrganizationMenuLocationOverride` / item row). The region switch (or
  deprovision) destroys `inv_sold_out`; the new region is empty, so nothing ever
  restores those dishes. The App only restores on a region request. Menu shows
  "unavailable" until a human edits each dish.
- Fix: on deprovision/region switch, either have App clear availability it set
  because of stock (needs a marker, today there is none in the control plane) or
  have the new/old region post a restore-all before the wipe; at minimum
  document it in the runbook and in the region-switch confirmation copy.

### D-08 MEDIUM: invoice-photo storage reuses the call-recording bucket with undocumented requirements

- Confidence: high on docs gap, medium on KSA CORS.
- Where: `apps/tenant-api/.env.schema:62-76` (comment still says "tenant-api
  only deletes expired or erased recordings"; `.env.example:22-26`;
  `docs/launch-checklist.md:319` says "no keys"). Code:
  `apps/tenant-api/src/lib/recording-storage.ts:305` (`presignObjectUpload`),
  `services/inventory-receiving-service.ts:~224`.
- Gaps: (1) the node's S3 credentials must now allow
  PutObject/GetObject/HeadObject/ListObjects/DeleteObject, not delete-only; (2)
  the browser does a presigned cross-origin `PUT` (Content-Type and signed
  content-length) so the bucket needs a CORS rule for the App origin(s) (and
  Station tablets' POS origins for the Stock app photo upload): methods PUT,
  GET, HEAD; allowed headers `content-type` (and `content-length`/`x-amz-*` as
  the provider needs); (3) KSA uses OCI Object Storage over the S3-compat
  endpoint; to my knowledge OCI does not expose bucket CORS configuration, so
  browser-direct PUT may be impossible there without a fronting proxy.
  Unverified, test on the KSA bucket before enabling photos; the node answers
  503 `upload_not_configured` only when the bucket is unset, not when CORS
  blocks it (the user just sees a failed upload); (4) a bucket lifecycle rule
  written for recordings could expire `inventory-invoices/` objects.
- Graceful degradation works (no bucket => 503 `upload_not_configured`, hidden
  reader). Deprovision deletes both prefixes (`deleteOrganizationRecordings`,
  tested).
- Fix: update `.env.schema`/`.env.example` comments, add a "Inventory invoice
  photos" section to the runbook (below), and add `INVOICE_READER_*` and
  `INVENTORY_TICK_INTERVAL_SECONDS` to `.env.example` (see D-10).

### D-09 MEDIUM: `inv_idempotency_keys` rows are never deleted (and store full responses)

- Confidence: high.
- Where: `apps/tenant-api/src/lib/inventory-write.ts:39` (48 h TTL), `:198-212`
  (stores `responseJson`, upserts on conflict); `0033_inventory.sql:133-144`
  creates `idx_inv_idempotency_keys_expires` but no code deletes expired rows
  (only `pruneInventoryOutbox` prunes anything; `inv_alert_log` is also never
  pruned, small).
- Scenario: every idempotent operator write (items, counts, recipes, orders,
  levels, transfers) leaves a row with the full JSON response forever. Slow
  growth inside a per-org Durable Object / SQLite file, wasted storage and
  backup size, larger on recipe/catalogue responses.
- Fix: delete `expires_at < now` in the same tick that prunes the outbox
  (`runInventoryTickForOrg`, next to `pruneInventoryOutbox`), chunked; also add
  `inv_alert_log` rows older than ~90 days with `status='sent'`. Retention
  summary is in the table below.

### D-10 LOW-MEDIUM: env and documentation gaps

- `INVENTORY_TICK_INTERVAL_SECONDS`: in `.env.schema:268` and
  `docs/scheduled-jobs.md:69,210`, but missing from
  `apps/tenant-api/.env.example` (which the KSA/Ashburn hosts copy to `.env`,
  `docker-compose.yml` uses `env_file: .env`) and from AGENTS.md env list (which
  has the reservations/loyalty/staffing equivalents).
- `INVOICE_READER_*` (4 vars): in `.env.schema:130-141`, AGENTS.md and the plan;
  missing from `.env.example`.
- `INVENTORY_ENABLED`: present in `.env.schema`, `.env.example` (commented) and
  AGENTS.md. For the US Worker it is a Workers var/secret (toggle in the
  dashboard, no redeploy needed beyond the var change); for KSA it is `.env` +
  `docker compose up -d` (restart).
- There is no operator runbook doc (staffing.md, reservations.md, loyalty.md,
  qr-ordering.md, print-shop.md all have one). `docs/inventory-plan.md` is a
  plan, `docs/launch-checklist.md` and `docs/security.md` have no inventory
  entry. Write `docs/inventory.md` from the rollout and rollback sections below.
- No App Playwright spec although the plan (inventory-plan.md "Tests and gates")
  promises setup -> count -> delivery -> food cost. Only
  `apps/station/e2e/stock.spec.ts` exists. (E2E not run per rules.)
- `org-router.test.ts` has no case for `INVENTORY_TOKEN_AUDIENCE` routing
  (`workers/org-router.ts:85`); `src/lib/inventory-routing.test.ts` exists and
  passes.

### D-11 LOW: cosmetic / lint

- `apps/tenant-api/src/lib/invoice-reader.ts:27-30`: the
  `// eslint-disable-next-line no-control-regex` sits on the `value` line, not
  the regex line two lines below, so oxlint (and ESLint) warn `no-control-regex`
  (the only inventory warning in the oxlint run). Move the comment or use
  `\p{Cc}`.
- `apps/tenant-api/src/services/inventory-tick-service.ts` (~line 566):
  duplicated doc line "and one not reached waits for a later run
  (`orgsDeferred`). Counts only."
- App ESLint warnings in inventory paths (0 errors):
  `components/inventory/prep-levels-panel.tsx:78` and `prep-screen.tsx:403`
  (`lingui/no-expression-in-message`),
  `components/inventory/sold-out-panel.test.tsx:7` (`import/order`),
  `routes/_app+/$orgSlug_+/inventory+/today.tsx:159`
  (`react-hooks/exhaustive-deps`, `menuDishes`).
- Send-order email is delivered before the DB write
  (`inventory-orders-service.ts` `sendOrder`): a stale `expectedVersion` after
  the email leaves the order a draft though the supplier was emailed, and a
  retry emails again. Documented trade-off in the code comment; mention in the
  runbook.

### Checked and fine (no finding)

- Tenant migrations 0033-0038: all additive. New tables only;
  `ALTER TABLE ... ADD ... DEFAULT ... NOT NULL` only for `inv_items`
  (batch_counted, auto_sold_out),
  `inv_deliveries`/`inv_delivery_lines`/`inv_settings`/`inv_waste` (0034) and
  `pos_devices`/`pos_pairing_codes` (`inventory_enabled`,
  `inventory_disabled_at`), all with safe defaults, so existing orgs are
  unaffected. Largest statement 1.7 KB, no bound parameters, well under DO
  SQLite limits. 0034 drops and recreates `inv_delivery_lines_no_update` around
  a backfill `UPDATE` in one batch, correct.
- Trigger update paths: closed/frozen rules allow the legitimate transitions
  (only `note` clearable on movements/waste; recipe supersede-once; draft-only
  order lines; transfer forward-only; sent lines freeze only the stated
  columns). `inv_transfers_closed_final` blocks any update after close,
  including FK-cascade-style updates, none exist. Actor-id columns are frozen by
  the append-only triggers, which the erasure gate documents as opaque ids (not
  erased), acceptable.
- Journal/snapshots: tenant journal 0-38 and control 0-40 are monotonic in
  `when`, every journal tag has its .sql and snapshot, `prevId` chain of
  snapshots 25-38 (tenant) and 39-40 (control) is unbroken.
- Control-plane `0040_inventory.sql`: follows 0030/0031 precedent (INSERT OR
  IGNORE permissions, `org_role_admin` only, `WHERE NOT EXISTS` system flags
  default false). `setup-roles.ts` mirrors it. `upstream/main` has no inventory
  migration; collision risk is D-05 only.
- DO migration bundle: `workers/migrations.generated.ts` is gitignored but
  `apps/tenant-api/wrangler.jsonc` has
  `"build": {"command": "npm run generate:do-migrations"}`, and `deploy:cf`,
  `build`, `typecheck`, `pretest` all run the generator, so any
  `wrangler deploy` (Workers Builds) regenerates it from the journal. The local
  file contains m0000-m0038. The KSA Node image reads
  `packages/tenant-db/drizzle` directly at runtime (copied in the Dockerfile)
  and migrates lazily per org on first open.
- Person-erasure gate otherwise lists every inventory PII-looking column with
  reasons; supplier contact columns are explicitly classified.
- Deprovision/region switch: `deleteOrganizationRecordings` deletes both
  `recordings` and `inventory-invoices/<org>/` prefixes with a 15 s budget then
  background continuation (tested). The tenant DB itself is wiped by the
  existing deprovision path (see D-07 for control-plane side effects).
- Logging: every inventory `console.*` logs ids, kinds, counts, error
  names/codes (via `errorLogFields`: name, code, stack frames, no message), no
  item names, supplier data, quantities or money. Alerts to the App carry
  `{orgId, eventId, kind, locationId, count}` only.
- jobs-cron: no new cron slot (still `0 2`, `0 3`, `0 4`, `0 * * * *`);
  `Tenant inventory tick` is the last job in the hourly fan-out
  (`apps/jobs-cron/src/index.ts:615`), failures are named; `index.test.ts`
  passes (54). The fan-out wakes each org DO but the per-org work is one local
  `SELECT ... LIMIT 1` on `inv_items` before any outbound call.
- `isTick`-independent Node path: `src/index.ts:65` starts
  `startInventoryTickInterval` (default 300 s, min 60, 0 = off),
  non-overlapping, `unref`ed.
- Station contract skew: `INVENTORY_POS_CONTRACT_VERSION = 1`,
  `INVENTORY_POS_MIN_CONTRACT_VERSION = 1`
  (`packages/inventory/src/contract/station.ts:71-73`). Header missing =>
  treated as 1; value `< MIN` => 400 `contract_too_old` (a pause code, tablet
  stops syncing and shows update-needed); value `>` served version is accepted
  (tablet never runs ahead because Station deploys last); a malformed header =>
  400 `invalid_request`. Old tablets keep working: `/pos/me` `apps` is read
  leniently (`apps/station/src/lib/outbox.ts` `readApps`), Stock tile hidden
  until the node reports `apps.inventory`.

---

## Data retention and purge summary

| Data                                                                                                             | Retention today                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inv_outbox` (settled rows)                                                                                      | pruned after 14 days in every tick (`pruneInventoryOutbox`)                                                                                                                                                                                             |
| `inv_alert_log`                                                                                                  | never pruned (small: digests per day/location); pending rows given up after 3 days or 40 attempts                                                                                                                                                       |
| `inv_idempotency_keys`                                                                                           | expire logically at 48 h, never deleted (D-09)                                                                                                                                                                                                          |
| `inv_movements`, `inv_count_entries`, `inv_waste`, `inv_delivery_lines`, `inv_audit_log`, `inv_recipes` versions | append-only by design, kept forever; `note` columns clearable                                                                                                                                                                                           |
| `inv_sale_usage`                                                                                                 | one row per settled sale line, kept (needed for diffing); grows with sales                                                                                                                                                                              |
| Invoice photos (object storage)                                                                                  | until the delivery photo is replaced, or the org is deprovisioned (prefix delete). No age-based purge                                                                                                                                                   |
| Backups                                                                                                          | KSA: the OCI block volume `/data/tenants` (per-org `tenant_<id>.db` incl. `-wal`); US: Durable Object storage (PITR via Cloudflare, 30 days). Neither covers the object-storage invoice photos; the photo bucket needs its own versioning/backup policy |

---

## Rollout order (exact)

Pre-flight (all flags are off by default, so every step is dark until step 8):

0. Land the fixes for D-01 (blocker) and decide D-02/D-03 (do not ship the
   DO-path hunk). Re-run: `person-erasure-pii-columns`,
   `workers/tenant-org.test.ts`, `src/lib/tenant-org-alarm.test.ts`,
   `migration-journal`. If D-04 or D-06 are fixed, re-run
   `workers/tenant-org.test.ts` and the App `terminals-manager.test.tsx`.
1. Control plane D1 (`0040_inventory`): CI `migrate-control-plane-d1` runs it
   automatically before any deploy trigger. Additive (permission rows,
   `org_role_admin` grants, five system flags = false). Check: `Permission` has
   5 `org_perm_*inventory*` rows; `ConfigFlag` has 5 system `inventory.*` rows =
   `false`.
2. App (and Admin): deploy first so
   `/resources/inventory/{context,notify,availability}`,
   `/<org>/inventory-token` and the `stationApps` claim with
   `inventory`/`inventoryLocationIds` exist. Do not wait for CI parallelism:
   either gate tenant-api's Workers Build trigger until App is live, or ship
   D-06 so skew is harmless.
3. tenant-api US Worker (Workers Build runs `generate:do-migrations` via
   `wrangler.jsonc`): each org DO applies 0033-0038 (about 163 statements) in
   one transaction on its first request after deploy; no downtime, brief
   cold-start cost. Health: `/health`, then hit one org's route.
4. tenant-api KSA (OCI Riyadh) via the CI container job: migrations run lazily
   per org file on first open (`applyTenantMigrations`), and the hourly tick
   plus the 5-minute interval open every org, so all files migrate within the
   hour. Optional: restart and watch logs for `table ... already exists` (only
   possible on dev-machine legacy files). Do KSA only after US is verified.
   Optional OCI Ashburn node follows the same path.
5. Set node env before enabling inventory in prod: `INVENTORY_ENABLED` (leave
   on), `RECORDING_S3_*` with write-capable credentials + CORS on the bucket
   (D-08), optional `INVOICE_READER_*` (KSA: in-region model only,
   `INVOICE_READER_DATA_REGION=ksa`), `INVENTORY_TICK_INTERVAL_SECONDS` (Node
   only), `POS_ORIGINS` includes the Station origin.
6. jobs-cron: deploy after both tenant-apis answer `POST /api/inventory/tick`
   (otherwise the hourly `Tenant inventory tick` logs a 404 per node, harmless
   but noisy). No cron slot change.
7. Station (per-brand Pages build, not in CI `affected`): last. Required order
   is App, tenant-api, Station, so a tablet is never newer than its server.
8. Flags, per organization (Admin config flags, not via migration):
   `inventory.enabled` first, then `inventory.purchasing`, `inventory.recipes`,
   `inventory.prep`, `inventory.transfers` one at a time; grant
   `update:inventory:any` etc. to chosen roles (custom roles and member are not
   granted by the migration). Then switch Stock on per terminal (needs
   location + staff sign-in). Pilot one US and one KSA org for a week before
   wider enablement.

Smoke after each step: operator token mint (`/<org>/inventory-token`),
`GET /operator/inventory/items`, `POST /api/inventory/tick` with `{}` (counts
only), a Station catalogue fetch, one paid order with a recipe then `inv_outbox`
settled.

## Rollback notes

- Migrations are forward-only and additive. Code rollback is safe: an older
  tenant-api sees a DB whose newest `created_at` is ahead of its journal, so
  `migrate` has nothing pending; old code ignores the new tables and defaulted
  columns on `pos_devices`/`pos_pairing_codes`. No down-migration is needed or
  provided.
- Fastest stop, no deploy: (1) org flag `inventory.enabled=false` (App hides UI
  and the region fails closed), or (2) node kill switch
  `INVENTORY_ENABLED=false` (503 `inventory_unavailable` on operator and Station
  routes; sale-side queueing continues, tick keeps settling when flags are
  readable). Revoking a terminal still works. Auto-sold-out dishes are given
  back by the region even with flags off, as long as the node can reach the App.
- Rolling back App while the region is new: inventory UI disappears, region
  routes stay up but unreachable from the UI; alerts to
  `/resources/inventory/notify` fail with 404 and are not retried (counted as
  errors), so keep org flags off during an App rollback.
- Rolling back tenant-api while sales run: sales made during the gap are not
  queued for stock use and are not back-filled when you roll forward; counts
  reconcile it ("expected vs counted").
- Control plane 0040: nothing to undo (flags false); leaving permissions in
  place is harmless.
- Dev machine: after D-02 is fixed or the DBs are removed, nothing else to
  reset.

## Version skew matrix

| Combination                   | Result                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New App, old tenant-api       | Pairing-code creation 400 (D-06); inventory UI errors only for orgs with flags on; flags off => dark                                                                  |
| Old App, new tenant-api       | Safe: claim reads missing `inventory` as false; flags read from App fail closed (`status unknown`: sales outbox left queued, alerts stop)                             |
| New tenant-api, old jobs-cron | Safe: no inventory digests until cron deploys; hourly retry still from Node interval/alarm                                                                            |
| New jobs-cron, old tenant-api | Hourly 404 logged per node, harmless                                                                                                                                  |
| New Station, old tenant-api   | Stock tile hidden (`/pos/me` has no `apps.inventory`); contract header ignored                                                                                        |
| Old Station, new tenant-api   | Works; missing header = version 1; `INVENTORY_POS_MIN_CONTRACT_VERSION` is 1 so nothing is refused. Raising MIN later makes old tablets pause with `contract_too_old` |

---

## PART B: verification run (serial, one at a time, machine was fast this time)

Environment: Node v22.18.0 via Volta, no `timeout` binary on macOS (used
`perl -e 'alarm N; exec @ARGV'`, 1200 s cap).
`NODE_OPTIONS=--localstorage-file=/tmp/vitest-ls` set for the whole chain. All
run from the repo with the commands in the task; logs in
`/private/tmp/claude-501/-Users-zama-menuza/e3a77db0-8812-4ce7-bae0-1ccf5cd0b702/scratchpad/verify/`.

| #   | Command (cwd)                                                                                                                                                                         | Result                                                                                           | Duration |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| 1   | `npx tsc --noEmit -p .` (packages/inventory)                                                                                                                                          | pass, no output                                                                                  | 2 s      |
| 2   | `npx vitest run` (packages/inventory)                                                                                                                                                 | 14 files, 290 tests pass                                                                         | 1 s      |
| 3   | `npx vitest run` (packages/tenant-db)                                                                                                                                                 | 26 files, 267 tests pass                                                                         | 9 s      |
| 4   | `npx tsc --noEmit` (apps/tenant-api)                                                                                                                                                  | pass, no output                                                                                  | 9 s      |
| 5   | `npx vitest run src/routes/operator-inventory`                                                                                                                                        | 12 files, 161 tests pass                                                                         | 6 s      |
| 6   | `npx vitest run src/routes/inventory src/routes/pos-inventory`                                                                                                                        | 5 files, 117 tests pass                                                                          | 22 s     |
| 7   | `npx vitest run src/lib/inventory src/services/inventory src/services/item-sales src/services/pos-apps`                                                                               | 12 files, 100 tests pass                                                                         | 8 s      |
| 8   | `npx tsc --noEmit` (apps/station)                                                                                                                                                     | pass                                                                                             | 7 s      |
| 9   | `npx vitest run src/apps/stock src/apps/kitchen` (apps/station)                                                                                                                       | 16 files, 157 tests pass                                                                         | 11 s     |
| 10  | `node scripts/check-lingui.mjs`                                                                                                                                                       | pass ("Lingui translations complete across all apps")                                            | 15 s     |
| 11  | `npx oxlint packages/inventory apps/tenant-api/src/{routes,lib,services} apps/station/src/apps/{stock,kitchen} apps/app/app/{components/inventory,utils/inventory,routes/resources+}` | 0 errors, 8 warnings, only one inventory-related (`invoice-reader.ts:30` no-control-regex; D-11) | <1 s     |
| 12  | `npm run typecheck -w app`                                                                                                                                                            | pass (react-router typegen + tsc)                                                                | 33 s     |
| 13  | `npx vitest run app/utils/inventory app/components/inventory 'app/routes/_app+/$orgSlug_+/inventory+' app/routes/resources+/inventory` (apps/app)                                     | 63 files, 740 tests pass                                                                         | 26 s     |
| 14  | `npx eslint app/components/inventory app/utils/inventory 'app/routes/_app+/$orgSlug_+/inventory+'` (apps/app)                                                                         | 0 errors, 4 warnings (D-11)                                                                      | 10 s     |

Extra suites I added (all finished):

| Command                                                                                                                                                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run src/lib/tenant-org-alarm.test.ts workers/tenant-org.test.ts workers/provision-region.test.ts` (tenant-api)                                                                   | 2 files FAIL, 25 of 30 tests fail, all `TypeError: db.all is not a function` at `packages/tenant-db/src/migrations.ts:43` = the other session's uncommitted `prepareLegacyInventoryMigration` (not an inventory regression; D-03)                                                                                                                                                                                     |
| `npx vitest run src/services/person-erasure-pii-columns.test.ts src/lib/recording-storage.test.ts workers/org-router.test.ts src/routes/pos-station-contract.test.ts src/routes/pos.test.ts` | 1 FAIL of 188: `inv_transfers.note` unclassified. Inventory regression, D-01 (blocker)                                                                                                                                                                                                                                                                                                                                |
| `npx vitest run src/index.test.ts` (apps/jobs-cron)                                                                                                                                          | 54 pass                                                                                                                                                                                                                                                                                                                                                                                                               |
| Full `npx vitest run` (apps/tenant-api, one run, 253 s)                                                                                                                                      | 267 files: 263 pass, 4 fail; 4566 tests pass, 27 fail, 2 skipped. The 27 = 20 (`tenant-org-alarm`) + 5 (`workers/tenant-org`) uncommitted-helper failures, 1 `person-erasure-pii-columns` (D-01), 1 `zz-review-domain.test.ts` "PROOF-D auto sold-out gives dishes back when the count merely ages out" (a scratch file another reviewer session dropped in and has since removed from disk; not mine, not evaluated) |

Failure classification: 25 failures other-session (uncommitted helper, fixed by
not committing the DO hunk or by mocking `all`/`run`), 1 other-reviewer scratch,
1 genuine inventory regression (D-01). Everything else green. Not run (rules):
Playwright/E2E, db commands, full-repo build, `drizzle-kit generate` (would
write files). Snapshot chain and journal checks were done by script instead.

Counts and hygiene

- Inventory-related test files on the branch (added/changed `*.test.ts[x]` /
  `*.spec.ts` vs main): 138; added test files by area: packages/inventory 14,
  tenant-api 29, app 67, station 12, tenant-db 1; plus 2 Station Playwright
  specs (`apps/station/e2e/stock.spec.ts`, `tablet-refinement.spec.ts`). No App
  Playwright spec.
- `.skip` / `.todo` / `.only` / `xit` / `fit` in changed test files: none found.
- `TODO|FIXME|XXX|HACK` in the 440 non-doc, non-snapshot files changed vs main:
  none found.
- Legacy-DB reproduction (scratch only, no repo or user DB written):
  `legacy/sim.mts` + `legacy/sim2.mts` build a legacy-shaped DB in the
  scratchpad and run the real `applyTenantMigrations`: result with the
  uncommitted helper `APPLY FAILED: table inv_recipes already exists`; with 4
  tables renamed `APPLY OK`, 39 migrations, max created_at 1794245121651.
- Read-only inspection of the dev machine's `packages/database/db/tenant_*.db`
  (via `immutable=1`): 67 DBs, 61 stuck at 35 migrations with legacy tables
  (D-02).
