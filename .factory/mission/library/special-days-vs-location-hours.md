# Special days (Reservations) vs location hours and special hours (Locations)

Status: decision document, investigation only. No code was changed. Trigger:
product owner concern, "we have special days/hours in the location, and now also
in reservations, so I think that is a conflict for restaurant owners." Verdict
in one line: the concern is correct. Today the two systems never read each
other, so an owner can state two different truths. Recommended fix: **location
hours are the single source of "when are we open"; Reservations special days
only add reservation-specific behavior on top, and the availability resolver
consults both** (Option A, section 2).

---

## 1. FACTS

### 1.1 Location side (control plane, `OrganizationLocation`)

| Aspect                | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Columns               | `timezone` (IANA, default `America/New_York`), `storeHours`, `onlineHours`, `specialHours` (JSON text), `isActive` (`packages/database/src/schema.ts` ~2470-2490). Note there are **three** hours notions: `storeHours` (premises), `onlineHours` (ordering, preferred over storeHours by ordering code), `specialHours`.                                                                                                                                                                                                                     |
| Weekly shape          | `WeeklySchedule = { day: 'monday'..'sunday', isOpen, slots: {start:'HH:MM', end:'HH:MM'}[] }[]` (`packages/common/src/location-types.ts`). Multiple slots per day (split shifts). Minute granular, end inclusive.                                                                                                                                                                                                                                                                                                                             |
| Special hours shape   | `SpecialHour = { id, date:'YYYY-MM-DD', isOpen, slots[], note? }`. **One calendar date per entry** (no ranges). `isOpen:false` = closed all day; `isOpen:true` with slots = replacement hours (partial day). A special entry replaces the weekday schedule entirely for that date.                                                                                                                                                                                                                                                            |
| Overnight             | Modelled by **splitting at midnight** (Fri `18:00-23:59` + Sat `00:00-02:00`). A slot with end <= start (e.g. `22:00-02:00`) is never open. `END_OF_DAY = '23:59'` (`packages/common/src/location-availability.ts`).                                                                                                                                                                                                                                                                                                                          |
| No schedule           | `isLocationOpenForOrdering` treats a missing or empty schedule as **open** (default-open).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Who edits             | Operators, Settings > Locations: `locations.$locationId.tsx`, `locations.new.tsx`, `components/locations/location-form.tsx`, `availability-picker.tsx`, `special-hours-picker.tsx` (dialog: date, open/closed switch, slots, note). Per-item overrides in menu (`location-overrides-card.tsx`).                                                                                                                                                                                                                                               |
| Who reads (today)     | Online ordering (`isLocationOpenForOrdering`, `packages/common/src/restaurant-orders.ts` lines ~1237, 1985, 2454); Sites header "open now" and ordering schedule (`apps/sites/src/lib/menu-hours.ts`, `ordering/schedule.ts`); public menu context (`apps/app/app/utils/menu/public-menu-context.server.ts`); phone agent open/closed answers (`packages/phone-agent/src/availability.ts`, `packages/phone-agent-restaurant/src/location.ts`, `isOpen` follows storeHours); Google Business Profile and POS import (`packages/integrations`). |
| Reservations coupling | `apps/app/app/routes/resources+/reservations.context.ts` selects `timezone`, `storeHours`, `specialHours`, `isActive` and sends them in the non-PII `ReservationsContext` (`reservationsContextLocationSchema` in `packages/reservations/src/schemas/internal.ts` declares both as `z.unknown().nullable()`). Location save already calls `notifyReservationsContextChanged(org, 'locations')` (`locations.$locationId.tsx` lines 252, 337), so the regional cache is busted on edit.                                                         |

### 1.2 Reservations side (regional tenant DB)

