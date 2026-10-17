# OpenTable and reservation-platform reference

What belongs here: the OpenTable / GuestCenter vocabulary and expected behavior
a worker needs to recognize, mapped to Menuza names and grouped by milestone.

What does NOT belong here: data model columns, routes, or engine pseudocode (see
`architecture.md` and `engine-notes.md`); payment provider details (see
`payments-reference.md`).

## How to read this file

- Sources: OpenTable's 13-video "Reservations Essentials" playlist (titles,
  chapters and descriptions only; no transcripts were obtainable), OpenTable
  support snippets, and a competitor survey (Resy, SevenRooms, Tock, Yelp Guest
  Manager, Toast Tables). Items the research marked as inferred are labelled
  "(inferred)". Do not quote OpenTable behavior as verified when it is marked
  inferred.
- Menuza naming wins over OpenTable naming in code, UI copy and docs. The most
  important rename: OpenTable "shift" is a Menuza **service** (dining period).
  Never write "shift" in reservations code or copy; "shift" belongs to the Staff
  module.
- "OpenTable" behavior is a reference, not a spec. Where a mission decision
  differs, the mission wins (noted per term).

## Cross-cutting glossary (OpenTable term -> Menuza term)

| OpenTable term                                  | Meaning                                                                     | Menuza term                                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GuestCenter / OpenTable for Restaurants         | Restaurant-side product                                                     | Reservations module in the App                                                                                          |
| Front of House (FOH)                            | Live service views: floor plan, list, timeline                              | Host stand (`today`, `floor`, `timeline`)                                                                               |
| Shift                                           | Service period (lunch, dinner) with its own hours, turn times, pacing       | **Service** (`rsv_services`)                                                                                            |
| Subshift / time period                          | Sub-range inside a shift with its own settings                              | Time period (`from_min`/`to_min` on pacing and service availability rows)                                               |
| Special Day                                     | One-off override of the weekly schedule                                     | Special day (`closed`, `online_closed`, `modified`, `replace`)                                                          |
| Shift Overview                                  | Pre-service brief with shift notes                                          | Service overview (`overview`) with service notes                                                                        |
| Cover                                           | One guest; party of 4 = 4 covers                                            | Cover (same word; allowed in this module)                                                                               |
| Turn time                                       | Duration a party occupies a table, per party size per shift (15 min to 4 h) | Turn time by party size (`rsv_turn_times`, 15..480 min)                                                                 |
| Out time                                        | Start + turn time                                                           | `end_at` (derived)                                                                                                      |
| Flow controls (pacing)                          | Max covers and/or parties per 15-minute slot                                | Pacing rules (`rsv_pacing_rules`)                                                                                       |
| Turn controls                                   | Limit turns per table per shift                                             | Not built (fixed seatings exist only for Experiences)                                                                   |
| Accepted party sizes                            | Online min/max (1-20, groups up to 50)                                      | `online_party_min` / `online_party_max` (default 1 / 8), staff `party_max`                                              |
| Large party                                     | Threshold above which online becomes a request                              | Large-party mode `contact` or `request`                                                                                 |
| Booking window / advanced booking               | How far ahead; rolling or scheduled release                                 | Horizon (`horizon_days`) and daily release time (`release_local_min`)                                                   |
| Access rules                                    | Inventory reserved per channel or guest                                     | Per-service table availability (`online`, `staff_only`, `walk_in_only`, `unavailable`); full access rules are not built |
| Table combination                               | Explicit set of joined tables                                               | Combination (`rsv_table_combos`), always explicit, never adjacency-derived                                              |
| Table availability (unavailable / walk-in only) | Per shift table modes                                                       | `rsv_service_availability.mode`                                                                                         |
| Soft assignment                                 | System-chosen table, reflow may move it                                     | `assignment = soft`                                                                                                     |
| Assign / Lock                                   | Host pins a table; reflow cannot move it                                    | Assign vs Lock prompt; `assignment = locked`                                                                            |
| Reflow                                          | Re-assign soft parties when the floor changes                               | Reflow (bounded; see `engine-notes.md`)                                                                                 |
| Problem reservation / Unassigned Parties        | No valid table; shown red                                                   | Unassigned and conflict panel; unassigned lane on the timeline                                                          |
| Quick actions                                   | Status-dependent one-tap actions                                            | `quickActionsFor(reservation, ctx)` from the state machine                                                              |
| Guestbook                                       | Guest CRM                                                                   | Guestbook (`rsv_guests`, tags, notes, merges)                                                                           |
| Server sections                                 | Color-coded table groups per server per shift                               | Section layouts, sections, per-service assignments                                                                      |
| Experiences                                     | Bookable special offerings, often prepaid                                   | Experiences (`ticketed` or `prix_fixe`)                                                                                 |
| Booking policies                                | Card hold, deposits, prepaid, cancellation                                  | Policies `none`, `card_guarantee`, `deposit`, `prepay`                                                                  |
| In-house reservation                            | Booked by staff (phone, walk-up)                                            | Staff channels `phone`, `host`, `walk_in`, `waitlist`                                                                   |
| Premium Communications                          | Paid add-on: custom SMS templates, 2-way SMS                                | Out of scope (templates in code + custom note; no 2-way SMS)                                                            |
| Business day starts 5 am                        | Scheduling day boundary                                                     | `day_start_min` default 240 (04:00). OpenTable uses 05:00; Menuza deliberately defaults to 04:00 and it is configurable |

