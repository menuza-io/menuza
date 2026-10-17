# Engine notes (availability, assignment, time, write path)

What belongs here: the normative algorithms, constants, invariants, DST rules,
test targets and edge cases for `@repo/reservations` and the tenant-api write
path.

What does NOT belong here: table columns and route lists (see
`architecture.md`), UI behavior (see `app-ui-patterns.md`), payment flows (see
`payments-reference.md`).

Precedence: `mission.md` > `architecture.md` > this file > raw research. Where
research and the architecture disagree, the architecture value is given and the
research value is noted as superseded.

## Model

- Hybrid model. Concrete tables + turn times are the hard constraint ("does it
  fit"). Overlays can only remove availability, never add it: pacing per
  interval, optional rolling pacing, optional concurrent-covers cap, online
  allocation (per-service table availability, online cap per interval, online
  party max), online booking window inside a service.
- Simple mode (no floor plan) is the same engine with one virtual pool
  constrained by the concurrent-covers cap plus pacing.
- Search is a hint; the write path decides. Every capacity change re-validates
  inside one serialized transaction. The overlap trigger is a safety net, not
  the mechanism.
- The engine is pure: inputs -> results, `now` injected, no I/O, no UI strings.
  It lives in `@repo/reservations` and is shared by tenant-api, App and Sites.

## Domain API surface (from the architecture)

`resolveServices`, `buildDayState`, `searchAvailability`, `alternatives`,
`calendarSummary`, `planBooking` (mode `search` | `book`, returns
`{ unit: { tableIds, comboId? }, moves }`), `reflow`, `validateConfig`,
`detectConflicts`, `quoteWait`; state machine `quickActionsFor`; policy
`selectPolicy`, `snapshotPolicy`, `cancellationTerms`, `noShowFee`; messages
`scheduleFor`, `dedupeKey`, `channelsFor`. See `architecture.md` for exact
signatures.

## Channels

- Guest channels (all online rules apply): `online`, `native`, `voice_agent`.
- Staff channels: `phone`, `host`, `walk_in`, `waitlist`. For staff, pacing is a
  warning, not a filter; lead time, same-day cutoff and online windows do not
  apply; `walk_in_only` tables are allowed only for `walk_in` and `waitlist`.
- `rsv_reservations.channel` values: `online`, `phone`, `host`, `walk_in`,
  `waitlist`, `voice_agent`, `native`. `X-Client: ios|android` sets `native`.

## Service resolution precedence (most specific wins)

1. Location disabled or org flag off -> nothing.
2. Special day `closed` covering the date -> closed (all services).
3. Special day `replace` -> only its services.
4. Special day `modified` for a service -> template service with patched fields.
5. Special day `online_closed` -> services exist, guest channels excluded.
6. Weekly template whose effective range covers the date (latest
   `effective_from`, then highest `priority`).
7. Within a service: time-period setting > service setting > location default.
8. Blocks and allocations apply after services are resolved.

Overlapping services on one date are allowed; occupancy is per physical table
regardless of service, pacing is per service. A reservation spanning two
services counts pacing only in its start service.

## Availability algorithm (normative pseudocode, condensed)

```text
searchAvailability(req, now):
  if location disabled: []
  if guest channel and partySize > onlinePartyMax: { largeParty, slots: [] }
  if not withinHorizon(date, now): []
  for svc in resolveServices(date) open to channel:
    turnMs = turnMinutes(svc, partySize) * 60_000
    for m in firstSeatingMin..lastSeatingMin step intervalMin:
      startAt = localToInstant(date, m, tz, { gap: 'skip', overlap: 'earlier' })
      skip if startAt null (DST gap) or already seen (repeated hour)
      skip if m outside the channel's booking window
      skip if startAt - now < minLead (guest channels)
      skip if sameDayCutoffPassed (guest channels)
      endAt = startAt + turnMs; skip if endAt > svc end and overrun not allowed
      skip if not pacingOk; skip if not concurrentCoversOk
      fit = findTableFit(day, svc, req, startAt, endAt, SEARCH); skip if null
      emit { startAt, localMin: m, serviceId, areaIds: fit.feasibleAreas }

pacingOk(day, svc, m, p, channel):
  staff channel -> true (warning only)
  bucket = floor(m / bucketMin) * bucketMin
  covers + p <= maxCovers; parties + 1 <= maxParties   (bookings + live holds)
  every rolling window containing m: covers + p <= rollingMaxCovers
  guest channel: onlineCovers + p <= onlineCapPerInterval

findTableFit(day, svc, req, s, e, mode):
  occEnd = e + resetBuffer
  units = tables and combos where min <= p <= max, area allowed for service and
          channel, area matches if requested, online-bookable for guest channels
  direct = units whose every table is free on [s, occEnd)
  if direct: best(direct)
  else for u in sortByScore(units): tryRepair(day, u, s, occEnd, depth 2, budget)

withinHorizon(date, now):
  today = currentBusinessDate(now, tz, dayStartMin)
  date >= today and date <= today + horizonDays
  (minus 1 day while local now < releaseLocalMin)

sameDayCutoffPassed(date, svc, now):
  staff -> false; date != today -> false
  local now >= sameDayCutoffMin -> true
```

- Half-open intervals `[start, end)` everywhere: a booking ending 19:30 and one
  starting 19:30 do not conflict.
- `isFree(table, s, e)` checks active reservation occupancies, live holds,
  blocks and the predicted overrun of seated parties.
- A day load includes the previous business date's reservations whose `end_at`
  reaches into this date.
- Alternatives: same-day nearby slots, then other dates
  (`{ date, firstLocalMin }`), then notify-me and waitlist (same day) offers.
- Calendar summary: per-date `{ hasAvailability, firstSlot, lastSlot }` for a
  party size, cached under `(location, business_date, day_version)`. Public
  calendar range is at most 62 days.

## Scoring (greedy weighted best fit)

`score = 10*waste + comboPen + protectPen + areaPen + fragPen - prioBonus`,
lowest wins.

| Term                                                   | Default                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Wasted seats (`max_covers - party`)                    | 10 per seat                                                                                    |
| Combination                                            | 25, plus 10 per table beyond 2                                                                 |
| Area preference mismatch (soft preference)             | 40                                                                                             |
| Dead gap (residual gap shorter than the shortest turn) | 30 per gap                                                                                     |
| Large-table protection                                 | 60 when expected large-party demand exceeds remaining large units, else 10 (0 for small units) |
| Table priority                                         | 5 per rank (bonus; higher `priority` = preferred)                                              |

Weights are constants, not settings. Prefer single tables over combinations,
small combinations over large, tight time gaps, no unsellable slivers, and
stability (do not move bookings needlessly).

## Bounded repair and reflow

- Repair (augmenting path, depth 2): claim the target unit in a copy-on-write
  shadow, move each blocker (largest party first) to a direct fit, or recurse
  once. Abort if any blocker is immovable or the budget is exhausted.
- Movable = `assignment = soft`, not arrived or seated, outside `freeze_min`
  (default 30) of start, new unit respects its strict area preference.
- Locked assignments and in-service parties are never moved by any automatic
  process (invariant I5). Dragging a locked party asks "Unlock and move?".
- Reflow runs after seat, move, extend (resize), party-size change, block and
  table archive. It moves only soft, future, outside-freeze reservations, logs
  `auto_reassigned` events, and surfaces moves to hosts (never to guests).
- A host drop onto an occupied table offers: swap, move the other party (if
  soft), or overbook (explicit).
- Budgets (node expansions, counted and asserted in tests): search 200 per slot,
  book 2000, reflow 5000 per call. Search may be pessimistic, never optimistic.
- The background re-optimizer is out of scope.

## Feasibility and unassigned bookings

- Every active, non-overbook reservation has a concrete, non-overlapping
  assignment (sound, incomplete: the engine never overbooks but may miss a
  squeeze-in an exact solver finds; hosts can squeeze in manually).
- Staff overbook: `overbooked = 1`, audited, occupancy rows with `overbook = 1`
  skip the trigger but still count as occupying their tables.
- Online never borrows (I3): an unplaceable overbook or unassigned booking
  closes online availability for the windows and units it could use. Simplest
  correct rule: close online for that service window and show it in the conflict
  panel.

## Occupancy and database safety net

- One table `rsv_table_occupancies` for reservations, holds and blocks (`kind`
  `reservation` | `hold` | `block`), `active`, `overbook`, `[start_at, end_at)`
  including reset buffer.
- Hand-appended `BEFORE INSERT` and `BEFORE UPDATE` triggers abort on overlap of
  active, non-overbook rows on the same table. Repairs deactivate or shorten old
  rows before inserting new rows. Expired holds are swept at the start of every
  write transaction so they never trip the trigger. A trigger abort maps to
  `409 conflict` and is logged as an engine-bug metric.
- Finish sets `end_at = max(start_at + 1, finished_at)`; cancel, no-show and
  expire set `active = 0`; hold conversion updates the row in place (kind and
  owner id) so the interval does not change.
- Superseded research: the engineering notes put the trigger on
  `rsv_reservation_tables` and `rsv_hold_tables`. The architecture uses the
  single occupancy table.

## Holds

- Created when the guest picks a time, before OTP and details. Default 7 min
  (`hold_minutes` 3..20); extended to `payment_hold_minutes` (default 20,
  10..60) when payment is required. Research suggested 15-30 min; the
  architecture value wins.
- A live hold consumes capacity exactly like a booking; an expired hold consumes
  nothing whether or not it was swept (I4). Expiry is lazy (`expires_at > now`
  in every query) plus sweeps in writes and the tick.
- Random 128-bit hold token, stored as a hash. `replaceHoldToken` releases the
  previous hold; one active hold per token. Caps: 10 per IP hash per 10 min
  (durable), at most 300 active per org.
- `rsv_reservations.hold_id` is unique and a trigger forbids changing a
  `converted` hold, so a hold converts at most once. Conversion re-validates
  (pacing or blocks may have changed); a valid hold wins against everything
  except a staff overbook; on failure `409 slot_unavailable` with alternatives.
- Late payment success after expiry re-runs the plan inside the gate: fits ->
  book; else `payment_status = review`, automatic refund request, guest message,
  manager alert.

## Write path (`withReservationWrite`)

```text
outside the lock: context facts, Turnstile, request hash, token parsing (all network I/O)
runExclusive(orgId) -> retryOnSqliteBusy -> db.transaction:
  sweepExpired (holds, pending payments, requests, waitlist offers)
  checkIdempotency -> replay if found
  loadDayState fresh inside the tx
  fn(tx, day): re-validate with the engine, write rows
  bumpDayVersions; appendEvents; enqueueMessages; storeIdempotency
after commit: drop day cache, best-effort immediate sends, notify-me dirty flag, journey triggers
```

- No network I/O inside the transaction: the Durable Object yields at every
  `await`, so interleaving would break re-validation.
- Expected-version check on every operator mutation: mismatch ->
  `409 stale_version` with the fresh row. Idempotent-by-nature transitions (seat
  when already seated) succeed.
- Idempotency: `Idempotency-Key` header on creates; `rsv_idempotency_keys`
  stores ids (not bodies), 48 h. Same key + same hash = same result; same key +
  different hash = `409 idempotency_conflict` (research said 422; superseded).
- Day cache: `Map<orgId:locationId:date, { version, state }>`; every read
  compares the persisted `rsv_day_versions.version`, so it is exact on both
  runtimes.
- ETag `"<dayVersion>.<settingsVersion>"`; `If-None-Match` -> 304;
  `/changes?since=` is the cheapest probe. No WebSockets (research "WebSocket
  later" is superseded).

## State machine

Statuses: `requested`, `pending_payment`, `booked`, `confirmed`,
`partially_arrived`, `arrived`, `partially_seated`, `seated`, `finished`,
`cancelled`, `no_show`, `declined`, `expired`.

- Capacity consumed: `pending_payment` (until `payment_expires_at`), `booked`,
  `confirmed`, `partially_arrived`, `arrived`, `partially_seated`, `seated`;
  `requested` only when `request_holds_capacity` (default on, deadline 24 h).
  Released on `finished` (from `finished_at`), `cancelled`, `no_show`,
  `declined`, `expired`.
- Key transitions: new -> `requested` | `pending_payment` | `booked` | `seated`
  (walk-in); `requested` -> `booked` | `pending_payment` | `declined` (approve
  re-validates) or `expired`; `pending_payment` -> `booked` | `expired`;
  `booked` -> `confirmed`; arrival and seating moves forward only;
  `seated`/`partially_seated` -> `finished`; cancel allowed from pre-arrival
  states (guest only before start) and by operator from arrived states;
  `booked`/`confirmed` -> `no_show` (operator, or system when
  `auto_no_show_after_min` is set).
- Undo: `no_show` -> `booked` | `seated`; `finished` -> `seated` within 30 min;
  `seated` -> `arrived`; `cancelled` -> `booked` (reinstate). Every undo
  re-validates.
- Side fields: `contact_status` (pre-arrival only, when enabled),
  `running_late_min` (guest via manage link, or operator), `course_status`
  (while seated, only when enabled). Derived only: late (past start +
  `late_grace_min`, default 15), running long.
- Modify (time, date, party, area, duration) is not a status change: re-plan
  excluding the reservation's own occupancy and swap atomically; failure changes
  nothing (I6). Same slot = no-op, no messages. Time/date change bumps
  `schedule_version`.
- Auto no-show never charges a fee.

## Time (DST-safe rules)

- Rules are local wall-clock minutes from the business-date start (may exceed
  1440). Reservations store intent `business_date` + `local_start_min` +
  `time_zone`; `start_at`/`end_at` are derived epoch ms (I11).
- Business date starts at `day_start_min` (default 240 = 04:00). A 00:30 booking
  after a late service has `local_start_min = 1470` on the previous business
  date. "Today" = `currentBusinessDate(now, tz, dayStartMin)` on the server with
  an injected clock, never the browser clock.
- Durations are elapsed time: `end_at = start_at + duration`.
- Slots: `localToInstant(..., { gap: 'skip', overlap: 'earlier' })` -
  nonexistent local times are skipped (never shifted, which would duplicate
  03:00 and double pacing); repeated local times shown once at the earlier
  offset; pacing per local minute applies once.
- Service ends: `{ gap: 'after', overlap: 'later' }` so a service is not
  shortened.
- Lead time and cancellation windows are instant-based; release time and
  same-day cutoff are wall-clock.
- `@repo/zoned-time` is `packages/staffing/src/tz.ts` moved unchanged
  (`localParts`, `tzOffsetMs`, `zonedLocalToUtc`, `addDays`, `dayOfWeek`,
  `businessDayStartMs`, `businessDateOf`, ...). Its `zonedLocalToUtc` already
  resolves a gap to "after the gap by the gap length" (02:30 -> 03:30) and an
  overlap to the earlier instant; `localToInstant` must add the explicit `skip`
  and `later` modes on top. The research sentence "a service ending at 02:30
  ends at 03:00" contradicts Temporal `compatible` (03:30); write a test that
  pins whichever the architecture chooses.
- Time-zone changes on a location: admin re-derive action for future
  reservations, confirmed by the operator, never silent.

### DST test dates

| Zone                  | Dates                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `America/New_York`    | fall back 2026-11-01, spring forward 2027-03-14 (also 2026-03-08, 2027-11-07)                       |
| `America/Los_Angeles` | same dates as New York                                                                              |
| `Europe/London`       | fall back 2026-10-25, spring forward 2027-03-28                                                     |
| `Asia/Riyadh`         | no DST (UTC+3); Ramadan iftar/suhoor services cross midnight and are modelled as dated special days |

Also test: services crossing midnight on DST nights, horizon at release time
+/-1 ms, business-date boundary at `day_start_min` +/-1 min, reminders scheduled
across DST. (Research also listed `Australia/Lord_Howe`; optional.)

## Waitlist quoting (`quoteWait`)

1. Per table predicted free time: seated -> `seated_at + predicted turn`
   (historical median by party bucket, service, day of week; fall back to
   configured turn).
2. Exclude tables whose free window collides with upcoming reservations.
3. Simulate the queue in order, each party taking the earliest fitting unit.
4. Quote = simulated wait rounded up to 5 min plus a buffer; log quoted vs
   actual for reports.

Notified entries get `waitlist_response_min` (default 10) before `no_response`.
Notify-me: matching runs for dates with `availability_increased_at`, notifies
FIFO first 3 per slot, next batch after 15 min.

## Error codes (stable, from `errors.ts`)

`no_fit`, `slot_unavailable`, `hold_expired`, `stale_version`,
`idempotency_conflict`, `outside_horizon`, `large_party`, `policy_required`,
`policy_unavailable`, `rate_limited`, `not_found`, `unavailable`, `conflict`,
`region_mismatch`. Errors are `{ error: '<code>', ...extra }`; validation errors
never echo rejected values. Public routes answer uniform `404 not_found` for
anything that would reveal existence, `503 unavailable` when the kill switch is
off or context is unreachable.

## Messages

Default quiet hours are 21:00-08:00 location time. Scheduled sends move earlier
out of the window (never later) and are skipped when they would land too near
the start; immediate kinds (confirmation) are never delayed (`architecture.md`
§9.4, `VAL-MSG-016`).

## Invariants to property-test (I1-I11)

I1 seating witness (occupancy, or explicit overbook, or table-less experience
cap); I2 no double booking; I3 online never borrows; I4 holds count while live;
I5 locked never moves; I6 atomic modify; I7 search/book agreement (any searched
slot can be held immediately with the same state and clock); I8 monotonic
release; I9 append-only history; I10 idempotent effects; I11 time intent is the
source of truth.

## Test targets

- fast-check property tests: random floor plans, combos, rule sets and operation
  sequences (search, hold, book, modify, cancel, seat, finish, no-show, block,
  edit rules, advance clock), asserting the invariants after every step.
- Brute-force oracle on small instances (at most 8 tables, 12 bookings): the
  engine never accepts an infeasible set; report (do not fail on) the
  false-negative rate.
- Performance fixture: 120 tables, 80 combos, 900 bookings per day, 60-day
  horizon. Targets: single-day search < 5 ms warm / < 50 ms cold, 60-day
  calendar < 150 ms warm, booking transaction < 20 ms. Assert operation counts
  (units scanned, repair nodes) in CI, not wall clock.
- Concurrency on real SQLite files: N parallel books for the last table ->
  exactly one success; host move vs online book; webhook after hold expiry; tick
  sweep during booking; idempotent replay; stale version -> 409.

## Edge-case catalog (condensed from the 60 research cases)

| #     | Case                                                                                                                                                             | Expected                                                                                                                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-3   | Simultaneous holds on the last table; double-click Book; same body with different keys                                                                           | First wins, loser gets alternatives; one reservation; second conversion fails (hold already converted)                                                                                                                                                        |
| 4-5   | Hold expires during OTP; payment after expiry and resale                                                                                                         | Re-validate and book if still free; never overbook, refund, notify, log                                                                                                                                                                                       |
| 6     | Host drag vs online claim                                                                                                                                        | Serialized; loser gets 409 (host) or alternatives (guest)                                                                                                                                                                                                     |
| 7-11  | Spring forward slots; fall back slots; 90-min dinner over fall back; 22:00-02:00 service on DST night; 00:30 booking                                             | Skipped; shown once; elapsed end; one business date; `local_start_min = 1470`                                                                                                                                                                                 |
| 12-15 | 03:59 with day start 04:00; release 10:00 at 09:59:59; cutoff 15:00 at 15:00; lead 60 at 17:01 for 18:00                                                         | Previous business date; not yet bookable; online closed, host can book; hidden online, staff can book                                                                                                                                                         |
| 16-19 | Party 0 / 500; party 9 with online max 8; party 7 only via combo; party 2 with only a 6-top and high large demand                                                | 400; large-party flow; combo offered; protection rule decides online, staff can still book                                                                                                                                                                    |
| 20-21 | Combo overlaps a booked member; repair would move locked or seated                                                                                               | Repair may move a movable single; otherwise unavailable                                                                                                                                                                                                       |
| 22-27 | Table removed with future bookings; template shortens service; closed day with bookings; `modified` + `closed`; overlapping templates; turn table missing a size | Conflicts listed, bookings unassigned and reflowed; bookings unchanged + conflict list; online closes, operator cancels with notification; `closed` wins; latest `effective_from` then priority; save rejected, runtime falls back to largest bucket and logs |
| 28-31 | Modify 2 -> 4; modify to same slot; guest cancels after start; late cancel with guarantee                                                                        | Re-validate excluding own occupancy, original kept on failure; no-op; rejected for guest; cancelled, fee pending staff confirmation                                                                                                                           |
| 32-37 | No-show then arrives; early finish; running 40 min long; walk-in before a reservation; partial arrival; 6 arrive instead of 4                                    | Undo if free, else reassign or overbook; availability reopens; next booking reflowed or host alerted; warning, override or reduced turn; `partially_arrived` holds the table; edit party, reassign, pacing warning                                            |
| 38-43 | Reminder then move; reminder in quiet hours; tick runs twice; SMS for KSA; scanner opens cancel link; forwarded manage link                                      | Old reminder cancelled by `schedule_version`; moved earlier or skipped; dedupe; not attempted, email used; GET changes nothing; minimal view, no contact data                                                                                                 |
| 44-48 | Same phone books twice; bot holds at release; host phone matches verified customer; shared family phone; erasure with future bookings                            | Blocked by default (`block_same_phone_overlap`); caps and Turnstile; not auto-linked; not auto-merged; future cancelled with notification, history anonymized                                                                                                 |
| 49-54 | Notify-me after cancellation; waitlist no response; tz change; App context fetch fails; flag off with future bookings; region switch                             | Match after commit; `no_response`; admin re-derive; use cached facts for operator writes, fail closed for public writes; public stops, operators keep access; guard shows counts and requires typed confirmation                                              |
| 55-60 | Off-session fee needs authentication; refund after provider disconnect; block over bookings; booking spans two services; interval 15 -> 30; voice agent books    | Fee failed, pay link; flagged for operator; warn and reassign; occupancy across both, pacing in start service; existing bookings stay; same write path, `voice_agent`, guest limits                                                                           |

## Scrutiny findings — guest-channels-and-crm (round 1)

Facts found while reviewing the milestone; all verified in the current code.

- **Hono is strict about trailing slashes.** A route registered as `/x` does not
  answer `/x/` (Hono's default `getPath` keeps the slash), which is why the
  waitlist routes register both forms: the leaf helper
  `const both = (path: string) => [path, `${path}/`]`
  (`apps/tenant-api/src/routes/reservations-waitlist.ts:100`, seven call sites)
  and `bothForms()` on the public routes
  (`apps/tenant-api/src/routes/reservations-public-waitlist.ts:94`), with the
  operator sub-router mounted at both bases
  (`apps/tenant-api/src/routes/reservations-operator.ts:76-84`). A duplicate
  registration cannot double-execute (Hono stops composing once a handler
  returns a Response). Decide the trailing-slash contract when adding a route.
- **Manager-alert kinds are a cross-plane contract duplicated in two files:**
  `MANAGER_ALERT_KINDS` (`apps/tenant-api/src/services/rsv-outbox.ts:14-22`) and
  `RESERVATION_ALERT_KINDS`
  (`apps/app/app/utils/reservations/manager-alerts.ts:14-22`). Both schemas are
  strict, so adding a kind on one side only makes the App answer 400 to a valid
  outbox event, which is retried and then failed.
- **Origin failures differ between runtimes.** On the Node runtime (what curl
  against 3007/3009 exercises, and what the contract specifies) an unresolvable
  or wrong-region Origin yields the uniform `404 not_found`
  (`apps/tenant-api/src/lib/reservations-public-auth.ts:74-103`). On Cloudflare
  Workers (`wrangler dev`) the edge answers `400` for an unresolvable Origin
  (`apps/tenant-api/workers/index.ts:307-312`) and `409 region_mismatch` (with
  `orgRegion`) for a wrong-region Origin
  (`apps/tenant-api/workers/org-router.ts:313-333`) before the route runs.
- **A hold's chosen area is not carried into the booking.** `createHold`
  restricts the engine search by `areaPref` and stores the matched tables'
  occupancies, but the hold row never records the area (`rsvHolds.areaPrefId`
  has no writer or reader), and `bookFromHold` re-runs `searchPublicDay` without
  `areaId` and takes `match.tableIds`
  (`apps/tenant-api/src/services/rsv-public-booking-service.ts:477-484,538-556`).
  A hold in the guest-selected area can therefore convert to a table outside it.
  No contract assertion covers the conversion.
- **A guest manage-link cancel does not set `late_cancel`.** The operator cancel
  path marks late cancellations
  (`apps/tenant-api/src/services/rsv-booking-service.ts:2747-2756`), but
  `apps/tenant-api/src/services/rsv-public-booking-service.ts:936-950` writes
  only `cancelledBy='guest'`. The cancellations report and the Guestbook
  `lateCancels` counter therefore reflect operator cancellations only. The guest
  path currently refuses cancels outside the free window (409 `cancel_closed`),
  so VAL-REPORT-006 is satisfiable operator-side; milestone 10 (`VAL-PAY-036`)
  expects the guest path to set `late_cancel` and will need this wiring.