| Aspect             | Fact                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weekly templates   | `rsv_services` (`packages/tenant-db/src/schema.ts` ~3463): `daysMask` (bit0 = Monday), `firstSeatingMin`, `lastSeatingMin`, `endMin` (minutes from 00:00 of the business date; `endMin <= startMin` wraps +1440 in `normalizeTemplateService`), online window, party limits. These are independent of `storeHours`.                             |
| Special days       | `rsv_special_days` (~3610): `locationId`, `fromDate`..`toDate` (**range**), `kind` in `closed` / `online_closed` / `modified` / `replace`, `serviceId`, `patch` JSON (`customServices`), `name`, `publicNoteI18n`, `version`. No link to location special hours.                                                                                |
| Blocks             | `rsv_blocks`: table or area, `businessDate`, `startAt..endAt` instants, reason. Capacity-level, not day-level.                                                                                                                                                                                                                                  |
| Business date      | Reservations use a **business date** that flips at `dayStartMin` (default 240 = 04:00 local; `packages/reservations/src/time.ts`, `config/index.ts`). Location hours use the **calendar date** in the location time zone.                                                                                                                       |
| Time zone          | `rsv_location_settings.timeZone` with `tzSyncedAt`; setup service reports `tzMismatch` when the context zone differs (`rsv-setup-service.ts` ~78-128, 336-367, 1688+). Falls back to `'UTC'` when unset (~792, 1590).                                                                                                                           |
| Resolver           | `resolveServices()` (`packages/reservations/src/rules/resolve-services.ts`). Special-day precedence `closed(1) > replace(2) > modified(3) > online_closed(4)`; then weekday templates. `closed` returns `{closed:true, onlineClosed:true, services:[]}`.                                                                                        |
| Rule expansion     | `specialDayRules()` and `loadSpecialDayRows()` in `apps/tenant-api/src/services/rsv-special-days.ts` expand ranges into one rule per business date.                                                                                                                                                                                             |
| Guest availability | `loadPublicEngineState` (`rsv-public-engine.ts` ~96-330) loads special-day rows and feeds `specialDays: specialDayRules(...)` into the engine config; `describeClosedDay()` yields `{reason:'special_day', name, note}` only for a resolved closed day.                                                                                         |
| Staff channel      | `loadStaffDayState()` (rsv-special-days.ts 88-112): `closed` -> `409 closed_day` unless `overbook:true` (`rsv-booking-service.ts` ~658, ~1192, `rsv-day-feed-service.ts` ~1373 for the host stand). `online_closed` only stops the guest channel.                                                                                               |
| Who edits          | `apps/app/.../reservations+/settings.special-days.tsx` (kind options at ~447; labels `Closed (all day)`, `Online closed (walk-ins/phone open)`, `Modified hours (patch service)`, `Replace with custom service`; date range inputs; blocks in the same screen). Calendar (`calendar.tsx`) and day feed show closed days from special days only. |
| Consumers          | Public booking engine (Sites widget, phone agent booking tools use the same engine through tenant-api), staff booking, host stand day feed, calendar, setup validation panel.                                                                                                                                                                   |

### 1.3 The decisive finding

`grep storeHours|specialHours` over `apps/tenant-api/src` and
`packages/reservations/src` (excluding tests) returns **only**: the Zod schema
declaration (`schemas/internal.ts` 57-58) and `reservations-public-fixture.ts`
(sets them to `null`). **No availability, booking, day-feed or setup code reads
location `storeHours`, `specialHours`, `onlineHours` or `isActive`.** The
payload is shipped (and cached for 5 minutes, stale up to 24 hours) but unused.
Only `timeZone` from the context is consumed (setup/time zone sync). So today
**reservation availability does not consult location hours at all**; the two
systems are fully independent.

### 1.4 Conflict scenarios (verified against code)

Legend: REAL = reproducible from the current code path; EDGE = real but needs an
unusual setup; THEORETICAL = not verified or mitigated.