## Milestone 1: Foundation

- No OpenTable screen corresponds to this milestone. Terms used here: services,
  turn times, pacing, combinations, soft vs locked assignment, reflow, holds,
  the status lifecycle.
- Business day: a 01:00 reservation belongs to the previous business date
  (OpenTable: "scheduling time starts at 5 am local"). Menuza stores
  `business_date` + `local_start_min` (may exceed 1440).
- Status vocabulary to support from day one (OpenTable standard set; the video
  itself was not transcribed): pre-arrival Not confirmed (Menuza `booked`),
  Confirmed, Left message, No answer, Wrong number, Running late; arrival
  Arrived, Partially arrived; seated Partially seated, Seated, Appetizer,
  Entree, Dessert, Check dropped, Paid, Bussing needed; terminal Finished,
  Cancelled, No-show.
- Menuza splits these: lifecycle `status` (13 values), `contact_status`
  (`left_message`, `no_answer`, `wrong_number`), `course_status` (`appetizer`,
  `entree`, `dessert`, `check_dropped`, `paid`, `bussing`), `running_late_min`.
  "Late" and "running long" are derived, never stored.
- Industry default turn times (medium confidence, use only as seed defaults):
  parties 1-2 75-90 min, 3-4 90-105, 5-6 105-120, 7-8 120-150, 9+ 150-180.

## Milestone 2: Setup

- Floor plan: rooms/areas with tables (min/max seats, shape, position,
  reservable online or not). OpenTable can attach multiple floor plans per
  shift; Menuza has one floor plan per location made of areas, with per-service
  table availability instead of per-shift plans.
- Table combinations: configured once, with their own min/max covers (for
  example T4+T5 = 6-8). Used by auto-assignment.
- Shifts on a weekly schedule, edited in "Availability Planning", separate from
  FOH. Menuza: services with weekly templates (`days_mask`, first seating, last
  seating, end, interval), settings live under `reservations+/settings.*`.
- Special days: closed, online closed, modified hours, replacement services
  (holiday menus, Ramadan iftar/suhoor services in KSA).
- Turn times per party size per service; OpenTable range 15 min to 4 h.
- Flow controls (pacing): max covers and/or parties per 15-minute interval,
  shift-wide or per period. Menuza adds an optional rolling window and a
  concurrent-covers cap.
- Table availability per period: available, unavailable, walk-in only. "Tables
  marked as unavailable or walk-in only behave like blocked tables: reservations
  aren't assigned to them."
- Blocks: block a table or area for a time range ("close your books" for a storm
  is a special day `online_closed` or `closed`).
- Typical defaults: interval 15 min; horizon 30-60 days, hot spots release 7-30
  days ahead at a fixed time; online lead time 0-60 min; late grace 15 min;
  online party cap 6-8.

## Milestone 3: Reservation book

- Reservation list (video 2): tabs Upcoming / Seated / Finished (plus Waitlist),
  cancelled and no-show filtered out by default, search by name or phone, sort
  by time, name, party, table, shift switcher at top, cover and party counters
  (tabs and filters inferred).
