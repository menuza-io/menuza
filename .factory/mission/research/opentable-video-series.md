# OpenTable video series: findings

Playlist: "Reservations Essentials" by OpenTable Training (13 videos, last
updated Aug 4, 2026).
https://www.youtube.com/playlist?list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53

Playlist description (from YouTube): "This introductory video playlist will
provide you with a baseline understanding of the OpenTable software. Topics
covered in the Reservations Essentials provide foundational knowledge in
reservation and table management." It points to OpenTable Academy
(opentable.docebosaas.com) for hands-on simulations.

## How this research was done (read first)

- **No transcripts were obtained.** YouTube served the watch pages with
  `playabilityStatus: LOGIN_REQUIRED` (bot check), no `captionTracks` were
  present in the player response,
  `https://www.youtube.com/api/timedtext?v=<id>&lang=en` returned empty bodies,
  and the `youtubei/v1/get_transcript` endpoint returned `FAILED_PRECONDITION`.
  The videos are 1–2.5 minutes long; at least video 2 is labelled "Made with AI"
  (altered/synthetic visuals or voice).
- From YouTube itself we obtained: titles, durations, upload recency, view
  counts, descriptions, and chapter markers (videos 1 and 4 only), plus links to
  the OpenTable support articles each video points to.
- Everything else comes from WebSearch snippets of the OpenTable Restaurant
  Community (support.opentable.com) articles on the same features. Those pages
  are JavaScript-rendered, so only search snippets were available, not full
  article text.
- Labels used below: **[video]** = from the YouTube page
  (title/description/chapters); **[support]** = quoted or paraphrased from an
  OpenTable support/marketing snippet; **[inferred]** = general domain knowledge
  of OpenTable/GuestCenter or restaurant host-stand practice, not verified
  against the video.

## Videos

| #   | Title                                         | URL                                                                                 | Duration | Topic                                                                                                              | Transcript obtained? (yes/partial/no) |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 1   | Overview of OpenTable for Restaurants         | https://www.youtube.com/watch?v=X0n8oYzlUu4&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 2:39     | Tour of the main views: floor plan, list, timeline, calendar, shift overview, guestbook, server sections, settings | no (chapters + description)           |
| 2   | Overview of the Reservation List              | https://www.youtube.com/watch?v=Z8pUOaWTrT8&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:33     | The reservation list view (upcoming / seated / finished, filters, sort)                                            | no (description)                      |
| 3   | 5 Reservation Essentials                      | https://www.youtube.com/watch?v=V00VgPCPW3M&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:46     | Five core host actions to get started                                                                              | no (description)                      |
| 4   | Make in house reservation on FOH and Timeline | https://www.youtube.com/watch?v=iuT3N_0DbZk&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:48     | Creating staff-entered (phone / in person) reservations from Front of House and from Timeline                      | no (chapters + description)           |
| 5   | Status an occupied table                      | https://www.youtube.com/watch?v=rwiXssRuKSM&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:14     | Updating a seated table's service status                                                                           | no (description)                      |
| 6   | Pre-assigning reservations                    | https://www.youtube.com/watch?v=-Pg1IZjAX8Q&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:33     | Assigning a future reservation to a specific table ("a couple ways")                                               | no (description)                      |
| 7   | Adding to the Waitlist                        | https://www.youtube.com/watch?v=rjzFnZ0v5d4&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:38     | Adding walk-ins to the waitlist, monitoring it, quick actions                                                      | no (description)                      |
| 8   | Understanding a reservation                   | https://www.youtube.com/watch?v=QfIDtunQlWo&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:18     | Anatomy of a reservation listing (fields, icons)                                                                   | no (description)                      |
| 9   | Quick Actions with OpenTable                  | https://www.youtube.com/watch?v=83Ri2E9SPIY&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 2:16     | One-tap actions on waitlist, reservation list and seated list                                                      | no (description)                      |
| 10  | Server Sections                               | https://www.youtube.com/watch?v=o9w-w4lk0IY&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:23     | Modifying server sections from the floor plan                                                                      | no (description)                      |
| 11  | Viewing Shifts                                | https://www.youtube.com/watch?v=NcZSO6CLAvs&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:00     | Switching between shifts (e.g. lunch/dinner) in the book                                                           | no (description)                      |
| 12  | Reviewing the Guestbook                       | https://www.youtube.com/watch?v=LEx7smzhIqM&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:20     | Guest database / profiles                                                                                          | no (description)                      |
| 13  | Resolving Reservation Conflicts               | https://www.youtube.com/watch?v=APZXPB4f3LU&list=PLzOatXjx-TxvQ5aqm4tqbrTS5aiQaZG53 | 1:17     | Fixing unassigned / overlapping ("problem") reservations                                                           | no (no description; title only)       |