| #   | Scenario                                                                                                                                                                        | Status         | Verification                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Location `specialHours` marks Dec 25 closed; reservations still bookable online, by phone agent, and by staff (no warning).                                                     | REAL           | `resolveServices` only sees `rsv_special_days`; `loadPublicEngineState` never touches context hours. Website header/ordering say closed, widget shows slots.                                                                                                |
| C2  | Reservations special day `closed` on Dec 25 but website, ordering, Google profile and phone agent "are you open" still say open.                                                | REAL           | `isLocationOpenForOrdering` and the phone-agent availability read only location data. Phone agent booking tool would decline (engine), while its hours answer says open: inconsistent call transcript.                                                      |
| C3  | Different hours on Dec 24: location special `10:00-16:00`, reservations `modified` dinner `17:00-22:00` (or no special day, so the normal dinner template runs).                | REAL           | No cross-check anywhere; slots outside location hours are offered. Setup validation (`rsv-setup-service.ts` ~837+) compares services, pacing and special days among themselves only.                                                                        |
| C4  | **Weekly** mismatch with no special days: `storeHours` Monday closed, but a service template `daysMask` includes Monday (or service `endMin` runs past closing).                | REAL           | `rsv_services` days/start/end are free-form. This is the most common conflict (day one of onboarding), larger than holidays.                                                                                                                                |
| C5  | Duplicate data entry: closing Dec 24-26 means three single-date location entries plus one reservations range; forgetting one side creates C1 or C2.                             | REAL           | Location special hours are one date per entry (`SpecialHour.date`), reservations use `fromDate..toDate`. No import or link.                                                                                                                                 |
| C6  | Time zone divergence: `OrganizationLocation.timezone` vs `rsv_location_settings.timeZone`. Special hours keyed in the location zone, special days in the reservations zone.     | EDGE           | Mitigated: sync on setup plus `tzMismatch` flag; but the flag is advisory and fallback is `'UTC'`. A moved or edited location zone leaves reservations stale until someone re-syncs. Cannot cause C1-C5 by itself, but shifts dates near midnight.          |
| C7  | Overnight: location Fri `18:00-23:59` + Sat `00:00-02:00`; reservations service `endMin` past 1440 on a Friday business date. Owner closes Sat via location special hours.      | EDGE           | The location closes the calendar date Sat (00:00-02:00 slice) while the Friday reservations service legitimately seats past midnight. A naive "closed date wins" rule would wrongly kill late seatings; the resolver must evaluate by instant, not by date. |
| C8  | `dayStartMin` (04:00) vs calendar date: a guest booking 01:30 belongs to the previous business date for reservations, but to the next calendar date for location special hours. | EDGE           | `businessDateOf` in `packages/reservations/src/time.ts` vs calendar date in `isLocationOpenForOrdering`. Matters for after-midnight service only.                                                                                                           |
| C9  | Location `isActive:false` or temporarily closed, reservations still sell.                                                                                                       | REAL (low)     | `isActive` is in the context but unread. Bookable only if `reservations.enabled` for that location; owners deactivate for permanent closure so low frequency.                                                                                               |
| C10 | `onlineHours` vs `storeHours` ambiguity: ordering prefers `onlineHours`, phone `isOpen` follows `storeHours`. Which one governs dining room reservations?                       | DESIGN GAP     | Not a bug, but the model must pick. Recommendation: `storeHours` (premises) for reservations; `onlineHours` is takeout/delivery.                                                                                                                            |
| C11 | Host stand and calendar show "Closed" only for Reservations special days; a location-closed day looks open and the host can seat a walk-in or book without the overbook prompt. | REAL           | `loadStaffDayState` is rsv-only; `rsv-day-feed-service.ts` ~1608 `dayClosed` derives from the same.                                                                                                                                                         |
| C12 | Existing bookings exist and the owner closes the day on the location side: nothing tells the Reservations team, and nothing cancels/notifies.                                   | REAL           | Location save calls `notifyReservationsContextChanged` only (cache bust). The reservations side has a conflict/reflow report for its own special days (`mutationConflicts`, `mutationReflows` in `settings.special-days.tsx`), the location side does not.  |
| C13 | Stale context: regional cache is up to 5 min fresh, 24 h stale on control-plane failure, and `null` when never fetched.                                                         | THEORETICAL    | Only relevant once the resolver reads context. Must define fail-open behavior (see 3.2).                                                                                                                                                                    |
| C14 | Multi-location: special days are keyed by `locationId`, matching context locations 1:1.                                                                                         | NOT A CONFLICT | Verified: both are per location; no org-level cross-talk.                                                                                                                                                                                                   |

**Which wins today?** Neither: each channel is governed by its own system.
Website, ordering, phone-agent hours and Google profile obey Locations;
reservation availability, staff booking and host stand obey Reservations.

---

## 2. RECOMMENDED MODEL

### 2.1 Alternatives

**A. Location is the source of truth; Reservations special days become overrides
that add behavior only (RECOMMENDED).**

- Location weekly hours and special hours define the open envelope. The
  availability resolver intersects service windows with that envelope and treats
  location closure as closed.
- Reservations special days keep only reservation-specific meaning: `closed`
  (reservations-only closure, e.g. kitchen buys out the night), `online_closed`,
  `modified` and `replace` (service windows, party limits, notes), plus blocks.
  They can restrict inside the envelope. They can exceed it only through an
  explicit, labeled override.
