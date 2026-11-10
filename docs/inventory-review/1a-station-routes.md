# Review 1a: Station /pos/inventory and App inbound inventory routes

Scope: areas (4) and (8) of the brief. Read-only; nothing reproduced with a
running harness (all findings are by reading the code path end to end;
confidence noted per finding). No blockers, no highs.

Counts: blocker 0, high 0, medium 1, low 7.

---

## S-1 (medium, confidence high on mechanism, medium on likelihood) Station delivery replay after 48h posts the stock twice

- Files: `apps/tenant-api/src/lib/inventory-write.ts:166-180` (replay only
  honoured while `existing.expiresAt > now`; TTL `INVENTORY_IDEMPOTENCY_TTL_MS`
  = 48h at line 48), `apps/tenant-api/src/routes/pos-inventory.ts:~395-440`
  (`/deliveries`),
  `apps/tenant-api/src/services/inventory-purchasing-service.ts:939-1110`
  (`recordDelivery`), `packages/tenant-db/src/schema.ts:7694-7782`
  (`inv_deliveries` has no `client_id`; lines use `eventKey: delivery:${lineId}`
  with a fresh `lineId`).
- What is wrong: for a delivery the only duplicate guard is the
  `inv_idempotency_keys` row, which stops counting after 48h.
  `STATION_LATE_SYNC_MS` is also 48h, i.e. the contract itself expects a tablet
  to deliver things 48h+ late. Other writes were hardened for exactly this case
  ("a reused client id after the durable replay record expired"): `logDishWaste`
  (`inventory-dish-waste-service.ts:55-61`), `recordBatch`
  (`inventory-batch-service.ts` event key check), waste
  (`uniq_inv_waste_client`), count entries (`uniq_inv_count_entries_client`),
  orders (`uniq_inv_orders_client`). Deliveries were missed.
- Scenario: tablet posts a delivery, server commits, response is lost (flaky
  network). Tablet stays offline or backing off for more than 48h (closed
  restaurant over a long weekend plus an outage), then retries with the same
  `clientId` and body. The key row is expired, so `fn` runs again: a second
  `inv_deliveries` row, second `delivery` movements (stock doubled), second
  order receipt (`orderStatusAfterReceipt` can mark partly received orders
  received), and later a second price confirmation. Same hole in the operator
  route (`/deliveries`, same `recordDelivery`).
- Secondary instance of the same pattern: Station `count_start` after expiry
  (`startOrJoinCount`): if the first count was approved meanwhile, a replay
  starts a second count for the day instead of answering the first result. Low
  impact.
- Fix: add `client_id` (unique) to `inv_deliveries` (or an event key
  `delivery:<clientId>:<index>` on the movements, as batches do) and make
  `recordDelivery` answer "duplicate" from it; or make idempotency rows for
  Station writes live at least as long as the late-sync window plus the longest
  queue age (e.g. 30 days) and prune by `expiresAt` (see S-2).
- Regression test: in `pos-inventory.test.ts`, post a delivery, advance
  `posInventoryDeps.now` / the write clock by 49h, replay the same body: expect
  `duplicate: true` and one delivery row, one movement per line.

## S-2 (low, confidence high) `inv_idempotency_keys` is never pruned

- Files: `apps/tenant-api/src/lib/inventory-write.ts:199-215`;
  `grep invIdempotencyKeys` finds no delete anywhere (the tick service prunes
  outbox and alert rows only).
- What is wrong: every idempotent write leaves a row holding the full
  `responseJson` (for a delivery, the whole delivery detail; for the
  catalog-sized `count_start`, a count summary) forever. Expired rows are only
  overwritten when the same key comes again.
- Scenario: a Station doing hundreds of idempotent writes a day grows the
  per-org Durable Object / SQLite file without bound (DO storage is capped per
  object).
- Fix: prune `expires_at < now` in `processInventoryOutbox` / the tick (the
  `idx_inv_idempotency_keys_expires` index already exists). If S-1 is fixed by
  lengthening the TTL, pruning becomes necessary.
- Test: tick test that seeds an expired and a live key and expects only the
  expired one removed.

## S-3 (low, confidence high by reading, not reproduced) A duplicate `clientId` inside one waste batch is a 500, and the tablet retries it forever

