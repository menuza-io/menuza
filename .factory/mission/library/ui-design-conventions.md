# UI design conventions and Reservations audit (operator App, `apps/app`)

What belongs here: how the operator app actually looks and behaves (derived from
source), an audit of every Reservations screen against it, a target design, and
a checklist for anyone building new Reservations UI.

What does NOT belong here: loader contracts, tenant-api, residency rules (see
`app-ui-patterns.md`, `staffing-patterns.md`). This file complements
`app-ui-patterns.md`; where they disagree on look and feel, this file wins.

Paths are relative to `/Users/zama/menuza`. Audit date 2026-10-18, branch
`pr/reservations`, read-only from source (no browser; the browser could not log
in). Lenses: impeccable Operate mode (familiarity over novelty, restrained
color, consistent vocabulary, every state, modal is not the first thought),
critique (hierarchy, density, cognitive load), polish (system drift
classification).

Product frame (`apps/app/PRODUCT.md`, `apps/app/DESIGN.md`): "A calm control
room". Task-first, scannable, predictable navigation, clear next action,
semantic tokens only, publish/destructive actions never look like navigation.

---

## Part A. How Menuza looks and behaves

### A1. Tokens (`apps/app/app/styles/tailwind.css`)

- Warm stone neutrals, ONE accent (forest green `--primary`), hairline borders.
  Surfaces step up: `--sidebar` < `--background` < `--card`/`--popover`.
- Semantic colors that exist: `primary`, `secondary`, `muted`, `accent`,
  `destructive`, `success`, `warning`, `border`, `border-strong`, `input`,
  `ring`, `chart-1..5`. There is NO `info` token.
- Categorical hues for user-chosen colors:
  `--position-{neutral,red,orange,amber, green,teal,blue,violet,pink}` (light
  and dark tuned). Use via `@repo/ui/position-color` (`dot`, `chip`, `live`,
  `draft` class sets); store a color KEY, never hex.
- Radius: `--radius: 0.5rem`; inputs/menus `rounded-md`, cards/frames
  `rounded-xl`, dialogs `rounded-2xl`, buttons/tabs-pills `rounded-full`
  (rectangular inside `button-group`, input-group, calendar cells).
- Type: Geist Variable. Scale is deliberately small: `text-2xs` 11px, `text-xs`
  12px, `text-sm` 13.5px (not 14), buttons 13px. Page title 23px
  (`text-[1.4375rem]`, -0.022em), section/card title 14.5px semibold
  (`text-[0.90625rem]`), KPI value 22px `tabular-nums`. Lint allows arbitrary
  `text-[9px..13px]` only; prefer `text-2xs`/`text-xs`/`text-sm` tokens.
- Elevation: `shadow-xs`, `shadow-card`, `shadow-raised`, `shadow-pop` (dialogs,
  menus). Cards are `border` + `shadow-card`; dark mode drops the shadow.
- Motion: `--motion-ease` = `ease-out-quint`, buttons 150 ms, dialogs 100 ms,
  sheets 200 ms, press `active:scale-[0.97]`, `motion-reduce:*` honored. Motion
  conveys state only. No orchestrated entrances.
- Touch: controls are 32 px (`h-8`) on desktop. Wherever a screen is used on
  tablets/phones Staff uses `h-11 md:h-8` (`FilterSelect`,
  `ToggleGroupItem className="h-11 md:h-7"`). `Button` adds an invisible
  `after:-inset-1.5` hit area below `md`.

### A2. Page shell (copy this)

`packages/ui/components/workspace.tsx`:

```tsx
<WorkspacePage>            {/* mx-auto max-w-[72.5rem] flex flex-col gap-6 py-5 md:px-6 md:pt-7 md:pb-16 */}
  <PageHeader title description actions />        {/* @repo/ui/page-header */}
  <WorkspaceTabBar tabs=... />  or <SectionTabs/>  {/* underline tabs, edge-to-edge divider */}
  <WorkspaceToolbar> search + FilterSelect... </WorkspaceToolbar>
  ...content: Frame+Table / WorkspacePanel / WorkspaceMetricGrid / EmptyState
</WorkspacePage>
```

- Container: one `WorkspacePage` per route family, in the `_layout.tsx`
  (`staff+/_layout.tsx`, `settings+/_layout.tsx`, `phone-agent+/_layout.tsx`).
  Child routes render a plain `<div className="flex flex-col gap-6">`.
- Header: `PageHeader` = title (h1 23px) + one-line muted description
  (max-w-3xl) on the left, `actions` on the right (`flex flex-wrap gap-1.5`;
  stacks below title on mobile). Exactly one primary (default variant) button;
  the rest `outline`; overflow in a `DropdownMenu` (`Team` page: Positions
  outline, New person primary, "..." menu with Import/Bulk/Export). Back is an
  icon button left of the title (`components/staff/page-back.tsx`,
  `rtl:rotate-180`), never in the actions.
- Section nav inside a family: ONE underline tab row under the header:
  `WorkspaceTabBar` (links, `h-9`, `text-[13px]`, 2px foreground underline on
  active) via `components/staff/section-tabs.tsx` (`SectionTabs`,
  route-matching). Nested sub-sections use `TabsList variant="line"` or a
  `ToggleGroup variant="segmented"` filter, never a second pill bar. Mailbox
  uses `Tabs` + `TabsList variant="line"`.
- Sidebar (`components/app-sidebar.tsx`) lists the family and its pages. The
  in-page tab row mirrors it for orientation; do not add a third nav.
- Breadcrumb (`components/workspace-breadcrumb.tsx`): each new route segment
  needs a `SEGMENT_LABELS` entry. Reservations ones exist (`reservations`,
  `today`, `book`, `timeline`, `floor`, `floor-plan`...). Add any new segment.

### A3. Surfaces and density

