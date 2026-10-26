# Station: restaurant work, in the restaurant's brand

Station is an **Operate** interface: staff should recognize the restaurant, find
the current app and read the next task before noticing the styling.

- The published App theme owns every brand colour, custom font, base radius and
  light/dark choice. `src/lib/theme.ts` remains the single injection path. Do
  not add a Station palette, font or mode override.
- `src/ui/primitives.tsx` adapts actual `@repo/ui/button`, `input` and `badge`
  components to Station touch sizes. Menu dishes, order lines, order selection
  and kitchen lines use the shared `Item` composition; empty workspaces use
  shared `Empty`. Import individual subpaths, not the server-aware barrel.
  Shared component sources are explicitly scanned by Tailwind. Do not replace
  shared controls with local lookalikes or repaint Item internals.
- Shape roles and shared radius utilities in `src/styles/app.css` pass the
  published `--radius` through unchanged. A round floor table is actual saved
  geometry, not a control-radius choice.
- All glyphs use `Icon` from `@repo/ui/icon`, including native-select chevrons.
  Native selects keep platform behavior. Segmented groups align with 44px
  buttons (56px for the large size), with the selection inset inside the full
  touch target rather than padding added above and below it.
- Use flat work surfaces and subtle semantic surface mixes. Reserve solid brand
  fill for actions and deliberate selections. Occupancy is a quiet brand-tinted
  state; warnings belong beside the affected task, not across an entire ticket.
- Keep identity and current app visible in the header. Group PIN headings, dots,
  feedback, keypad and action into one readable composition. Kitchen lanes
  establish order; ticket number, quantity and instructions establish hierarchy.
  Reservation rows prioritize name, time, party size and state.
- Kitchen and reservations supply their controls through TopBar's presentation
  slot; loading and blocked reservations retain the same shared chrome. Context
  wraps below identity on smaller screens instead of hiding staff actions (for
  both, below 1800px it takes its own row). The host stand's header row holds
  the day, service, a one-line covers figure, Floor/Timeline and the three adds;
  the pane toolbar keeps only rooms, the free-table count, the table-colour
  legend (a popover) and, where a manager drew server sections, a Sections
  toggle (tablet only). Sections show as a band of the section's colour inside
  each table and the server's initials as a badge just outside its corner (never
  over the table's words), with a strip under the toolbar: each section's
  server, covers and free tables, and "Up next" (sat least in the last 45
  minutes, which also steers the suggested table among tables of one size).
  Servers are assigned per service in a sheet, from who is clocked in or
  scheduled, or a typed name. The desktop book pairs a 21rem party rail with the
  room plan; its rows read time, then name and party, then status.
- New component styling uses Tailwind utilities in the component. `book.css`
  keeps what utilities express badly: plan geometry and rotation from runtime
  variables, table states keyed by `data-` attributes, container queries, the
  timeline grid and keyframes.
- The register is a menu/current-order workbench. The menu is a grid of tiles as
  many as fit (about 11.5rem each, two on a phone): name, a short description,
  the price low left with a plus, a brand tint and count badge once a dish is in
  the order, and a dashed tile when sold out. The tile is a wrapper around the
  shared `Item`, which stays the button. Menu categories use the filled chip
  (solid brand when chosen). From 768px wide and 600px high, keep the menu and a
  compact current-order pane together, including tablet portrait. Phones and
  short landscape viewports use the order bar and a contained order sheet.
  Settings, pairing, payment, item options, orders, audit and shift work share
  the native dialog composition and touch controls. Keep supporting information
  plain; use boundaries for panes or meaningful groups, not every section.
  Paired settings disclose connection details separately from everyday device
  controls. Closing a task sheet returns focus to its opening control.
- Keep 44px minimum touch targets, the existing larger keypad, tabular figures,
  visible focus, native controls and native dialog focus trapping. Allow long
  names, Arabic, narrow screens and short viewports to wrap or scroll without
  losing actions. PIN key order intentionally remains LTR.
- Preserve the existing reduced-motion rules, keyboard handling, accessible
  action names, permission gates, offline messaging, status meanings, table
  geometry and mutation contracts. Styling is not a reason to change them.
- The floor uses plain table silhouettes with no decorative chairs. Preserve
  saved table positions, dimensions, rotations, walls and landmarks; long tables
  stay long. Capacity text remains authoritative, labels stay upright, and
  occupancy, timing, partial arrivals and placement choices remain readable.