- Pros: one place answers "are we open"; no new tables; no double entry for the
  common case (a holiday closure is entered once); matches what website, phone
  and Google already do; existing `rsv_special_days` data keeps working.
- Cons: a resolver change in the hot path of availability; the override has to
  be designed; time zone and overnight logic must be exact (solved in 3.2).

**B. Two-way sync (closing in one place writes the other).**

- Pros: both screens stay familiar.
- Cons: different shapes (date vs range, partial slots vs service kinds), so
  mapping is lossy; partial days and `modified` cannot round-trip; the regional
  tenant DB cannot write the US control plane directly (data residency: control
  plane holds no reservation rows, ADR 048), so it needs a new App write path,
  conflict resolution and loop prevention; deleting one side silently re-opens
  the other. High risk, high effort. **Rejected.**

**C. Keep separate, add warnings only.**

- Pros: smallest change, no behavior change in availability.
- Cons: leaves C1 (guests can book a closed day) in place; relies on owners
  reading warnings; the host stand can still disagree with the website. Fine as
  a stepping stone (phase 1) but not an end state.

### 2.2 The rule set (Option A)

1. **Locations own "when is the business open".** `storeHours` (weekly) plus
   `specialHours` (dated overrides) plus `isActive` and `timezone`.
   `onlineHours` is ordering-only and is ignored by reservations (C10).
2. **Reservations owns "how we take bookings".** Services (meal periods),
   pacing, party limits, `online_closed`, `modified`, `replace`, notes, blocks.
3. **Location closure wins for bookings.** If the location is closed at an
   instant (inactive, closed special date, weekday closed, or outside every open
   slot), no online slot is offered at that instant. The staff channel treats it
   like an rsv `closed` day: `409 closed_day` unless `overbook:true`.