- Files: `apps/tenant-api/src/services/inventory-waste-service.ts:109-215`
  (`byClient` is built from rows already in the DB only; the in-batch duplicate
  is never detected), `packages/tenant-db/src/schema.ts:7866`
  (`uniq_inv_waste_client`), `apps/tenant-api/src/lib/inventory-write.ts:89-106`
  (no mapping for `uniq_inv_waste_client`),
  `packages/inventory/src/contract/station.ts:192` (`internal_error` action is
  `retry`).
- Scenario: a batch with two entries sharing a `clientId` (client bug, or a
  hand-crafted request): the second insert violates the unique index, the whole
  transaction rolls back, the route answers `internal_error` 500. The tablet
  queue treats 500 as retry, so that batch never clears and blocks later waste
  behind it. `addCountEntries` handles the same case (`taken.add`); waste does
  not. The same code serves the operator route (500 there too).
- Fix: in `logWaste` track `seen` clientIds within the request (treat later ones
  as `duplicates`, or refuse the request with `invalid_request` and a
  `superRefine` on `logWasteSchema` / `stationWasteSchema` for unique
  `clientId`s). Optionally map `uniq_inv_waste_client` to
  `idempotency_conflict`.
- Test: POST `/pos/inventory/waste` with two entries of the same `clientId`:
  expect 200 with one accepted and one duplicate (or 400), never 500.

## S-4 (low, confidence high) `madeBy` attribution is unauthenticated, and only count entries and waste record who synced it

- Files: `routes/pos-inventory.ts:~100-125` (`actorsFor`), `:208-233, 358-440`;
  `services/pos-inventory-service.ts:58-69`; `inventory-purchasing-service.ts`
  audit `delivery.record` (detail has no `syncedBy`);
  `inventory-counts-service.ts` `count.start` / `count.send` audits (no
  `syncedBy`).
- What is wrong: any signed-in staff member can name any active roster member of
  the terminal as `madeBy`; the route doc says the audit trail records who
  synced it, but that is true only for `count.entries` and `waste.log`. For
  deliveries (`receivedById`, movements actor, audit), count start and count
  send, the named person is recorded as the actor with no trace of the real
  session person.
- Scenario: staff A receives a delivery (needs `anyStaffCanReceive` or a manager
  session) and files it under staff B; or sends a count for review as B. Nothing
  in `inv_audit_log` or `inv_movements` points to A. Receive permission is
  judged on the session (correct), but accountability is lost.
- Fix: pass `syncedBy: ctx.session.staffId` into `recordDelivery` /
  `startOrJoinCount` / `sendCountForReview` audit detail whenever
  `actor.id !== session`.
- Test: post a delivery with `madeBy` = another roster member; assert audit
  detail contains `syncedBy` = session staff.

## S-5 (low, confidence high) `madeAt` has no lower bound, so waste and deliveries can be booked to any past business date

- Files: `packages/inventory/src/contract/station.ts:276`
  (`madeAt: z.number().int().positive().optional()`),
  `inventory-waste-service.ts:179-188`,
  `inventory-purchasing-service.ts:1083-1088`.
- What is wrong: the future is clamped (`Math.min(madeAt, ctx.now)`), the past
  is not. `madeAt: 1` yields business date 1970-01-01 (flagged `lateSync`, but
  still stored with that date, and delivery `receivedAt = 1` which also orders
  the cost history and price-rise search). Stock movement time (`createdAt`)
  stays real, so on-hand and count-review math is unaffected; reports by
  `businessDate` (waste week, purchases for food cost) shift.
- Scenario: a staff member (or a tablet with a dead clock that restarted at
  epoch) moves waste out of the current week's waste/food-cost figures into a
  date nobody reports on, flagged only in a `lateSync` list a manager must read.
- Fix: refuse (or clamp and flag) `madeAt` older than a sane maximum, e.g. 14 to
  30 days, and for a clamp keep `lateSync: true`.
- Test: waste entry with `madeAt: 1`: expect clamped business date or `refused`.

## S-6 (low, confidence high) Invoice photo of any Station delivery can be replaced, and the old object deleted, by any staff allowed to receive; presigned uploads are unbounded

- Files: `routes/pos-inventory.ts:~470-520` (`assertStationDelivery`),
  `inventory-receiving-service.ts:216-330` (`requestInvoicePhotoUpload`,
  `confirmInvoicePhoto`).