- In-house reservation (video 4): created from an "add reservation" button in
  FOH or by clicking an empty Timeline cell (pre-fills table and time;
  inferred). Flow (inferred): date, party size, time (staff may book outside
  availability), optional table or area, guest lookup by phone or name, notes,
  tags, occasion, save, confirmation sent if contact info exists.
- Staff may overbook manually; the system then shows a conflict. Menuza: pacing
  is a warning for staff channels; an overbook is explicit, audited
  (`overbooked = 1`), and never creates online capacity.
- Walk-ins: one-tap seat on a table. Menuza walk-ins are reservations with
  `channel = walk_in` created directly in `seated`.
- Understanding a reservation (video 8, most viewed): row shows time, guest
  name, party size, table or "unassigned", status color and icon,
  source/channel, icons for notes (guest-provided vs staff), tags (occasion,
  dietary/allergy, VIP, seating preference), visit count / first-time guest,
  payment status, experience. Keep guest-typed requests separate from staff
  notes.
- Quick actions (video 9): available on waitlist, reservation list and seated
  list; swipe on mobile ("Check Dropped -> Paid or Finished"). Likely per list
  (inferred): reservations Seat, Arrived, Confirm, Cancel, No-show, Message;
  seated next status, Finish, Move table.
- Undo / audit trail: per-reservation history of who changed what (Menuza:
  `rsv_reservation_events`, append-only).

## Milestone 4: Host stand

- Four synchronized views over one dataset (video 1 chapters): Floor Plan, List
  View, Timeline, Calendar, plus Shift Overview, Guestbook, Server Sections,
  Settings.
- Timeline: Gantt grid, tables on the Y axis, time on the X axis, bars sized by
  turn time; "the Timeline highlights reservation gaps and conflicts";
  unassigned parties appear at the top.
- Pre-assigning (video 6): "Dragging and dropping the reservation in the
  Timeline view will display a popup to Assign or Lock the party." Also via a
  table picker in the reservation (inferred).
- Resolving conflicts (video 13): drag the unassigned party to a free table or
  combination; reflow "will try to move the later party to another eligible
  table. Watch for reassignments on the floor plan after you seat that table."
  Menuza shows auto moves to hosts, never to guests.
- Floor plan status (video 5): "Each status has a unique color and icon. A few
  options include Seated, Entree, and Bussing Needed. Hosts can quickly change a
  table's status by selecting it." Timers show minutes seated or until the next
  booking.
- Availability view: first three possible turns per table, for squeezing in a
  party. Menuza has no dedicated mode; the timeline's empty-cell booking covers
  it.
- Calendar: covers and reservations per day for forward planning.
- Shift Overview (Menuza service overview): covers by time, large parties, VIPs
  and notes, service notes (contents inferred).
- Server sections (video 10): named, color-coded table groups assigned to a
  server for a shift, editable live from the floor plan, option to always show
  section colors. Menuza: per-service assignment to an opaque staffing id or a
  free-text label; colors are theme-token keys.
- "Maintain original out time when parties are seated late" is an OpenTable
  toggle; Menuza does not build it (duration stays elapsed time from `start_at`,
  editable by resize).

## Milestone 5: Online booking

- Guest widget pattern: compact party / date / time bar plus "Find a table";
  results as 3-5 time chips around the requested time, optionally labelled with
  seating type (Standard, Bar, Patio) or experience.
- No availability: other times that day, then next available dates, then "Notify
  me" and "Join waitlist" (same day).
- Above the online max: "For larger parties, call us" (`contact`) or a request
  form (`request`, staff approves or declines).
- Selecting a slot starts a short hold (market convention 5-10 min, not
  vendor-confirmed); Menuza holds 7 min by default (3..20).
- Details step: name, phone, email, occasion chips, request note, dietary chips,
  SMS opt-in, marketing opt-in, policy text with consent.
- Confirmation page: code, add-to-calendar, directions, manage link. Manage:
  view, modify (date, time, party), cancel, confirm, running late.
- "Table needed back at 9:00 PM" notices: industry common; Menuza shows duration
  only where relevant (inferred, optional).