| Need              | Component                                                                                           | Notes                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Data list         | `Frame` + `Table variant="card"` (`@repo/ui/frame`, `table`)                                        | rows `py-2.5 px-3`, header `text-muted-foreground`, hover tint built in. Customers, Locations, Guests. |
| Settings section  | `Card`/`WorkspaceSurface` or `Frame`+`FrameHeader`/`FramePanel`                                     | `Card size="sm"` for dense blocks. One title, one muted description.                                   |
| KPIs              | `WorkspaceMetricGrid` + `WorkspaceMetric`                                                           | hairline-gap grid, `tone` default/primary/warning/danger. Home dashboard.                              |
| Section on canvas | `WorkspacePanel title description action`                                                           | flat, no card.                                                                                         |
| Quiet row/alert   | `Item variant="muted"` (`@repo/ui/item`)                                                            | phone-agent region notice.                                                                             |
| Inline message    | `Alert` / `Alert variant="destructive"`                                                             |                                                                                                        |
| Empty             | `#app/components/empty-state.tsx` (`EmptyState icons title description action`) or `@repo/ui/empty` | dashed, 3-icon fan. Always give a next action.                                                         |
| Loading           | `Skeleton` shaped like the final rows (Customers)                                                   | never centered "Loading..." text.                                                                      |
| Toolbar           | `WorkspaceToolbar` + `Input` w/ search icon + `FilterSelect`                                        | search `md:w-72`; filters `h-11 md:h-8`.                                                               |
| Segmented filter  | `ToggleGroup variant="segmented"`                                                                   | Staff timeclock.                                                                                       |

Density: body copy `text-sm`, secondary `text-xs text-muted-foreground`, cards
`p-4`/`p-3` for `size="sm"`, `gap-6` between page blocks, `gap-2` inside
toolbars. Maximum ~2 badges per row; a list row carries ONE status signal.

### A4. Buttons

`@repo/ui/button` (`packages/ui/components/ui/button.tsx`): pill, `h-8`.
Variants: `default` (the one primary), `outline` (secondary actions, card-like),
`secondary`, `ghost` (toolbars, row actions), `destructive` (soft red, tinted
not solid), `link`. Sizes: `default h-8`, `sm h-7`, `xs h-6`, `lg h-9`, `icon`
`icon-sm` `icon-xs` `icon-lg`. Rules: one primary per view or sheet; icon +
label via `<Icon name=... />`; icon-only buttons carry `aria-label`;
`render={<Link/>}` for navigation; destructive confirmations use `AlertDialog`.
Never use a solid primary pill as a "tab" or "selected filter" (see audit).

### A5. Badges and status color

`Badge` (`h-5 text-xs rounded-sm`): `default` (primary tint), `secondary`
(neutral outline), `outline`, `success`, `warning`, `destructive`. These ARE the
semantic vocabulary. Lint tolerates raw `emerald/amber/red/slate/blue/...`
Tailwind colors (`eslint-preset.js` `no-raw-colors` allow-list) so ESLint is
clean while the look drifts. Policy for new code: use
`bg-success/10 text-success`, `bg-warning/12 text-warning`,
`bg-destructive/10 text-destructive`, `Badge variant`, or position-color tokens.
Staff pattern for a calm roster status: a 6px dot + muted text
(`components/staff/staff-status.tsx`), strong color only for states that need
attention.

### A6. Forms

- Conform + Zod for route forms; Staff client-side forms use the small controls
  in `components/staff/controls.tsx`: `TextField`, `TextAreaField`,
  `SelectField` (Base UI `Select` with `items`), `FilterSelect`, plus
  `components/staff/switch-field.tsx` (`SwitchField` label + description +
  `Switch` on one 44 px row). All are built on `@repo/ui/field` (`Field`,
  `FieldLabel`, `FieldDescription`, `FieldError`) so labels, hints, errors,
  `aria-invalid` are wired.
- Native `<select>`, `<input type="checkbox">`, `<table>` are not used in the
  app outside Reservations except a handful of cases. Use `Select`, `Checkbox`,
  `Switch`, `Table`.
- Inputs: default `h-8 text-base md:text-sm`. Do not force `text-xs` on an
  `Input` (iOS zooms below 16 px).
- Layout: single column, `gap-5` between fields, 2-col grid only for short
  paired fields (date/time). Save is explicit: footer button in a sheet, or a
  right-aligned primary at the end of a card; dirty state guarded with
  `useConfirmBlocker`/`useDirtyBeforeUnload` (`utils/navigation-guards.ts`,
  phone-agent settings).

### A7. Overlays: when to use which

- `Sheet` (right, `sm:max-w-sm` default; widen deliberately) for record detail
  and create/edit of one record: Staff uses `SheetPanel`/`SheetForm`
  (`components/staff/sheet-frame.tsx`): bordered header with `pe-12 rtl:ps-12`,
  scrolling body `p-4 gap-5/6`, sticky `SheetFooter border-t` with actions
  (`sm:flex-row sm:justify-end`). Escape and the built-in close are the exits,
  nothing is saved before the footer action.
- `Dialog` (`sm:max-w-sm`, `rounded-2xl`) for short confirm-or-choose tasks
  (seat a party, pick a date range). `AlertDialog` for destructive confirms.