- What is wrong: the only state check is `status === 'received'` and
  `source === 'station'`. There is no age limit and no check for
  `pricesConfirmedAt` or `paidAt`. Confirming a new key replaces `photoKey` and
  schedules `deleteRecordingObject(previous)` after commit. Also
  `requestInvoicePhotoUpload` has no per-delivery or per-org cap: each call
  presigns a 10 minute PUT of up to 5 MB under a fresh random key, and
  unconfirmed uploads are never swept. The audit row `delivery.photo` records
  only `replaced`.
- Scenario: a staff member (with `anyStaffCanReceive` on) swaps the scanned
  invoice of a delivery that the office already priced and paid; the original
  evidence is deleted. Or loops on the presign endpoint (600 req/min/IP) and
  uploads junk to the bucket, which is never cleaned.
- Fix: for Station, refuse photo changes once `pricesConfirmedAt` or `paidAt` is
  set (or after N hours), and keep the old object when replaced by a Station
  caller (or log its key in the audit). Cap presigns per delivery (for
  example 5) and sweep objects under `inventory-invoices/<org>/<delivery>/` not
  equal to `photoKey` in the tick.
- Test: confirm photo, mark prices confirmed, then request a Station photo
  upload: expect refusal; presign 6 times: 6th refused.

## S-7 (low, confidence high) `/resources/inventory/availability`: `since` is optional on a restore, and the internal token is org-agnostic

- Files: `packages/inventory/src/contract/sold-out.ts:33-45` (`since` optional),
  `apps/app/app/routes/resources+/inventory.availability.ts:~215-235`
  (`restorable`: `change.since === undefined` returns true).