- The time clock is a slim time/status strip and one focused PIN/action
  workspace, not a giant clock beside another card. Its keypad retains 64px
  keys, hardware-key handling, privacy and every offline notice.

## Type and surface scale

`src/ui/type-scale.test.ts` holds these rules in source:

- Sizes are roles: `text-xs` (12px) for captions, meta and counts; `text-sm`
  (14px) for body and field labels; `text-base` (16px) for item names, group
  headings and controls; `text-xl` (20px) for sheet titles and ticket numbers;
  `text-2xl` and up only for amounts, totals and keypad readouts. No `text-lg`,
  no arbitrary sizes, and stylesheet sizes stay on the same steps.
- Three weights: 400, 500 and 600. Emphasis that needs more than 600 is a size
  or colour decision, not a heavier weight.
- Amounts and counts use tabular figures of the restaurant's own face (`tnum`,
  or `mono`, which means the same). There is no second, monospace face.
- Notices (`notice-warning`, `notice-danger`, `notice-success`) are a 10% wash
  of their colour with the colour in the text. Layout (strip or inline) is the
  caller's; the tint and weight are not.
- `Chip look="quiet"` navigates (menu categories, filters); `look="outlined"`
  picks a value in a form (tip, split, party size, day, time).
- A checkbox keeps small square corners (`rounded-xs`) at any brand radius, so
  it never reads as a radio. Native selects share the input's card surface.

## Tabs and the kitchen

- Each save of a tab is a round: its lines get `sentAt` on this till (never
  uploaded). A dish already sent is never merged with a new one; "one more"
  rings a new line, and an edited dish becomes new work.
- The cart and Orders show rounds ("Sent 7:42 PM · 12 min ago", "Not sent yet"),
  each sent dish's kitchen stage (In queue, Preparing, Ready, Served) when the
  restaurant uses the kitchen screen, and the header's Orders button counts
  dishes ready at the pass. In Orders a server marks a round served (`servedAt`,
  also this till only and without a new revision): it reads "Served 7:58 PM" and
  overrides the kitchen stage. When the kitchen clears a ticket from the pass,
  what was sent before then is recorded as served too, so a later round
  reopening the ticket never shows those dishes as ready. One fewer then one
  more of a sent dish restores it (`sentQuantity`) with no void. A sent round
  can be rung again with Repeat round.
- One tab per table: a new dine-in order for a table that already has an open
  tab says so and offers to add its items to that tab (`lib/tabs.ts` reads
  "Table 12", "t12" and "12" as the same table). Each round adds lines, so the
  cart warns as a tab nears the 50-line order limit.
- The kitchen marks dishes from a later round as "Added" with their time
  (`firedAt`: the till's send time in demo mode; on the server, when the first
  order revision holding the dish was received), and on a ticket still being
  worked it mutes the dishes that already went out with "Served" and their time
  (`servedAt`: the ticket was cleared while they were ready, kept as
  `served:<id>` in the ticket's progress until a dish is made again). The demo
  kitchen keeps its work on the tab's sales through a reload. When a later round
  is all that is left to make, the ticket sits in New and is timed and queued
  from that round. "Start preparing" never moves a ready dish back. The board
  rings new work for 15 seconds, also after the tablet switched apps meanwhile,
  can chime, and offers an "All day" count of what is still to make.

## Verification boundary

The five refinement passes were checked on Node 22 with 1,311 passing unit
tests, lint, type checking and an isolated production build. Chromium checks
cover tablet portrait and landscape, short landscape phones, keyboard focus,
44px controls, reduced motion, offline behavior and Arabic layouts.

The broad browser run passed 267 of 278 cases. Its 11 failures were corrected
and retested: stale selectors, current radius and permission contracts, fixture
assumptions near midnight, the ZATCA fixture's sealing context, and the
register's short-viewport breakpoint. The final focused run verified 45 tablet,
header, Kitchen, host and time-clock cases, including a follow-up correction to
one new test's selector. This is not a fresh single-run full-suite result after
the last changes.

Visual evidence includes 30 baseline captures and 44 final captures across
1180px, 820px, 390px and 320px, with a synthetic published dark theme and
Arabic. Those final captures showed no document overflow or uncaught browser
errors. The last short-label touch-target adjustment has a separate browser
check and confirmation capture. Scrollable category/filter rails and
checkbox/radio inputs inside larger labels are intentional. Real iPad/Safari
hardware and every possible restaurant theme remain outside this verification.