4. **A reservations-only closure also closes bookings, never the location.**
   Reservations `closed` stops the booking channels but does not change website,
   ordering or phone hours. The UI says so ("Reservations closed; the location
   is still shown as open on your website. Close the location too?").
5. **Explicit staff override re-opens a location-closed day for reservations
   only** (private dinner on a holiday): a Reservations special day of kind
   `replace` or `modified` with `patch.overrideLocationHours = true` (JSON in
   the existing `patch` column, no migration). It is labeled in the UI and on
   the host stand ("Reservations open although the location is closed").
6. **Reservations never contradict Locations silently.** The Special days and
   Services screens show the location's hours read-only and warn when a window
   leaves the envelope.
7. **Fail open on missing data.** No location schedule (empty/null), no context
   (never fetched), or `isActive` unknown: behave as today (rsv-only). Matches
   `isLocationOpenForOrdering` default-open and avoids an outage because the
   control plane is unreachable. A stale context older than 24 hours is already
   dropped by the cache (null), so fail-open applies automatically.

### 2.3 Precedence table (effective day for date D, instant T)

Evaluate in this order; first match decides.

| #   | Condition                                                                                                       | Online (guest)                                             | Staff (host, phone staff)                      | Label (`source`)             |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| 0   | Context missing or location has no hours data                                                                   | rsv-only (rows 5-9)                                        | rsv-only                                       | none                         |
| 1   | Location `isActive:false`                                                                                       | closed                                                     | closed (overbook allowed)                      | `location_inactive`          |
| 2   | Rsv special day `replace`/`modified` with `overrideLocationHours:true`                                          | follow the special day services (ignore location envelope) | open, banner "location closed" if it is        | `reservations_override`      |
| 3   | Location special hours entry for the date with `isOpen:false`                                                   | closed, note = special note                                | closed (overbook allowed)                      | `location_special_closed`    |
| 4   | Instant T outside every open slot of the location (special slots if a special entry exists, else weekday slots) | slot not offered                                           | warning `outside_location_hours` (not blocked) | `location_hours`             |
| 5   | Rsv special day `closed`                                                                                        | closed                                                     | closed (overbook allowed)                      | `reservations_closed`        |
| 6   | Rsv special day `replace`                                                                                       | custom services only                                       | same                                           | `reservations_special`       |
| 7   | Rsv special day `modified`                                                                                      | overlay on weekday services                                | same                                           | `reservations_special`       |
| 8   | Rsv special day `online_closed`                                                                                 | closed online                                              | open                                           | `reservations_online_closed` |
| 9   | Weekly service templates                                                                                        | as today                                                   | as today                                       | none                         |

Notes: rows 5-9 are the existing `SPECIAL_DAY_PRECEDENCE` unchanged. Row 4 is a
per-slot predicate; rows 1-3 are per day. Staff keep an escape hatch (overbook
with reason) exactly like the current rsv `closed` behavior, so a host can seat
a regular on a closed day with an audit trail.

### 2.4 UX in the three surfaces

- **Reservations > Settings > Special days:** a read-only "From location hours"
  strip above the list (chips: `Dec 25 Closed - Christmas`,
  `Dec 24 10:00-16:00`) for the next 90 days, each chip linking "Edit in
  Location settings" (`/settings/locations/<id>`). Each existing row shows a
  warning badge if it conflicts: Rsv open/modified on a location-closed date
  without the override flag ("Location is closed this day; guests cannot book.
  Edit location or enable 'open for reservations anyway'"); Rsv `closed` on a
  date where the location is open ("Your website still shows open").
- **Creating a `closed` special day** adds a confirmation sheet: "Also close the
  location on these dates?" with three choices: _Only reservations_ (default),
  _Reservations and location_ (App action writes `specialHours` entries for each
  date; one date per entry, id `special_<ts>`), _Cancel_. This is the only
  "sync", and it is explicit, one-directional per action, and App-hosted (the
  App already owns the control plane, so residency holds; the browser calls the
  App action, which updates `OrganizationLocation.specialHours` and then
  `notifyReservationsContextChanged`).
- **Location hours editor (`special-hours-picker.tsx`):** when reservations are
  enabled for the org, saving a closed or shortened date shows a non-blocking
  notice with the count of reservations affected on that date ("12 reservations
  on Dec 25 will become unbookable. Review"). The count comes from a new
  App-to-tenant-api summary call (browser-direct to regional tenant-api with the
  operator token, same pattern as other reservations screens; no PII, only a
  count).
- **One-time "Import location closures"** button on the Special days screen:
  lists location closed dates (grouped into contiguous ranges) that have no
  matching reservations special day and offers to create `closed` rows for them.
  Under Option A this is not needed for availability (rule 3 already closes
  those days), so it only serves owners who want the names and notes in the
  Reservations list and calendar. Optional; hidden after first use; dropping it
  from scope breaks nothing.
- **Host stand and calendar:** show the effective source. Day header
  `Closed: Christmas (from location hours)` vs
  `Closed: Private event (Reservations)`; a banner when staff seat on a
  location-closed day; calendar cells use the effective state (`calendar.tsx`
  closed cell uses effective `source`).
- **Services screen:** validation panel gets two new checks
  (`service_outside_location_hours`, `service_on_closed_weekday`) with the
  location chip shown.

---

## 3. CONCRETE CHANGE LIST

### 3.1 Control plane (App)

1. `apps/app/app/routes/resources+/reservations.context.ts`: parse
   `storeHours`/`specialHours` JSON text into typed arrays before sending (today
   it sends the raw column strings; `z.unknown()` hides the type). Send only
   `storeHours`, `specialHours`, `timezone`, `isActive`. Do not send
   `onlineHours`.
2. `packages/reservations/src/schemas/internal.ts`: replace `z.unknown()` with
   strict schemas `WeeklyScheduleSchema` / `SpecialHourSchema` (copy the shapes
   from `packages/common/src/location-types.ts`; do not import app code into the
   package; `@repo/common` is already a tenant-api dependency, but
   `@repo/reservations` does not depend on it and should stay pure). Keep
   `.nullable()` and accept legacy shapes (fail open on parse error rather than
   reject the whole context: use `.catch(null)` per field).
3. `locations.$locationId.tsx` and `special-hours-picker.tsx`: after saving
   hours, call `notifyReservationsContextChanged` (already done for the form
   save; verify the special hours path uses the same action), add the affected
   reservations notice (3.4).
4. New App action (resource route or reservations route action) "close location
   on dates" used by the special-day confirmation sheet: validates dates, merges
   into `specialHours` (dedupe by date), audit log, then
   `notifyReservationsContextChanged(org, 'locations')`.

### 3.2 `@repo/reservations` (pure logic)

1. New `packages/reservations/src/rules/location-hours.ts`:
   - `type LocationHoursInput = { timeZone, isActive, storeHours, specialHours }`.
   - `isLocationOpenAt(hours, instantMs): { open: boolean; reason: 'inactive'|'special_closed'|'closed_weekday'|'outside_slots'|null; note?: string }`.
     Evaluate by **converting the instant to location-local calendar date and
     HH:MM** (use `@repo/zoned-time`, already a dependency), then apply the same
     rules as `isLocationOpenForOrdering`: special entry first, else weekday
     slots, midnight split natively handled (Fri slice and Sat slice are checked
     separately by instant). This fixes C6, C7, C8 together: the location zone
     and the reservations zone may differ, `dayStartMin` is irrelevant because
     we never map a business date to a calendar date.
   - `locationDayState(hours, localDate)`: summary for banners/calendar:
     `closed | partial | open | unknown`, with `slots`, `note`. A day is
     `closed` only when it has no open slot on that calendar date and the
     previous-date overnight tail does not extend into it (the tail is part of
     the previous business date; show as `partial` for the business date).
   - Duplicated minimal logic is acceptable; **add a parity test** against
     `isLocationOpenForOrdering` (table of cases, run from tenant-api tests
     where both packages are importable) so the two implementations cannot
     drift. Alternative: move `isLocationOpenForOrdering`'s core into a tiny
     shared package; larger blast radius, not recommended for this change.
2. `resolve-services.ts`: keep `resolveServices` unchanged. It is date-level
   while the location envelope is slot-level, so add the envelope as an
   **availability filter** in `engine/availability.ts`
   (`filterSlotsByLocationHours`), applied to slots that already carry instants.
   `resolveServices` stays a pure reservations rule with its existing tests. The
   location-closed state is attached one level up by `buildEffectiveDay` (3.2
   item 3 and 3.3).
3. Effective-day type (new, exported from the package):
   ```ts
   type EffectiveDay = {
   	businessDate: string
   	closed: boolean // no bookings at all
   	onlineClosed: boolean
   	source:
   		| 'none'
   		| 'location_inactive'
   		| 'location_special_closed'
   		| 'location_hours'
   		| 'reservations_closed'
   		| 'reservations_special'
   		| 'reservations_online_closed'
   		| 'reservations_override'
   	name: string | null
   	note: string | null
   	locationOpen: 'open' | 'partial' | 'closed' | 'unknown'
   }
   ```
   One builder `buildEffectiveDay(resolved, locationHours, businessDate)` used
   by every caller (public engine, staff state, day feed, calendar) so the host
   stand and the guest widget cannot disagree.
4. Precedence constant table (section 2.3) as data next to
   `SPECIAL_DAY_PRECEDENCE`, with a unit test that asserts the table order.
5. `special day` patch: allow `overrideLocationHours?: boolean` in the setup
   schema (`packages/reservations/src/schemas/setup.ts`); only valid for kinds
   `modified` and `replace`.

### 3.3 tenant-api

1. `apps/tenant-api/src/services/rsv-special-days.ts`:
   - `loadStaffDayState(db, locationId, businessDate)` gains `locationHours`
     (nullable) and returns `source`/`locationOpen`. Extend `StaffDayState` to
     `{state:'open'|'closed'|'online_closed', source, name, note}`; the 409
     `closed_day` error carries `source`.
   - New `resolveEffectiveDay(db, orgId, locationId, businessDate)` that reads
     `getReservationsContext(orgId)` (cached), picks the location by id, and
     calls `buildEffectiveDay`.
2. `apps/tenant-api/src/services/rsv-public-engine.ts`:
   - `loadPublicEngineState` accepts `locationHours` (nullable); stores in
     `PublicEngineState`.
   - `searchPublicDay`: after slot generation, drop online slots where
     `isLocationOpenAt(slotInstant).open === false` unless the day is a
     `reservations_override`. Record the dropped count and reason so
     `describeClosedDay` can answer `reason:'location_closed'` (new enum value;
     keep `'special_day'` for rsv closure) with `name` and `note`.
   - `describeClosedDay` returns the location note when location closed so the
     Sites widget shows "Closed for Christmas".
   - The booking re-check inside the transaction
     (`rsv-public-booking-service.ts` ~519, ~851, ~1253) must apply the same
     filter, otherwise a stale slot hold could be confirmed after the owner
     closes the day.
3. `apps/tenant-api/src/services/rsv-booking-service.ts` (~658, ~1192): staff
   booking uses the enriched day state; a location-closed day yields the same
   `closed_day` 409 with `source:'location_*'`, and outside-slot instants give
   warning `outside_location_hours` only (do not block; the host knows best).
4. `rsv-day-feed-service.ts` (~1373, ~1608, ~2074, ~2130): pass the effective
   day to the host stand: `dayClosed`, `closedSource`, `closedName`.
5. `rsv-setup-service.ts`: validation panel adds
   `service_outside_location_hours`, `service_on_closed_weekday`,
   `special_day_conflicts_location`; use `getReservationsContext` best effort
   (same pattern as `resolveContextLocationTimeZone`). Creating/updating a
   special day returns a `locationConflict` hint (no failure) so the UI can
   render the confirmation sheet.
6. `apps/tenant-api/src/routes/reservations-public-fixture.ts`: add hours to the
   fixture for tests.
7. Optional count endpoint:
   `GET /operator/reservations/affected?locationId&date` (counts only; operator
   token).

### 3.4 App UI

- `reservations+/settings.special-days.tsx`: location hours strip, conflict
  badges, creation confirmation sheet, "open for reservations anyway" toggle for
  `modified`/`replace`, importer (optional). New Lingui strings (en + ar).
- `settings+/locations.$locationId.tsx` / `special-hours-picker.tsx`: affected
  reservations notice; link "Special days in Reservations".
- Host stand and calendar components under `reservations+/` (`calendar.tsx`,
  today/day views): show effective source in the closed banner.
- Services editor: inline chip showing the location's open hours for the
  selected weekdays and the warning from validation.
- `docs/reservations.md` (setup step 2 and 5, "Special days"),
  `docs/reservations-contract.md` (`closed_day` gets `source`, new
  `outside_location_hours` warning, new `describeClosedDay` reason),
  `docs/decisions/048-reservations-data-residency.md` (note that location hours
  already ride in the non-PII context; no new data crosses regions),
  `docs/reservations-mission/AGENTS.md` and library `engine-notes.md`.

### 3.5 Data migration

**None required.** No new columns: the override flag lives in the existing
`rsv_special_days.patch` JSON (`overrideLocationHours`), absent means false.
Existing `closed` special days keep working (they now coexist with location
closure; both lead to closed). Existing services keep working; owners with
services outside location hours see warnings, not outages, **except** that
online slots outside location hours disappear. That is a behavior change for
tenants who configured reservation windows wider than their store hours: gate it
behind a per-location setting default **off for existing orgs**, default **on
for new ones** (`rsv_location_settings.respectLocationHours`, one boolean
column, additive migration, default 0 for existing rows, 1 in the setup wizard).
If a column is unacceptable, use a feature flag
`reservations.respectLocationHours` via `getFeatureFlag` instead (zero
migration, org-level). Recommend the flag, matching the staffing pattern.

### 3.6 Edge cases to cover

- **Time zone:** evaluate the location envelope in the **location** zone from
  context, business dates in the **reservations** zone. If they differ the
  instant conversion is still exact. If the context zone is invalid, fail open
  and raise the setup warning.
- **Overnight:** `Fri 18:00-23:59` + `Sat 00:00-02:00` is two location slices; a
  Friday business-date seating at 00:30 maps to Sat calendar date 00:30 and is
  open. A Sat location special closed entry also closes that 00:00-02:00 tail
  (the owner closed Saturday): correct and expected, show the tail as closed in
  the preview. Closed Friday (special) but Thursday overnight tail into Friday
  00:00-02:00: the Friday entry wins for Friday's calendar date, so the tail is
  cut; surface this in the chips ("closes at midnight because Friday is
  closed").
- **`dayStartMin`:** not used by the envelope check, only for business date
  labeling. A service ending past 04:00 is already unsupported
  (docs/reservations.md lists service windows vs `dayStartMin` as not
  validated).
- **Services crossing midnight:** only the slot start is tested against the
  envelope (guests may finish after closing, kitchen last seating is the
  service's `lastSeatingMin`). Optional stricter rule: also require
  `slotStart + minimum turn <= envelope close`; start with the lenient rule.
- **Partial-day special hours:** `Dec 24 10:00-16:00` removes dinner slots after
  16:00 and keeps lunch. If the owner also has an rsv `modified` dinner
  17:00-22:00 without override, the guest sees no dinner and the Special days
  screen warns. With the override flag, dinner shows.
- **Multiple slots per day (split shifts):** open if inside any slot.
- **Inclusive end (`23:59`)** and minute granularity: compare minutes, treat
  `end` inclusive as the location does today.
- **Empty `storeHours` array vs null:** both fail open.
- **Rsv closed + location special open:** rsv wins (row 5): the restaurant keeps
  serving walk-in, hosts stop bookings; banner says reservations only.
- **Existing reservations on a newly closed day:** never auto-cancel; show them
  on the host stand with a "location closed" flag and list in the affected
  count.
- **Stale context (up to 24 h):** a location closure made during a control-plane
  outage is not seen until the cache refreshes (`invalidateReservationsContext`
  runs on location save through `context-changed`); document, acceptable.
- **Hold/confirm race:** re-check envelope at hold confirm and booking commit.

### 3.7 Test plan

Unit (`packages/reservations`):

- `location-hours.test.ts`: weekday open/closed; special closed; special
  partial; empty schedule; inactive; multiple slots; inclusive end `23:59`;
  midnight split; DST spring/fall dates; zone differing from reservations zone;
  `isLocationOpenAt` vs `locationDayState`.
- `effective-day.test.ts`: every row of the precedence table including the
  override and the fail-open rows.
- parity test (tenant-api test folder) comparing `isLocationOpenAt` with
  `isLocationOpenForOrdering` on a generated grid of instants and schedules.
- `schemas` test: context schema accepts legacy raw JSON strings, typed arrays,
  nulls; rejects nothing (fail open).

Route/service (`apps/tenant-api`):

- public availability: location special closed -> no slots and
  `reason:'location_closed'` with note; partial day filter; rsv closed still
  `special_day`; override flag keeps slots; flag off (existing orgs) keeps old
  behavior; no context -> old behavior.
- public booking: hold then close location then confirm -> `slot_unavailable`.
- staff booking: location closed -> `409 closed_day` with `source`; `overbook`
  succeeds with warning; outside slots -> warning only.
- day feed: `dayClosed`, `closedSource`.
- setup validation: new codes; special day create returns `locationConflict`.
- security gates (`staffing-security`-style for reservations if present) still
  pass; no PII in the new context fields (location hours only).

App:

- Vitest for the special days screen conflict badges and the confirmation sheet
  (strings, three choices).
- Playwright (ask before running, writes to LibSQL): close Dec 25 in Locations,
  open the public widget for that date, expect closed with the note; create rsv
  closed day with "Also close location" and verify the website header.
- `node scripts/check-lingui.mjs` for new strings (en + ar).

### 3.8 Rollout order and effort

| Step | Work                                                                                                                                                 | Effort  | Notes                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| 1    | Context payload typing (3.1 items 1-2); tests; no behavior change                                                                                    | 0.5 day | Safe to ship alone.                                                    |
| 2    | `location-hours.ts`, `EffectiveDay`, precedence data, unit and parity tests                                                                          | 1.5 day | Pure logic.                                                            |
| 3    | **Phase 1 (Option C): warnings only**: validation checks, special days screen strip and conflict badges, host stand source label                     | 1.5 day | No availability change; ships the visible fix for C1-C5 communication. |
| 4    | **Phase 2 (Option A): enforcement** behind `reservations.respectLocationHours`: engine filter, booking re-check, staff `closed_day` source, day feed | 2-3 day | Includes route tests; turn on per org, default on for new orgs.        |
| 5    | Close-both confirmation sheet, App action, affected count, importer                                                                                  | 1.5 day | Importer optional.                                                     |
| 6    | Docs, Lingui, Playwright, review fixes                                                                                                               | 1 day   |                                                                        |

Total about 8-10 working days; phase 1 alone is about 3.5 days and removes the
"owner is unaware" problem. Recommend shipping phase 1 first, then enforcement
org by org.

### 3.9 Open decisions for the product owner

1. Is enforcing location hours for reservations default-on for **existing**
   tenants (breaking for those with wider rsv windows) or opt-in? Recommended:
   opt-in for existing, on for new.
2. Should `overrideLocationHours` be a toggle on the special day, or a separate
   kind "Open for reservations (private event)"? Recommended: a toggle labeled
   "Take reservations even though the location is closed", surfaced only when
   the date is location-closed.
3. Closing from Reservations: default "Only reservations" or "Reservations and
   location"? Recommended: only reservations (least surprise), with the
   confirmation making the second choice one click.
4. Which hours: `storeHours` only (recommended) or also `onlineHours`.