- What is wrong: the stated guarantee is that the App only gives back what the
  region took off and nobody changed by hand since. With `since` omitted, any
  dish that is `unavailable` (including a manager's manual "unavailable") is
  made available. The region always sends `since`, so only a different caller of
  the shared `INTERNAL_COMMAND_TOKEN` benefits; and that token is shared by
  every node (US and KSA) and every org, and `orgId` comes from the request
  body, so a compromised KSA node can change availability of, or notify managers
  in, a US-region org (same for `/resources/inventory/context`, which reveals
  only flags). This is the repo-wide trust model, so only the `since` part is
  actionable.
- Fix: refine the schema: `available === true` requires `since`; reject
  otherwise with 400.
- Test: `inventory.availability.test.ts`: restore without `since` returns 400,
  or `applied: []`.

## S-8 (low, confidence medium) Notify claims the member's row before sending the email, so a failed or aborted send is never retried

- File: `apps/app/app/routes/resources+/inventory.notify.ts:~150-215`.
- What is wrong: the `Notification` insert (unique on user, org, type, entityId,
  which does give correct dedupe) is the claim and happens before `sendEmail`.
  If `sendEmail` errors, or the request is cancelled because the region's
  `AbortSignal.timeout(8_000)` (`lib/inventory-notify.ts:51`) fires while the
  loop is still sending sequentially (up to 200 recipients, one
  `await sendEmail` each), the member's row exists, so the retry skips them and
  the email is lost. The App still answers 200, so the region records `sent`.
  In-app copy is unaffected when `inApp` is on.
- Fix: send emails first or in bounded parallel batches, and on a send error
  delete the claim (or write the marker only after a successful send); lower
  `MAX_ALERT_RECIPIENTS` for email or move the loop to `waitUntil`.
- Test: stub `sendEmail` to reject once; expect the retry of the same event to
  email that member.

## S-9 (low, informational, confidence high) Station catalog does the heavy reads on every poll

- File: `apps/tenant-api/src/services/pos-inventory-service.ts:106-185`,
  `inventory-items-service.ts:131` (`loadLocationStock`).
- `buildStationCatalog` reads every item, unit, cost row (`invItemCosts`, unused
  because `cost: false`), on-hand and last-count map for the location, plus up
  to 100 `getReceivePrefill` calls (N+1, bounded by `openOrdersPerLocation`).
  Combined with an ETag that is computed after all that work (a 304 saves
  bandwidth, not region CPU), several tablets refreshing every few minutes is
  wasted Durable Object time. Not exploitable beyond the 600/min/IP limit. Fix:
  skip `invItemCosts` and `onHandByItem` for the Station build, and prefetch the
  order lines in one query.

---

## What I checked and found no problem with

Station (`routes/pos-inventory.ts`, `lib/pos-inventory-http.ts`,
`services/pos-apps-service.ts`, `services/pos-inventory-service.ts`):

- Envelope order: device secret (constant-time hash compare, revoked, kill
  switch), contract version, Stock gate (terminal switch, sign-in required,
  location bound, org flag via `getInventoryFlagState` which fails closed, node
  kill switch), location equality for every named location (`wrong_location`),
  then staff session. Session is bound to org and device, requires active
  assignment at the terminal scope, PIN not cleared, `iat` after PIN change
  (`pos-staff-session.ts`). `device.scopeId` is already resolved via
  `posStaffScopeId` in `authenticatePosDevice`.
- Cross-location and cross-org: caller is `locationIds: [gate.locationId]`,
  `cost: false`, `purchasing: false`. Record-addressed routes (`counts/:id`,
  `entries`, `send`, prep tasks, delivery photo) load the record and run
  `assertLocationAllowed` on the record's own location; `location_forbidden` is
  mapped to `not_found`. Count start checks the list's location. Delivery order
  link checks `order.locationId`. Org isolation is by per-org DB.
- Catalog: parsed by `stationCatalogSchema` (non-strict zod strips extras);
  items, areas, lists, suppliers (names only), products (no price), expected
  deliveries (price fields omitted), counts (no money fields); no on-hand or
  expected figures; count sheet shows only counted totals and `mine`.
- Receive gate (`receive: true`) judged on the session (manager or
  `anyStaffCanReceive`); `paid` forced false, `quantityOnly` forced true;
  delivery body schema is strict and has no money fields.
- Undo rules (`undoWaste` station branch): own entry, same device, source
  `station`, same actor, server window from `original.createdAt`, durable
  `clientId` replay check, `uniq_inv_waste_reverses` plus `already_undone`
  check; reversing movement has a unique event key.
- Future `madeAt` clamped to now; count entries ignore `madeAt`; batch caps (200
  count entries, 50 waste entries, 50 dish lines, 200 delivery lines); body
  limits (global 1 MB `bodyLimit` in `app.ts` plus 256 KB check in `readJson`);
  `/pos/*` rate limit 600 per minute per IP.
- Prep routes: every task action runs `loadTask` with the location check; done
  is idempotent per actor and task and joins one transaction with the batch;
  Station prep and dish waste gated on `prep` and `recipes` flags.
- Photo key: server-chosen, `parsePhotoKey` requires
  `<prefix>/<orgId>/<deliveryId>/<uuid>.(jpg|png|webp)`, content type and length
  signed into the presign, confirm re-checks size and type via HEAD. No SSRF
  surface (URLs come only from storage config).
- CORS: `/pos/*` allowed for POS origins and registered analytics origins; every
  route still needs the device secret.
- `POST /api/inventory/tick`: timing-safe internal token compare, per-minute
  rate limit, strict body.

App inbound routes (`inventory.context.ts`, `inventory.notify.ts`,
`inventory.availability.ts`, `lib/inventory-{context,notify,availability}.ts`):

- `requireInternalCommandAuth` hashes both sides with SHA-256 and uses
  `timingSafeEqual`; placeholder secret refused; 401 passes through.
- Strict zod schemas on all three; notify and availability payloads carry ids
  and counts only (no PII, no money); in-app payload is kind, location id,
  count, org slug, location name.
- Org mismatch: organization must exist, be active and (notify and availability)
  provisioned; availability checks that each entity belongs to the org and the
  location to the org (or `main` when the org has no locations); notify checks
  the location the same way.
- Dedupe: unique index `Notification_userId_organizationId_type_entityId_key`
  backs `onConflictDoNothing`; event id is a region-side SHA-256 hex; marker
  type used when in-app is off.
- Flag handling: literal `true` folding; notify skips with 200 when off;
  take-off needs `enabled` and `recipes`, give-back always allowed; restore
  grace window logic is consistent with the region setting `soldAt` before the
  call.
- Region side: `redirect: 'error'`, 2s/8s timeouts, base URL from env only (no
  SSRF), flag cache with fail-closed stale rules (on 15 min, off 24h), single
  in-flight request per org, 30s failure cooldown, `generation` guard against
  refilling after invalidate, node kill switch short-circuits.