- Guest-visible states collapse to: upcoming, pending request, waitlisted,
  cancelled, completed, no-show.

## Milestone 6: Guest messages

- OpenTable sends confirmation email and SMS automatically, reminders,
  reconfirmation requests ("reply C" or tap to confirm), and waitlist messages.
- Typical timing: reminder 24 h before, same-day 2-4 h before, reconfirmation
  24-48 h before.
- Custom SMS templates and 2-way SMS are a paid OpenTable add-on (US/PR/USVI
  only). Menuza: EN/AR templates in code plus an operator custom note per kind;
  SMS one-way, US only; KSA email only.

## Milestone 7: Waitlist

- Adding to the waitlist (video 7): opt-in feature; party size, name, phone,
  notes; system suggests a quote, host adjusts; list shows elapsed vs quoted
  time; quick actions Notify (SMS "table ready"), Seat, Remove, Mark as left
  (workflow inferred).
- "The in-house and online waitlist will consider turn times when looking for an
  open table and when quoting wait times." Menuza quotes by queue simulation.
- Online waitlist: guests join remotely and see a status page (position, quote,
  leave, on my way).
- Reservation waitlist / notify list (Resy "Notify"): guests ask to be told when
  a sold-out slot opens. Menuza "notify-me".
- Typical response window after "table ready": 5-10 min (Menuza default 10, then
  `no_response`).

## Milestone 8: Guestbook and reports

- Guestbook (video 12): profiles with contact, visit history (completed,
  cancelled, no-show counts), notes, tags, VIP / special relationship, spend
  (POS only), merge duplicates, import/export.
- Tags: VIP, Regular, Allergy, Industry, Press, do-not-book, custom; automated
  tags (top spenders, frequent visitors) are an OpenTable Pro feature. Menuza
  system tags: first visit, frequent no-show.
- Reports: covers and parties by service, source and party size; no-show and
  cancellation rates; turn time actual vs planned by party size; waitlist quoted
  vs actual; pacing. Daily recap email is out of scope.

## Milestone 9: Payment mocks

- No OpenTable equivalent. See `payment-mocks.md`.

## Milestone 10: Payments and experiences

- Policies (support snippets): require a credit card (charged only on no-show or
  late cancel), deposits, prepaid experiences, cancellation windows. Policy can
  vary by date, service and party size.
- OpenTable takes a 2% service fee on no-show fees, deposits and prepaid
  experiences. Menuza: platform fee in basis points, set in Admin, default 0.
- Typical values: cancellation window 24 h (48-72 h fine dining); no-show fee
  $10-50 per person; deposits $20-50 per person or full prepayment (Tock).
- Mistaken no-shows are the main source of disputes, so fees are charged by
  staff, never automatically.
- Experiences: tasting menus, events, prix-fixe; own price, inventory, dates,
  schedule, policy; optionally exclusive for a window (Tock model, OpenTable
  Experiences).

## Milestone 11: Integrations

- AI phone booking exists in the market (Yelp Host). Menuza: phone-agent tools
  `check_table_availability` and `book_table` (US only).
- POS-driven course statuses and Reserve with Google are out of scope (see
  below).

## Milestone 12: Native apps

- OpenTable has iPad and iPhone host apps; those are operator apps. Menuza
  native apps are **guest** apps (iOS SwiftUI, Android framework views) for
  booking, not host tools.

## Out of scope (do not build, do not stub)

- POS integration (course statuses from checks, spend on profiles, automatic
  check creation).
- Reserve with Google (Google Actions Center partner booking server; multi-month
  certification).
- Two-way SMS inbox and SMS reply keywords.
- The Expo mobile app (`apps/mobile`).
- A diner marketplace or discovery network, reviews, loyalty points, gift cards.
- The background re-optimizer (tick-based re-assignment of future dates).
- Free-form message template editing (templates live in code; operators add a
  custom note per kind).
- WebSocket live updates (ETag polling only).
- Also not built (not listed in the mission scope): OpenTable turn controls,
  access rules beyond per-service table availability, multiple floor plans per
  service, "maintain original out time", availability view, wallet payments,
  pre-orders and add-ons, private dining inquiries, post-visit surveys, daily
  recap emails, offline mode, multi-location group CRM.