- `Drawer` + `useIsMobile` for phone-first pickers.
- Route-based dialogs are forbidden (ADR 023); state or search-param driven.
- Full-screen editor chrome (website page editor
  `routes/.../website+/pages.$pageId.tsx` ~L5965; email designer
  `packages/marketing/src/components/email/email-design-overlay.tsx`): muted
  canvas, `header h-12 border-b bg-background px-3`, left: ghost `icon-xs`
  arrow-left Back (confirm discard if dirty), 1px divider, truncated title
  (`text-sm font-medium`), a dirty/saved indicator (6px dot + "Unsaved
  changes"/"Saved"); right: secondary actions, ONE primary Save/Publish. Body:
  rounded surface on `bg-muted`. The phone-agent flow editor renders
  full-viewport by bypassing `WorkspacePage` in its layout. A floor-plan editor
  should copy this exactly (it is a draft + explicit save + version conflict).

### A8. i18n, RTL, accessibility

- Lingui everywhere (`Trans`, `t`, `msg`); `en` source + `ar` required; run
  `npm run lingui:extract -w app`, fill `ar.po`,
  `node scripts/check-lingui.mjs`. ESLint `lingui/no-expression-in-message`:
  bind to a variable first (`const name = x.name; t\`Hi ${name}\``).
- Logical CSS only: `ms-/me-/ps-/pe-/start-/end-/text-start/text-end`,
  `rounded-s/e`, `border-s/e`, icons that point get `rtl:rotate-180`. Geometry
  derived from a timeline/floor canvas uses CSS var + logical class
  (`start-(--shift-start)`) and `useDirection()` from `@repo/ui` for pointer
  sign flip (`staff/schedule/day-timeline.tsx`).
- Wrap user-supplied names with `wrap-anywhere`/`truncate` + `min-w-0`.
- Dates and numbers: `Intl.*` with the request locale (see
  `getWorkspaceHour`/`formatWorkspaceDate` hydration note); never hard-code
  `en-GB`.
- Every interactive element has a focus ring from the primitives; icon buttons
  have `aria-label`; live regions via `role="status"/"alert"`; drag interactions
  need keyboard + announcements (`staff/schedule/schedule-dnd.tsx`).
- Preserve `data-testid` values: unit and e2e tests depend on them heavily in
  Reservations. Move/restyle, do not rename.

### A9. Polling and live data (design consequence)

Live screens poll silently (`useVisiblePolling`); show a quiet "Updated 12 s
ago" or spinner on the refresh icon button, never a skeleton flash on refresh
(Staff `useStaffQuery` keeps old data while refreshing).

---

## Part B. Reservations audit

Measured (non-test `.tsx`, Reservations: 53 files / ~24.7k lines vs Staff 115
files / ~28.4k lines):

| Metric                                                                                       | Reservations                                                                     | Staff | Phone agent |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----- | ----------- |
| raw palette classes (`bg-emerald-*`, `text-amber-*`, `border-red-*`, `slate`, `sky`, `blue`) | **241**                                                                          | 4     | 22          |
| hex colors (`bg-[#...]`)                                                                     | 12 (all `floor.tsx`)                                                             | 0     | 0           |
| native `<select>/<input>/<button>/<table>/<textarea>`                                        | **101** (31 files)                                                               | 9     | 10          |
| inline `style={{}}`                                                                          | 21 (mostly dynamic geometry, allowed)                                            | 10    | 1           |
| `text-[10px]/[11px]` arbitrary text sizes                                                    | 45 (floor 14, timeline 11, waitlist panel 5)                                     | few   | few         |
| physical direction classes (`ml-/mr-/text-right/right-3`)                                    | ~136 incl. geometry (~40 are real text/layout bugs)                              | ~0    | ~0          |
| screens using `PageHeader`                                                                   | 5 shared components (waitlist, reports, guests list, guest profile, placeholder) | all   | all         |
| screens with a title at all                                                                  | Today, Book, Timeline, Floor, Calendar, Overview, Settings: **no h1**            |       |             |
| `useIsMobile`/Drawer/touch sizes                                                             | none                                                                             | yes   | some        |
| Skeleton loading                                                                             | none in host views ("Loading..." text)                                           | yes   | yes         |

Palette top offenders: `timeline.tsx` 55, `floor-plan-canvas.tsx` 26,
`floor.tsx` 23 (+12 hex), `settings.tsx` 16, `settings._index.tsx` 16,
`today.tsx` 10, `settings.tables.tsx` 10, `settings.special-days.tsx` 10,
`calendar.tsx` 10, `detail-sheet.tsx` 8. ESLint
(`eslint app/components/reservations app/routes/.../reservations+`): 0 errors,
54 warnings, ALL non-design (48 `lingui/no-expression-in-message`, 4
`consistent-type-imports`, 2 `import/order`). The design lint is blind to this
drift because `no-raw-colors` allows emerald/amber/red/slate/blue and
`no-restyle` lets `Button`/`Badge`/`Card` take color. So "lint clean" is not
evidence of convergence; review by eye against Part C.

Severity: P0 clashes badly or causes wrong behavior; P1 clear inconsistency or
friction; P2 polish. Effort: S under 2 h, M half a day, L a day or more.

### B1. Shell, header and navigation (`reservations+/_layout.tsx`, `host-subnav.tsx`)

| #   | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Sev             | Fix                                                                                                                                                                                                                                                              | Effort       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | Up to FOUR stacked chrome bars before content on host views: sidebar family, `_layout` card (7 section pills + location + Date + Service), `HostSubnav` card (6 view pills + 4 actions + Date again + Service again + Area + notes), then page content. No page title. Nothing else in the app does this.                                                                                                                                                       | P0              | Replace with the Part C shell: one `PageHeader` (title = current view, actions = New reservation primary + Walk-in outline + overflow), one `WorkspaceTabBar`, one `WorkspaceToolbar` (date stepper, service, area). Delete the `_layout` Date/Service controls. | L            |
| 2   | Layout "Service" select is hard-coded `lunch/dinner/brunch` and writes `?service=`, the same param `use-host-stand` reads as a real service ID. Picking "Lunch" in the layout yields `service=lunch` which matches no service. The layout `Date` writes the same `date` param as the HostSubnav date. Layout context's `selectedDate`/`selectedService` are consumed by no screen. On Guests, Reports, Settings, Waitlist the Date/Service controls do nothing. | P0 (functional) | Remove both from `_layout.tsx`; keep Location only; date/service belong in the host toolbar of the 6 live views only.                                                                                                                                            | S            |
| 3   | Active tab is a SOLID PRIMARY pill (`bg-primary text-primary-foreground`) in `_layout` and `variant="default"` Button in `HostSubnav`. Solid green is reserved for the single primary action; here "Today" shouts louder than "New Reservation". Staff/Website/Marketing use the underline `WorkspaceTabBar`.                                                                                                                                                   | P0              | `WorkspaceTabBar`/`SectionTabs`.                                                                                                                                                                                                                                 | S            |
| 4   | Settings adds a third nav layer (`settings.tsx`): another card bar with 7 sub-tabs (`bg-secondary` active), location badge, validity badge, read-only badge. Section bar + settings bar = two competing tab rows.                                                                                                                                                                                                                                               | P0              | Settings becomes a section page with `PageHeader` "Settings" and ONE tab row (or a left vertical list on desktop, see C4). Badges move into the header meta line / a single status `Item`.                                                                       | M            |
| 5   | Native `<select>` for Location, Service, Area, Source, Tag, Section, Occasion, Table etc. (~35). Visually a different control family (`border-input bg-background h-9 rounded-md px-2.5`), OS-styled popup, no `items` labels, not RTL-aware, 32/36 px height mismatch (`h-9` layout vs `h-8` subnav).                                                                                                                                                          | P1              | `FilterSelect` (toolbars) / `SelectField` (forms); promote both to `@repo/ui` or `components/controls` (see E).                                                                                                                                                  | M            |
| 6   | Same 7 sections duplicated in sidebar sub-items and in the in-page bar, while the 6 host views are NOT in the sidebar (Today, Book, Waitlist... vs Timeline, Floor, Calendar, Overview hidden behind "Book"). `isBookSubroute` special-cases 5 routes under "Book". Mental model: "Book" is both a screen and a group.                                                                                                                                          | P1              | Rename the group; see C2 (Today / Book is a screen, views are a segmented control).                                                                                                                                                                              | M            |
| 7   | `PageHeader`/h1 absent on 7 of the main screens: screen readers and breadcrumbs have no page heading, and the page identity is carried only by a tab highlight.                                                                                                                                                                                                                                                                                                 | P1              | Every route renders `PageHeader`.                                                                                                                                                                                                                                | S per screen |
| 8   | Service Notes strip in `HostSubnav` is amber raw color (`border-amber-500/30 bg-amber-500/10 text-amber-900`) and uses `Service Notes:` prefix string; "[Lunch]" bracket text.                                                                                                                                                                                                                                                                                  | P2              | `Alert` (neutral) or `Item variant="muted"` with `Icon name="file-text"`; prefix the service as a `Badge variant="outline"`.                                                                                                                                     | S            |

### B2. Host stand

| Screen                                                   | Issue                                                                                                                                                                                                                                                                                                                                          | Sev | Fix                                                                                                                                                                                                                                                                                                                     | Effort |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Today (`today.tsx`, 763 lines)                           | Six KPI cards (`Card p-3`, `text-xl font-bold`, colored values) before the work. A host's job is seat/arrive; KPIs push the board below the fold on a tablet. Hand-rolled KPI card instead of `WorkspaceMetric`; `font-bold` is off-scale (app uses semibold).                                                                                 | P1  | One compact `WorkspaceMetricGrid` of 4 (Covers, Arriving soon, Seated, Needs attention) and collapse walk-ins/completed into the card counts. `tone="warning"` for attention (no `text-amber-600`).                                                                                                                     | M      |
|                                                          | 4-column board (Upcoming, Seated, Waitlist, Finished) at `xl`, each card row carrying up to 6 badges (VIP, table, Unassigned, channel, status, late risk, late min, occasion, dietary...) plus 3-4 buttons (Arrived, Seat, +15m, Details). Visual noise; no row has a single dominant signal; "Seat" is `size="xs"` (24 px) on a touch device. | P0  | Row = name + party + time (title), table + one status as a dot+text, notes as a single muted line, ONE primary row action (Seat, or Arrived when not arrived) at `h-11 md:h-8`, everything else in a row `DropdownMenu` / the detail sheet. Cap badges at 2 (status + attention). Finished column collapsed by default. | L      |
|                                                          | Names are raw `<button class="text-start font-semibold hover:underline">` (no focus ring, no 44 px target).                                                                                                                                                                                                                                    | P1  | `Button variant="ghost"`/link-styled `Button` or a row that is the click target.                                                                                                                                                                                                                                        | S      |
|                                                          | Empty states are dashed boxes with `text-xs` text, no icon, no action; loading has no skeleton.                                                                                                                                                                                                                                                | P1  | `EmptyState` with action ("New reservation", "Add walk-in"); skeleton rows.                                                                                                                                                                                                                                             | S      |
|                                                          | Undo banner is raw amber (`border-amber-300 bg-amber-50 text-amber-900 dark:...`) and persists above content, shifting the board.                                                                                                                                                                                                              | P1  | Use `toast` with an Undo action (the app uses `sonner`), 60 s window kept in state.                                                                                                                                                                                                                                     | M      |
| Book (`book.tsx`, 758)                                   | "Book" is a table of today's reservations with filter card (search, counters, 7 status buttons, Source select, Tag select) — it is the list view, not a booking flow. The status filter is 7 `Button size="xs"` that flip `default`/`outline` (solid green selected pill).                                                                     | P1  | Rename "List". Status as `ToggleGroup variant="segmented"` (All / Upcoming / Seated / Finished) with the rare statuses in a `FilterSelect`; hide Source/Tag behind a "Filters" popover.                                                                                                                                 | M      |
|                                                          | Hand-written `<table>` with `text-[11px]` sub lines, hand-made hover and sticky styles.                                                                                                                                                                                                                                                        | P1  | `Frame` + `Table variant="card"` (as Guests already does).                                                                                                                                                                                                                                                              | M      |
|                                                          | Search `Input` forced `h-8 text-xs` (iOS zoom).                                                                                                                                                                                                                                                                                                | P2  | Drop the `text-xs` override.                                                                                                                                                                                                                                                                                            | S      |
| Timeline (`timeline.tsx`, 1301)                          | 55 raw palette classes; status color is a 5-way raw map (`red/emerald/amber/slate/blue` `-100`/`-950/80`) with its own dark variants; `text-[10px]`/`[11px]` everywhere; bar text 11 px; resize/move buttons `text-[10px]` inside bars (about 14 px targets).                                                                                  | P0  | Map to tokens (C6); bars `text-2xs`; move controls become keyboard + drag handles (keep dnd-kit); bigger bars min height.                                                                                                                                                                                               | L      |
|                                                          | `SLOT_WIDTH_PX = 52` fixed; first column width fixed; no sticky header contrast token; horizontal scroll only. On a 768 px tablet the host sees ~6 slots.                                                                                                                                                                                      | P1  | Provide Fit/Zoom control (30/15 min, `ToggleGroup`), sticky time axis with `bg-card`.                                                                                                                                                                                                                                   | M      |
| Floor (`floor.tsx`, 1920; `floor-plan-canvas.tsx`, 1586) | 23 + 26 raw palette classes and 12 hex colors; table tile state colors are slate/emerald/sky/amber with `ring-2`; legend card `floor-section-legend`; 17 physical direction classes; `text-[10px]` labels; `min-h-[540px]` canvas inside `Card`; a "quick actions" Card AND a waitlist panel AND a legend card stacked around the canvas.      | P0  | Table tiles use position tokens (`bg-position-green/15 border-position-green/40` etc.) or the C6 map; legend becomes a one-line inline key under the toolbar; side panel is ONE tabbed `Frame` (Table / Waitlist).                                                                                                      | L      |
|                                                          | Settings floor-plan editor (`settings.floor-plan.tsx`) is embedded in the settings tab shell; editing a layout is a full-screen task (draft, save, conflict).                                                                                                                                                                                  | P1  | Full-screen editor chrome from A7 with Back, dirty dot, Save.                                                                                                                                                                                                                                                           | M      |
| Calendar                                                 | Month grid cells carry raw amber badge (`border-amber-500/40 bg-amber-500/15 text-amber-800`) and `text-[10px]` badges inside 11 px lines; own month `<select>` (`Select month`).                                                                                                                                                              | P1  | Month stepper (chevrons + label) like `ScheduleToolbar`; day cell shows covers + one dot; details on click.                                                                                                                                                                                                             | M      |
| Overview                                                 | 6 KPI Cards + 6 detail Cards (service notes, peak slots, large parties, VIPs, occasions, allergies) — a report page inside the host stand; `text-[10px]` badges; native select.                                                                                                                                                                | P1  | Use `WorkspaceMetricGrid` + `WorkspacePanel` sections; fold into Reports "Today" or keep as the "Prep" view with allergies first (safety), VIPs second.                                                                                                                                                                 | M      |
| Waitlist                                                 | Already uses `PageHeader` and dialogs; "Loading the waitlist..." text; Discord brand colors allow-listed in lint for a community button (waitlist). Sheet vs dialogs mix (Add, Edit, Seat all `Dialog`).                                                                                                                                       | P2  | Skeletons; keep dialogs (short tasks), confirm Seat remains one tap from row.                                                                                                                                                                                                                                           | S      |
| Conflict panel (`conflict-panel.tsx`, 390)               | Label "Unassigned & Conflicts" with count badge in HostSubnav is a destructive-variant button when > 0: red solid-ish button on every host view.                                                                                                                                                                                               | P1  | Surface as a `Badge variant="warning"` count on the header, open a `Sheet`; use `destructive` only for true conflicts.                                                                                                                                                                                                  | S      |

### B3. Sheets and booking flow

| Item                       | Issue                                                                                                                                                                                                                                                                                                                                                                               | Sev       | Fix                                                                                                                                                                                                                                                                       | Effort |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `booking-sheet.tsx` (1060) | One 20-field vertical scroll in `sm:max-w-xl`: lookup, date, party, time, duration, service, area, table, slot picker, name, phone, email, occasion, server, dietary, 2 notes, overrides, payment policy. Primary is at the bottom of a long scroll; an experienced host needs name + phone + party + time (4 inputs). Title "New Phone / Host Reservation" + a 2-line description. | P0 (flow) | Two-zone sheet: fixed header (title), body in 3 labelled groups (When / Who / Extras), `Extras` collapsed; footer sticky (`SheetForm`); defaults date from toolbar, duration from service, table auto-assign; guest lookup merged into the name field (combobox). See C5. | L      |
|                            | 10 native selects/inputs; `absolute top-2 right-3` "Searching..." (breaks RTL); raw button rows for results.                                                                                                                                                                                                                                                                        | P1        | `SelectField`, `Command`/`Popover` combobox, logical `end-3`.                                                                                                                                                                                                             | M      |
| `detail-sheet.tsx` (1293)  | Same `sm:max-w-xl`; many `text-xs font-semibold` pseudo-headings (`<span>`) as section titles; inline edit forms with native selects; raw amber/emerald chips; destructive actions (cancel, no-show, rotate) live in the same flat scroll.                                                                                                                                          | P1        | Header: guest, party, time, ONE status `Badge`; primary action = next status step (Arrived, Seat, Complete) in a sticky footer; sections as `Tabs variant="line"` (Details / Guest / History) to cut scrolling; destructive in an overflow menu + `AlertDialog`.          | L      |
| Both                       | No `h-11` touch sizes; footers not sticky (`SheetFooter px-0 pt-2` inside a scrolling form).                                                                                                                                                                                                                                                                                        | P1        | Use `SheetForm`/`SheetPanel` from `components/staff/sheet-frame.tsx` (move to shared).                                                                                                                                                                                    | M      |
| `walk-in-dialog.tsx`       | Good: a Dialog for a 2-field task. Check it is reachable in one tap from every host view and uses `h-11` party stepper.                                                                                                                                                                                                                                                             | P2        | Party size as large tap targets (1 to 8+).                                                                                                                                                                                                                                | S      |

### B4. Guests, Reports, Messages, Waitlist settings

| Screen                         | Issue                                                                                                            | Sev | Fix                                                                        | Effort |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------------- | ------ |
| Guests list                    | Best-aligned screen (PageHeader, `Frame` + `Table variant="card"`, `EmptyState`). Two native `<select>` filters. | P2  | `FilterSelect`.                                                            | S      |
| Guest profile (759)            | `PageHeader` yes; rtl-aware; check raw palette in tags (`guest-tag-badge.tsx`).                                  | P2  | Tag colors via position tokens.                                            | S      |
| Reports (`reports-screen.tsx`) | `PageHeader`; one native `<select>`; `report-panels.tsx` 620 lines of panels.                                    | P2  | Range as `ToggleGroup`/`FilterSelect`; panels as `WorkspacePanel`.         | M      |
| Messages settings (733)        | Longest settings form; a `Card` per message; previews.                                                           | P1  | One `Frame`; per-message `FramePanel` with `SwitchField`; sticky save bar. | M      |
| Waitlist settings (424)        | Same card-per-setting pattern.                                                                                   | P2  | Same.                                                                      | S      |

### B5. Settings

| Screen                                                                                          | Issue                                                                                                                                                                                                                                                                                                                                                                               | Sev | Fix                                                                                                                                                                                                                                                                                                             | Effort |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `settings._index.tsx` (894)                                                                     | A single `Card` with title "Booking & Channel Rules" holding 3-col grid of bordered `<label>` + native `<input type="checkbox">` rows, then selects, then the policy copy in EN/AR text areas, then a Save button inside the card, then two more cards (validation, conflicts). No hierarchy between "turn on reservations" and fine-tuning. Version badge `v{n}` exposed to users. | P0  | `Frame` with `FrameHeader`/`FramePanel` per concern (Availability, Party size, Table assignment, Policy copy), `SwitchField` rows (a real switch), Save as a sticky bottom bar when dirty with the dirty indicator; validation summary becomes a single `Alert` at the top with a link per issue; hide version. | L      |
| `settings.services.tsx` (1468)                                                                  | Biggest file; 11 native controls, `text-right` x10, `mr-1` x3, hand-built tables with inline-editable cells. Editing a service's turn times requires scanning a table of native inputs.                                                                                                                                                                                             | P0  | Table (`Frame`+`Table variant="card"`) is the list (name, days, times, turn time); click opens a `Sheet` (`SheetForm`) to edit; "Add service" is the page primary.                                                                                                                                              | L      |
| `settings.tables.tsx` (1265), `settings.sections.tsx` (915), `settings.special-days.tsx` (1099) | Same inline-editor-in-table pattern, raw palette (10 each), physical `text-right`/`ml`, native controls.                                                                                                                                                                                                                                                                            | P1  | Same list + sheet pattern; bulk actions in a toolbar.                                                                                                                                                                                                                                                           | L each |
| `settings.tsx` badges                                                                           | `mr-1` on icons inside Badges (RTL), raw emerald/amber chips for validity.                                                                                                                                                                                                                                                                                                          | P1  | `Badge variant="success"/"warning"`, `Icon` gap handled by Badge's `gap-1`.                                                                                                                                                                                                                                     | S      |
| Locations card + Roles                                                                          | Location reservations card reuses the Locations page patterns (good); role group is inside `tenant-role-access-manager` `Frame` (good). Only note: the location card toggles must use `SwitchField`.                                                                                                                                                                                | P2  |                                                                                                                                                                                                                                                                                                                 | S      |
| Dashboard block `bookings-today-block.tsx`                                                      | `Card` + `h3 text-sm font-semibold` + native `<select className="h-8 text-xs">` + 3 `dl` stats; has Skeleton (good).                                                                                                                                                                                                                                                                | P2  | Swap select for `FilterSelect`; use `WorkspaceMetric`-style stats.                                                                                                                                                                                                                                              | S      |
| `section-placeholder.tsx` (Experiences)                                                         | Follows the standard (PageHeader + EmptyState) — keep as the stub pattern.                                                                                                                                                                                                                                                                                                          | OK  |                                                                                                                                                                                                                                                                                                                 |        |

### B6. Cross-cutting UX, mobile, RTL, i18n

| Issue                                                                                                                                                                                                                                                                                                                                                                      | Sev | Fix                                                                                                                            | Effort |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Host stand is used on tablets at the stand, but touch sizes are 24 to 32 px (`size="xs"`, `h-8`, `text-[10px]`), no `h-11` variants, no `useIsMobile`.                                                                                                                                                                                                                     | P0  | Touch tier: `h-11 md:h-8` on row actions, filters, party steppers; min bar height on timeline 40 px.                           | M      |
| Clicks-to-act: seat a booked party = row Seat button (1 tap, but 24 px); seat a walk-in = Walk-in dialog (open, fill, submit = 3+); seat a waitlist party = open Seat dialog, pick table, confirm; new reservation = open sheet, scroll 20 fields. Target: Seat 1 tap, walk-in 2 taps (party size, table), new booking under 6 inputs.                                     | P1  | See C5.                                                                                                                        | L      |
| Physical direction classes in real layout/text: `settings.services.tsx` (`text-right` 10, `mr-1` 3), `settings.tsx` (`mr-1` 3), `booking-sheet.tsx` (`right-3`), `floor.tsx`/`floor-plan-canvas.tsx` (non-geometry chips), `detail-sheet.tsx` (10). Only 3 files use `rtl:`/`useDirection`. Timeline drag direction not sign-flipped for RTL (Staff day-timeline does it). | P1  | Sweep to logical classes; add `useDirection` to timeline and canvas; test with `?lng=ar`.                                      | M      |
| `Intl.DateTimeFormat('en-GB')` hard-coded in `floor.tsx` L248; `new Intl` without locale elsewhere; `lingui/no-expression-in-message` x48 (messages built with `${obj.prop}`).                                                                                                                                                                                             | P1  | Locale from request/`useLingui().i18n.locale`; bind to local vars.                                                             | S      |
| Loading and error states: text only ("Loading the waitlist..."), host views show nothing until first poll; poll error is a destructive `Alert` that stays.                                                                                                                                                                                                                 | P1  | Skeletons shaped like content; keep stale data + quiet inline "Couldn't refresh" (Waitlist already does the latter for stale). | M      |
| Color noise: amber appears as 4 different treatments (`amber-50/100/500/10/15/20/950`) for "attention", emerald as 3 for "ok"; blue/sky/slate for statuses. No legend consistency between Today badges, Timeline bars, Floor tiles.                                                                                                                                        | P0  | One status map (C6) imported by all three.                                                                                     | M      |
| Counts of controls per view: Today header zone has ~12 interactive controls before the board (7 tabs, location, date, service, 6 view tabs, 4 actions, prev/next/date/jump, service, area, refresh).                                                                                                                                                                       | P0  | C1/C2 reduces to 3 groups (tabs, actions, one toolbar).                                                                        | L      |

---

## Part C. Target design for the reservation screens

### C1. Shell

`_layout.tsx` renders `ReservationsClientProvider` + `WorkspacePage` only. Each
screen renders (in this order):

1. `PageHeader` (h1 = the view name; `description` one line; `actions`).
2. Section tab row (`SectionTabs`, 6 items max): **Today, Calendar, Guests,
   Waitlist, Reports, Settings** (+ **Experiences** when flag on). Timeline,
   Floor, List, Overview are VIEWS of a day, not sections (C2).
3. `WorkspaceToolbar` (live views only): date stepper, service, area; search on
   List; right side: refresh state.
4. Content.

Location: when `locations.length > 1`, show it as the breadcrumb-adjacent
`FilterSelect` at the left of the toolbar (and in Settings header meta); one
location means no control at all. Nothing in `_layout` besides the provider and,
for multi-location, nothing else.

### C2. Navigation simplification (sections vs views)

- Sidebar sub-items (keep, they are the global map): Today, Calendar, Guests,
  Waitlist, Reports, Settings (+ Experiences).
- Day views (`today`, `timeline`, `floor`, `book` -> `list`, `overview`) are a
  `ToggleGroup variant="segmented"` in the page header area ("Board | Timeline |
  Floor | List | Prep"), same URL params preserved. The segmented control
  replaces `HostSubnav` view tabs; it sits in the toolbar's left, date stepper
  center, filters right.
- Keep existing routes (`/today`, `/timeline`, `/floor`, `/book`...) so deep
  links and tests survive; only the chrome changes. `Calendar` moves to a top
  section (month-level, different task). Sidebar highlights "Today" for all
  day-view routes.

### C3. Header actions (host views)

- Primary: **New reservation** (default `Button`, `Icon plus`). One only.
- Secondary: **Walk-in** (`outline`).
- Overflow `DropdownMenu` ("..."): Needs attention (with count
  `Badge variant="warning"`), Refresh, Print, Export.
- "Needs attention" is also a `Badge` next to the title when > 0 and opens the
  conflict `Sheet` (not a permanent red button).
- Read-only members: primary and secondary hidden, never disabled-grey.

### C4. Settings structure

Settings = a page family with `PageHeader` "Reservations settings" and ONE tab
row, grouped to cut 7 to 5: **Rules** (general, booking & channel, policy copy,
payment policies later), **Services** (services + special days + blocks),
**Floor** (areas, tables, sections, floor plan), **Messages**, **Waitlist**.
Each tab = stacked `Frame`s (`FrameHeader` title + description, `FramePanel`
with `SwitchField`/`TextField`/`SelectField`). Lists (services, tables,
sections, special days) are `Table variant="card"` with row click -> `Sheet`
edit; "Add" is the tab's single primary in the `PageHeader.actions`. A sticky
bottom save bar appears only when dirty (dot + "Unsaved changes", Discard,
Save). Validation: one `Alert` at top, listing issues with links. The floor plan
editor is a full-screen editor (A7).

### C5. Host stand principles and the booking sheet

Principles (host stand = Operate mode on a shared tablet):

- One dominant action per row; Seat is the default row action, 44 px.
- A row shows time, name, party, table and ONE status signal; notes (allergy,
  VIP, occasion) are a single muted line with `Icon`; more in the detail sheet.
- Attention is the only colored thing: warning (late, unassigned), destructive
  (conflict, over-turn). Normal states are neutral.
- The board is live: do not reflow rows on poll; pause updates while a sheet is
  open (already designed).
- Everything the host does without a mouse: keyboard drag exists; add
  `Cmd/Ctrl+K` command item "New reservation / Walk-in" via the command menu.
- Walk-in: Dialog with party size chips (1..8, 9+), table suggestions, one "Seat
  now" primary. Two taps.

Booking sheet (`Sheet`, `sm:max-w-md`, `SheetForm`):

1. Header: "New reservation" + the date/service chip (`Badge outline`), no
   description paragraph.
2. **When**: date (prefilled), party size (stepper with 44 px targets), time
   slots as a `ToggleGroup`/chip grid from live availability (time field only
   under "Other time"). Table/area auto-assigned; "Choose table" is a link that
   reveals the select.
3. **Who**: single "Guest" combobox (phone or name search, top 5 results with
   VIP/last-visit; "New guest" row), phone, name; email optional (collapsed with
   notes).
4. **Extras** (collapsed `Collapsible`): occasion, dietary, notes, internal
   notes, server, overrides, payment policy (visible and expanded when a policy
   applies, since it changes what the guest owes).
5. Sticky footer: Cancel (ghost) + **Book** (primary). Errors inline with
   `FieldError` + a top `Alert` for server errors.

### C6. Status color mapping (to existing tokens only)

One shared module (proposed `app/utils/reservations/status-style.ts`) returning
class sets for chip/dot/bar/tile, used by Today rows, Timeline bars, Floor
tiles, Calendar, Guest history.

| Status group                                 | Meaning          | Badge                                                             | Bar/tile (no new tokens)                          |
| -------------------------------------------- | ---------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| booked, confirmed                            | upcoming, fine   | `secondary`                                                       | `bg-card border-border-strong`                    |
| pending_approval, requested, pending_payment | needs action     | `warning`                                                         | `bg-warning/12 border-warning/40`                 |
| arrived, partially_seated                    | on site, waiting | `default`                                                         | `bg-primary/10 border-primary/40`                 |
| seated                                       | in service       | `success`                                                         | `bg-success/10 border-success/40`                 |
| over turn, late risk, running late           | attention        | `warning`                                                         | add `ring-2 ring-warning/30`                      |
| conflict, unassigned                         | problem          | `destructive`                                                     | `bg-destructive/10 border-destructive/50`         |
| completed, finished                          | done             | `outline` text-muted                                              | `bg-muted/50 border-border text-muted-foreground` |
| cancelled, no_show, declined, expired        | gone             | `outline` + strike/`text-muted-foreground`; no_show `destructive` | dashed `border-border text-muted-foreground`      |
| locked table                                 | state flag       | icon `lock`, no color                                             |                                                   |
| blocked/closed table                         |                  |                                                                   | `bg-muted border-dashed`                          |

Never rely on color alone: always the status word or icon in the label. No
`blue`, `sky`, `slate`, `emerald` or `amber` Tailwind classes in new code.
User-chosen colors (tags, sections) go through `--position-*` /
`position-color`.

### C7. Density rules

- Screen body `text-sm`, metadata `text-xs`, never below `text-2xs`; no
  `text-[10px]`. Timeline bars `text-xs` with truncation, `text-2xs` only for
  the axis.
- Rows: tables `py-2.5`; host cards `p-3`, `gap-1.5`; at most two badges.
- Page rhythm `gap-6`; toolbar `gap-2`; KPI row at most 4 metrics.
- Touch: `h-11 md:h-8` for anything a host taps (row actions, filters,
  steppers).
- Cards only for grouped content that has its own title; a list of items is a
  `Frame`+`Table`, not a stack of Cards.

### C8. Empty, loading, error states

- Empty: `EmptyState` with icons, one-line why, one action ("Add a walk-in",
  "Create a service"). Filtered-empty says which filter and offers Clear.
- Loading: `Skeleton` rows in the final layout; refresh never blanks content.
- Error: initial failure = `Alert destructive` + Retry; refresh failure = quiet
  inline "Couldn't refresh, showing {time}" (waitlist already does this).
- Permission: from response status (403/404), not loader flags (AGENTS rule).
- Read-only: hide write actions; show one muted `Item` note at the top.

---

## Part D. Worker checklist for NEW reservation UI (payments panel, policies, experiences)

1. Start from `ReservationsSectionPlaceholder`/`PageHeader` + `WorkspaceTabBar`;
   never render your own header or nav bar; the route is a plain
   `<div className="flex flex-col gap-6">` inside the layout's `WorkspacePage`.
2. One primary button per page and per sheet; `outline` for the rest; `ghost`
   for row actions; destructive via `AlertDialog`.
3. Lists are `Frame` + `Table variant="card"`; row click opens a `Sheet`
   (`SheetForm`/`SheetPanel`); settings blocks are `Frame`/`FramePanel` or
   `Card size="sm"`.
4. Forms use `@repo/ui/field` (`Field`, `FieldLabel`, `FieldDescription`,
   `FieldError`) or `components/staff/controls.tsx`; toggles are `SwitchField`.
   No native `<select>`, `<input type=checkbox>`, `<table>`, `<button>` where a
   `@repo/ui` component exists.
5. Money: `tabular-nums`, `Intl.NumberFormat(locale, {style:'currency'})` with
   the organization's currency, never string concatenation; negative/refund rows
   `text-destructive`, deposits neutral. Payment status `Badge`: paid `success`,
   pending `warning`, failed/refunded `destructive`/`outline`.
6. Colors: only tokens (`primary`, `muted`, `success`, `warning`, `destructive`,
   `position-*`). No `emerald/amber/red/slate/sky/blue` classes, no hex, no
   `dark:` color overrides (tokens already switch).
7. Type: `text-sm` body, `text-xs` meta, `text-2xs` only for axes/chips; no
   arbitrary px sizes; titles via `PageHeader`/`CardTitle`/`FrameTitle`.
8. Logical CSS only (`ms-/me-/ps-/pe-/text-start/text-end/start-/end-`);
   `rtl:rotate-180` on directional icons; test with `?lng=ar`.
9. Every string through Lingui; interpolate through local variables; fill
   `ar.po`; run `node scripts/check-lingui.mjs`.
10. Touch sizes: `h-11 md:h-8` on anything tapped at the stand; icon-only
    buttons have `aria-label`.
11. States: skeleton, empty (`EmptyState` with action), error (`Alert` + Retry),
    read-only, saving (`StatusButton`/disabled + spinner), success
    (`toast.success`), all in the same layout box.
12. Loading data: `useStaffQuery`-style hooks keep stale data while refreshing;
    writes are not optimistic; send `expectedVersion`; reload on
    `stale_version`.
13. Confirm destructive or money-moving actions (refund, charge no-show fee,
    cancel prepaid) with `AlertDialog` that restates the amount and guest
    (initials/first name only; no PII in the title attr or URL).
14. Keep `data-testid`s stable; add tests next to the file; avoid
    `console.error/warn` in tests (they fail).
15. Before opening the PR: `npx eslint <paths>` (design rules only catch some
    drift), then grep your diff for `emerald|amber|slate|sky|blue|\[#|text-\[1`
    and `ml-|mr-|pl-|pr-|text-left|text-right`; both must be empty.

---

## Part E. Missing shared components and tokens (only if truly needed)

Add to `packages/ui` / shared app code, in this priority:

1. **Promote `FilterSelect`, `SelectField`, `TextField`, `TextAreaField`,
   `SwitchField`** from `apps/app/app/components/staff/` to a shared location
   (`apps/app/app/components/controls/` or `@repo/ui`). Reservations needs them
   (about 35 native selects to replace); they are already built, tested and
   RTL/touch aware. Effort S, impact high.
2. **Promote `SheetPanel`/`SheetForm`** (`staff/sheet-frame.tsx`) the same way,
   with a sticky-footer variant. Both reservation sheets need them.
3. **`StatusDot` / `StatusLabel`** (dot + text, with `tone` = neutral | primary
   | success | warning | destructive) generalizing `staff/staff-status.tsx`; the
   Reservations status map (C6) builds on it.
4. **`success-foreground`-style paired tokens are NOT needed.**
   `bg-success/10 text-success` already works (Badge). Add an **`info`** token
   ONLY if product wants a fourth attention level; the target design above does
   not.
5. **`DateStepper`** (prev, label/date popover, next, Today) extracted from
   `ScheduleToolbar` and `HostSubnav`; both implement it today. Includes
   `rtl:rotate-180` chevrons and `aria-label`s.
6. **`StatCard` is NOT needed**: use `WorkspaceMetricGrid`/`WorkspaceMetric`.
7. **Full-screen editor shell** (`EditorShell`: header h-12 Back / title / dirty
   dot / actions + muted canvas) extracted from the website page editor and
   email overlay; needed by the floor-plan editor and later by experiences
   scheduling. Low priority, M effort.
8. **ESLint**: tighten `shadcn/no-raw-colors` for
   `apps/app/app/components/ reservations` and `reservations+` (override in
   `apps/app/eslint.config.js` to disallow
   `emerald|amber|slate|sky|blue|red|orange|yellow|gray|zinc` there), and add a
   small custom check for physical direction classes. This is what would have
   prevented the 241-instance drift. Do after the cleanup so the baseline is
   zero.

## Suggested order of work

1. Shell reset (B1 #1 to #4, C1 to C3): header, tab bar, toolbar, drop layout
   Date/Service (fixes the `service=lunch` bug). Keep all routes and testids.
2. Shared status map (C6) and replace palette classes in Today, Timeline, Floor,
   Calendar (largest visual win, mechanical).
3. Promote controls (E1, E2) and replace native selects/checkboxes.
4. Today row simplification and touch sizes.
5. Booking and detail sheet restructure.
6. Settings restructure (C4) one tab at a time, with list + sheet pattern.
7. RTL and Intl sweep, skeletons, empty states.
8. Turn on the Reservations-scoped raw-color lint (E8).