## Per-video notes

### 1. Overview of OpenTable for Restaurants

- Source quality: description + chapter list [video]; details from support
  snippets and inference.
- Key concepts & terminology: **Floor Plan**, **List View**, **Timeline**,
  **Calendar**, **Shift Overview**, **Guestbook**, **Server Sections**,
  **Settings**, Help & Feedback, Sign Out — these chapter names are the
  top-level navigation of the host app [video]. "Front of House" (FOH) is the
  umbrella name for the live service views [video, #4].
- Workflows / screens shown (chapter timestamps) [video]: 0:00 Floor Plan, 0:26
  List View, 0:35 Timeline, 0:46 Calendar, 0:57 Shift Overview (the longest
  chapter, ~25 s), 1:22 Guestbook, 1:30 Server Sections, 1:41 Settings (~30 s),
  2:12 Help & Feedback, 2:20 Sign Out.
- Settings & options:
  - Floor plan shows tables colored by status; "Each status has a unique color
    and icon. A few options include Seated, Entree, and Bussing Needed. Hosts
    can quickly change a table's status by selecting it." [support, iPad
    navigation article]
  - **Availability view** (an FOH mode): "reveal the first three possible turns
    that are available for a specific table … if you're trying to squeeze an
    extra reservation into the shift"; based on "shift length, turn times, and
    table availability" [support].
  - Mobile/iPad setting "Always display server sections on floor plan" shows
    color-coded sections [support].
  - Calendar shows covers/reservations by day for forward planning [inferred].
  - Shift Overview = pre-service brief: covers expected by time, large parties,
    VIPs/notes, shift notes [support title: "Prepare for service with the shift
    overview"; contents inferred].
- Rules of thumb: use Timeline/List/Availability view to spot gaps and squeeze
  in extra turns; "the Timeline highlights reservation gaps and conflicts"
  [support].
- Implications for building our system: the host product is one dataset (a
  shift's reservations
  - tables + statuses) rendered through 4 synchronized views: floor plan
    (spatial), list (tabular), timeline (Gantt: tables × time), calendar (days).
    Plan a shared real-time store and per-view components rather than separate
    pages with separate fetches. Settings live apart from FOH (OpenTable splits
    FOH from "Availability Planning" admin).

### 2. Overview of the Reservation List

- Source quality: description only [video] ("quick overview of the reservation
  list"), links to support article "Reservation list overview in GuestCenter".
  Detail inferred.
- Key concepts: the reservation list groups the current shift's parties into
  tabs such as **Upcoming / Reservations**, **Waitlist**, **Seated**, and
  **Finished/Done**, with cancelled and no-show filtered out by default
  [inferred; the three lists "waitlist, reservation list, and seated list" are
  named in video 9's description].
- Workflows: scan by time, search by guest name/phone, sort (time, name, party
  size, table), filter by status/section, open a reservation for details, take
  quick actions [inferred].
- Settings & options: shift selector at top (see #11); cover and party counters
  per shift [inferred].
- Rules of thumb: "Like the List view, the Timeline highlights reservation gaps
  and conflicts" [support] — the List view flags conflicts too.
- Implications: list needs live counters (parties/covers booked, seated,
  remaining), status chips, conflict/unassigned highlighting, and per-row quick
  actions. Must be fast with keyboard search for phone bookings.

### 3. 5 Reservation Essentials

- Source quality: description only ("Master these 5 Reservations Essentials to
  get started") [video]. The five items are not listed on the page.
- Key concepts (inferred from where it sits in the playlist, between the list
  overview and the how-to videos): most likely (1) make a reservation, (2)
  assign/pre-assign a table, (3) seat a party, (4) update table status, (5)
  finish/clear the table — or a variant including waitlist/cancel/no-show.
  **Unverified.**
- Implications: the minimum viable host loop is book → assign → seat → status →
  finish, plus cancel / no-show as terminal states. That loop should be our
  first validation milestone.

### 4. Make in house reservation on FOH and Timeline

- Source quality: description + chapters [video]: "how to make in-house
  reservations on the Front of House view and Timeline view". Chapters: 0:00
  Front of House, 1:13 Timeline.
- Key concepts: **in-house reservation** = staff-created (phone, walk-up, email)
  as opposed to network/online bookings. Two entry points: an "add reservation"
  button in FOH and clicking an empty slot on a table's row in the Timeline
  (pre-fills table + time) [video chapters; click-slot behavior inferred].
- Workflow (inferred standard GuestCenter flow): choose date → party size → time
  (slots shown with availability, staff may override and book outside
  availability) → optionally choose table/seating area → search/create guest by
  phone or name (attaches to Guestbook) → add reservation notes, tags (occasion,
  dietary, seating preference) → save; confirmation email/SMS goes out
  automatically if contact info exists.
- Settings: in-house bookings are not limited by online flow controls in the
  same way; hosts can overbook manually and the system then shows a conflict
  [inferred; consistent with #13].
- Implications: our staff booking must allow override of availability (with
  warning + audit), guest lookup by phone (our customers are phone-OTP
  identities), and booking directly from a timeline cell.

### 5. Status an occupied table

- Source quality: description only ("how to quickly status an occupied table")
  [video].
- Key concepts: **table status / service status** for seated parties. OpenTable
  statuses (support + inferred, OpenTable's standard set): pre-arrival: _Not
  confirmed, Confirmed, Left message, No answer, Wrong number, Running late_;
  arrival: _Arrived / Partially arrived_; seated: _Partially seated, Seated,
  Appetizer, Entrée, Dessert, Check dropped, Paid, Bussing needed_; terminal:
  _Finished/Done, Cancelled, No-show_. [support confirms "Seated, Entree,
  Bussing Needed" and, from the mobile app article, "Check Dropped … update the
  reservation to Paid or Finished"].
- Workflow: tap the table on the floor plan → pick the next status; each status
  has a color and icon [support]. POS integrations can advance statuses
  automatically by course (POS course categories map to
  Appetizer/Entrée/Dessert; check closed → Paid) [support, Upserve/Lightspeed
  integration docs].
- Implications: model status as an ordered, configurable enum per phase with
  color/icon; allow manual override; keep a status history with timestamps
  (feeds turn-time analytics). Status drives projected "out time" and therefore
  availability for the next party.

### 6. Pre-assigning reservations

- Source quality: description only ("a couple ways to pre-assign a reservation
  to a table") [video].
- Key concepts: **soft assignment** (system-suggested, reflow may move it) vs
  **hard assignment / lock** (host-pinned; reflow cannot move it). "Dragging and
  dropping the reservation in the Timeline view will display a popup to Assign
  or Lock the party." [support] "If a user wants to prevent the system from
  reassigning a specific table, they can manually Assign a reservation to a
  table instead of suggesting it." [support] "Reflow cannot move hard-assigned
  …" [support]
- Workflows ("a couple ways"): (a) open the reservation and pick a table from
  the table picker; (b) drag the reservation onto a table on the floor plan or
  timeline [support + inferred].
- Implications: store `assignmentMode: auto | assigned | locked` per
  reservation; the auto assigner must respect locked assignments; drag-and-drop
  needs a confirm popup with Assign vs Lock.

### 7. Adding to the Waitlist

- Source quality: description [video]: "how to add guests to the waitlist …
  including how to monitor the waitlist and take quick actions"; "Learn how to
  enable the waitlist" (support link), so waitlist is an opt-in feature.
- Key concepts: walk-in **waitlist** with **quoted wait time**; **online
  waitlist** (guests join remotely before arriving) is a separate opt-in
  [support: "Offer your waitlist online"]. "The in-house and online waitlist
  will consider turn times when looking for an open table and when quoting wait
  times." [support] "Notify guest table is ready: Send an SMS to waitlist guests
  when their table is ready." [support] Waitlist guests also get a confirmation
  message on joining [support: communications article].
- Workflow (inferred): Add to waitlist → party size, name, phone, optional
  notes/seating preference → system suggests a quote → host adjusts quote →
  save; list shows elapsed time vs quoted time (overdue highlighting); quick
  actions: Notify (SMS), Seat (pick table), Remove / Cancel, Mark as left.
- Settings: enable waitlist; enable online waitlist; SMS templates (customizable
  only with "Premium Communications") [support].
- Implications: waitlist entries are a reservation-like object with
  `source=walk_in`, quote, joinedAt, notifiedAt; quote estimation should reuse
  turn times and current table out-times. SMS sending is region-sensitive for us
  (Twilio US only per AGENTS.md) — KSA needs a different channel or no SMS.

### 8. Understanding a reservation

- Source quality: description only ("what you need to know about a reservation
  listing") [video]; the most-viewed video in the playlist (60K).
- Key concepts (inferred, standard GuestCenter reservation row/card): time,
  guest name, party size, table (or "unassigned"), status icon/color,
  reservation source/channel (OpenTable network, restaurant website widget,
  in-house/phone, third party), icons for **notes** (guest-entered request vs
  restaurant note), **tags** (special occasion e.g. birthday / anniversary,
  dietary/allergy, VIP, seating preference), **visit count / first-time guest**,
  payment status (card on file / deposit) [support mentions "Payment status and
  actions"], experience booked, and confirmation state.
- Custom tags: "Create customizable tags that include key information about a
  reservation. These tags can be quickly applied …" [support].
- Implications: our reservation card needs a compact icon vocabulary;
  distinguish guest-provided notes from staff notes; show visit history from the
  guest profile.

### 9. Quick Actions with OpenTable

- Source quality: description [video]: "Quick actions are available on the
  waitlist, reservation list, and seated list."
- Key concepts: context-sensitive one-tap actions that depend on current status;
  on mobile you swipe a row: "If a reservation currently has the Check Dropped
  status, you can swipe to access buttons to update the reservation to Paid or
  Finished." [support]
- Likely actions per list (inferred): Reservations — Seat, Mark arrived,
  Confirm, Cancel, No-show, Message/Call; Waitlist — Notify, Seat, Remove;
  Seated — next status, Finish/Clear, Move table.
- Implications: define a status state machine and derive the quick-action set
  from the current state (next valid transitions), so lists and floor plan share
  the same logic.

### 10. Server Sections

- Source quality: description [video]: "how to modify server sections from the
  floor plan".
- Key concepts: **server section** = a named, color-coded group of tables
  assigned to a server for a shift; editable live from the floor plan; option to
  always display section colors on the floor plan [support]. Tapping a table
  shows its assigned server [support, mobile app].
- Implications: sections are a per-shift (per-day) overlay on the floor plan,
  not part of the static layout. Could link to Menuza Staff module staff ids
  (opaque id only; staff PII stays regional). Useful for "seat in rotation"
  balancing (covers per server) [inferred].

### 11. Viewing Shifts

- Source quality: description [video]: "how to view different shifts".
- Key concepts: a **shift** (e.g. Breakfast, Lunch, Brunch, Dinner, Late night)
  is the unit of the day for both service views and availability settings; FOH
  shows one shift at a time with a shift switcher [inferred]. Shifts are
  configured in Availability Planning on a weekly schedule, with **Special
  Days** for one-off changes ("Select the floor plans you want attached to the
  shift … Delete shift … Edit shift settings to customize subshift times,
  experiences …"; "scheduling time starts at 5 am local" — i.e. the business day
  starts at 5 am) [support].
- Implications: everything (floor plan in use, turn times, pacing, sections)
  hangs off a shift. The "business day" boundary is 5 am local, so a 1 am
  reservation belongs to the previous day.

### 12. Reviewing the Guestbook

- Source quality: description only ("quick overview of the OpenTable Guestbook")
  [video].
- Key concepts: **Guestbook** = the restaurant's guest CRM: profiles with
  contact info, visit history (completed, cancelled, no-show counts), notes,
  tags, special relationship / VIP flags, spend (with POS integration)
  [inferred + support "Guest relationship management features available on
  OpenTable Pro"]; **guest merge** for duplicates [support article slug
  "Guest-Merge" titled "Manage your restaurant's guestbook"]; data import/export
  when switching from another system [support].
- Implications: our guest profile should key off the existing tenant-db customer
  (phone-OTP identity) with restaurant-scoped notes/tags; must live in regional
  tenant SQLite (PII). Need merge, search, and visit stats; no-show count is
  critical for policy decisions.

### 13. Resolving Reservation Conflicts

- Source quality: title only [video]; support article "Resolve problem
  reservations" (slug "Resolving-table-conflicts-using-timeline").
- Key concepts: **problem reservations** — "Any reservations that are not
  assigned to a table are considered problem reservations. They will be
  highlighted in red and marked in multiple places" [support]. In Timeline they
  "appear at the top under **Unassigned Parties**" [support]. Causes:
  overbooking in-house, a seated party overstaying, tables marked unavailable or
  walk-in only ("Tables marked as unavailable or walk-in only behave like
  blocked tables: reservations aren't assigned to them and will become
  [unassigned]") [support].
- Workflow: open Timeline → drag the unassigned party to a free table /
  combination (popup: Assign or Lock) [support]; or rely on **reflow**: "If
  seating a party creates an overlap on a soft-assigned reservation, reflow will
  try to move the later party to another eligible table. Watch for reassignments
  on the floor plan after you seat that table." [support]
- Implications: we need conflict detection (overlap of [start, start+turn) per
  table), an unassigned bucket, red highlighting across list/floor/timeline, and
  an auto-reassignment pass after every seat/move/extend.

## Consolidated glossary (term -> meaning in OpenTable)

- **OpenTable for Restaurants / GuestCenter** — restaurant-side product (web +
  iPad + iPhone apps). GuestCenter is the older name still in support URLs.
- **Front of House (FOH)** — live service views: Floor Plan, List, Timeline.
- **Floor Plan** — spatial map of tables for a room; multiple floor plans can
  exist and are attached to shifts.
- **List view / Reservation list** — tabular list of the shift's parties
  (reservations, waitlist, seated).
- **Timeline** — Gantt grid, tables × time, showing each party's block from
  start to projected out time; used for booking into gaps and resolving
  conflicts.
- **Availability view** — FOH mode that shows the first three possible turns per
  table.
- **Calendar** — day-level overview of bookings for upcoming dates.
- **Shift** — a service period (lunch, dinner…) with its own hours, floor plans,
  turn times, pacing and rules.
- **Subshift / time periods** — sub-ranges inside a shift with their own
  settings.
- **Special Day** — one-off override of the weekly schedule (holiday, closure,
  event).
- **Shift Overview** — pre-shift summary/brief, with shift notes.
- **Cover** — one guest. Party of 4 = 4 covers.
- **Turn time** — expected duration a party of a given size occupies a table (15
  min to 4 h range in settings), configured per party size per shift.
- **Out time** — start + turn time; option to "Maintain original out time when
  parties are seated late".
- **Turn controls** — limit on the number of turns per table per shift for
  high-demand restaurants; can auto-expire before the shift.
- **Flow controls (pacing)** — max covers and/or parties (and parties of
  specific sizes) bookable per 15-minute slot; can be shift-wide or per slot;
  can be specific to experiences, floor plans, or sections.
- **Accepted party sizes** — min/max party size bookable online (1–20 in the
  glossary; later up to 50 for groups).
- **Large party** — restaurant-defined threshold; large parties can be routed to
  request flow or special rules.
- **Advanced booking settings / booking window** — how far ahead guests can
  book; rolling window or scheduled release.
- **Access rules** — reserve inventory/availability for specific guests or
  channels.
- **Experiences** — bookable special offerings (tasting menu, event, prepaid),
  optionally required for a time period.
- **Table combination** — two or more tables joined to seat larger parties;
  configured once and used by auto-assignment.
- **Table availability** — per shift/time period, tables or combinations set
  available / unavailable / walk-in only.
- **Soft assignment** — system-chosen table, may be changed by reflow.
- **Assign / Lock (hard assignment)** — host-chosen table; locked parties are
  not moved by reflow.
- **Reflow** — automatic re-assignment of soft-assigned parties when the floor
  changes.
- **Problem reservation / Unassigned Parties** — reservation with no valid table
  (shown red).
- **Status** — per-party state with color/icon (Confirmed, Arrived, Seated,
  Entrée, Check dropped, Paid, Bussing needed, Finished, Cancelled, No-show…).
- **Quick actions** — context-sensitive one-tap/swipe actions on list rows.
- **Waitlist** — in-house walk-in queue with quoted wait and SMS "table ready".
- **Online waitlist** — guests join the waitlist remotely.
- **Reservation waitlist / notify list** — guests asking for a fully-booked slot
  get notified when one opens ("Fill no-shows and offer last-minute tables").
- **Server sections** — color-coded groups of tables assigned to servers for a
  shift.
- **Guestbook** — guest CRM (profiles, visits, notes, tags, merge).
- **Tags** — custom labels on reservations/guests (occasion, dietary, VIP…).
- **Premium Communications** — paid add-on for custom SMS templates and 2-way
  SMS.
- **Booking policies** — credit card hold / no-show fee, deposits, prepaid
  experiences, cancellation policies.
- **In-house reservation** — booked by staff (phone/walk-up) rather than online.

## Consolidated capability list

### Setup / config

- Restaurant profile, hours, shifts on a weekly schedule; special days override
  [support].
- Business day starts 5 am local [support].
- Multiple floor plans (rooms/areas), attachable per shift; tables with min/max
  seats, shape, position, reservable online or not; table combinations
  [support].
- Seating areas / sections that online guests may choose [inferred].
- Users and permissions for hosts vs managers [inferred].

### Availability & pacing

- Turn times by party size per shift (15 min–4 h) [support]; turn-time analysis
  report to tune them [support].
- Flow controls: max covers / parties / parties of size X per 15-minute slot,
  shift-wide or per slot, scoped to experiences, floor plans or sections
  [support].
- Turn controls (minimum/maximum turns per table) with auto-expiry before shift
  [support].
- Table availability per time period: available / unavailable / walk-in only
  [support].
- Accepted online party sizes (1–20, groups up to 50); large-party definition
  [support].
- Booking window (how far ahead; rolling vs scheduled release) and cutoffs
  [support].
- Access rules for reserved inventory [support].
- Experiences with own availability [support].
- "Maintain original out time when parties are seated late" toggle [support].
- Block / pause online reservations (e.g. "Close your books for Tropical Storm
  …") [support].
- Availability automations ("Boost Occupancy with Availability Automations"
  video in a different playlist) [video title, other playlist].

### Reservation book

- Create in-house reservations from FOH or by clicking Timeline cells [video].
- Edit, move time, change party size, cancel, no-show [inferred].
- Reservation details: source, notes (guest vs staff), tags, occasion, payment
  status, experience, visit count [support + inferred].
- Shift switcher; calendar view for other days [video].
- Automatic table assignment by booking rules: fits min/max seats → can cover
  full turn → fewest seats / smallest seat gap; respects blocked/walk-in tables
  [support].

### Floor plan / host stand

- Live floor plan with status colors/icons; tap to change status [support].
- Timeline view with unassigned parties at top, drag-and-drop with Assign/Lock
  popup [support].
- Availability view showing next three turns per table [support].
- Server sections overlay, editable live [video].
- Seat, partially seat, move, finish, clear table [inferred].
- Reflow after seating to avoid overlaps [support].

### Waitlist

- Opt-in in-house waitlist with quoted times, turn-time-aware quotes [support].
- SMS confirmation on join and "table ready" notify [support].
- Online waitlist (remote join) [support].
- Reservation waitlist / notify list for sold-out slots [support].

### Guest CRM

- Guestbook profiles, visit history, notes, tags, VIP/special relationship,
  merge duplicates, import/export [support].
- Pro tier GRM: richer segmentation/marketing [support].

### Communications

- Automated confirmation emails, SMS, app notifications; reminders; direct
  messaging with guests before/after the visit [support].
- Waitlist messages; customizable SMS templates + 2-way SMS only with Premium
  Communications (US/PR/USVI only) [support].

### Policies / deposits

- Booking policies: require credit card (hold for no-show/late-cancel fee),
  deposits, prepaid experiences; cancellation windows [support].
- OpenTable takes a 2% service fee on no-show penalties, deposits and prepaid
  experiences (US restaurants can absorb or pass it on) [third-party blog via
  search].

### Reporting

- Reservations report for shift planning; turn-time analysis; covers by source;
  no-show and cancellation rates [support titles + inferred].
- Shift overview pre-service brief [support title].

### Integrations

- POS integrations (Toast, Square, Lightspeed/Upserve…) that auto-advance course
  statuses (appetizer/entrée/dessert categories) and attach spend
  [support/partner docs].
- Network distribution (OpenTable app, Google, Instagram, website widget)
  [inferred].

### Other

- iPad app, iPhone mobile app with swipe quick actions, web app [support].
- OpenTable for Groups for multi-location portfolios [support].
- OpenTable Academy training and certification [video playlist description].

## Open questions / things we could not verify

1. Exact content of every video: no transcripts or captions were retrievable
   (YouTube required sign-in; caption and transcript endpoints returned empty or
   FAILED_PRECONDITION).
2. The actual five items in "5 Reservation Essentials" (video 3).
3. The precise column set, tabs and filters in the reservation list (video 2).
4. The exact status list and colors shown in "Status an occupied table" (video
   5); our list is OpenTable's documented standard set, not confirmed from the
   video.
5. The "couple ways" to pre-assign (video 6); we assume table picker +
   drag-and-drop.
6. Whether waitlist quotes are computed automatically or entered manually by
   default (video 7).
7. Which icons appear on a reservation listing (video 8).
8. Whether server sections are saved per shift template or per day (video 10).
9. Concrete default values (default turn time per party size, default flow
   control, default booking window). Only ranges were found: turn time 15 min–4
   h; flow-control slot 15 min; online party size 1–20 (up to 50 since Dec
   2024).
10. Full text of support articles (JS-rendered; only search snippets were
    available).
11. Related OpenTable Training playlists that are probably more in-depth and
    worth a follow-up if the parent allows: "Admin Essentials" (9 videos,
    https://www.youtube.com/playlist?list=PLzOatXjx-Txu1h8HK-gdHRB9205Ye6aAW),
    "Back of House Essentials: Availability Planning" (11:01,
    https://www.youtube.com/watch?v=BA-aOzpMwsk), "Back of House Essentials:
    Overview" (7:05, https://www.youtube.com/watch?v=Brsgfo09IEw), "Boost
    Occupancy with Availability Automations" (2:54,
    https://www.youtube.com/watch?v=ahaXDADsugE), and "Level One Training:
    Restaurant Profile" (9:33, https://www.youtube.com/watch?v=IS3YYhvIJBA).
    They are outside the series the user supplied, so we did not fetch them.
