# App UI and frontend capabilities (for a Reservations module)

Scope: `apps/app` (operator App), `packages/ui`, `apps/admin`, `apps/mobile`.
Read-only investigation. All paths are absolute under `/Users/zama/menuza`.

---

## 1. Layout and navigation

**Routing.** `apps/app/app/routes.ts` runs `remix-flat-routes` through
`@react-router/remix-routes-option-adapter`. Ignored: `.*`, `*.css`, `*.test.*`,
`__*.*` (colocated helpers such as `__org-note-editor.tsx`), `*.server.*`,
`*.client.*`. `+` folders are route folders (`_app+`, `$orgSlug_+`, `staff+`,
`menu+`), `_layout.tsx` is the folder layout, `_index.tsx` is the index, dots
are segments, and a trailing `_` escapes the parent layout (for example
`team_.$staffId.tsx`).

- Org-scoped routes: `apps/app/app/routes/_app+/$orgSlug_+/` (siblings include
  `staff+/`, `menu+/` (orders live at `menu+/orders._index.tsx`),
  `phone-agent+/`, `marketing+/`, `website+/`, `settings+/`, `reports+/`,
  `dashboards+/`, `customers.tsx`, `chat.tsx`, `index.tsx` (Home dashboard)).
- Shell: `apps/app/app/routes/_app+/_layout.tsx`; sidebar
  `apps/app/app/components/app-sidebar.tsx` (owns the shell, per
  `apps/app/DESIGN.md`), rendered through `NavMain`
  (`apps/app/app/components/nav-main.tsx`) on `@repo/ui/sidebar`.
- Adding a nav entry: append an object `{ title: _(msg\`...\`), url, isActive,
  icon, items?
  }`to the`navMain`array in`app-sidebar.tsx`(around lines 281-631), then add a branch in the`visibleNavMain` `.filter()`/`.map()`
  (lines 635-716) that hides the group or sub-items.
- How Staff hides itself: `apps/app/app/root.tsx:411-434` computes `staffingNav`
  via `getStaffingNavAccess(userId, orgId)`
  (`apps/app/app/utils/staffing/access.server.ts:180`), cached 30 s with
  `cachified` key `staffing-nav:${orgId}:${userId}`, and falls back to
  `HIDDEN_STAFFING_NAV` (`apps/app/app/utils/staffing/nav.ts`) on any error. The
  sidebar reads `rootData.staffingNav`, drops the Staff group when `visible` is
  false, filters sub-items per flag+permission, and points the group URL at the
  first visible sub-item. Comment in root: a stale/failed lookup can only hide
  links, never grant access; every route re-checks.
- Route-based dialogs: `docs/decisions/023-route-based-dialogs.md` says **do
  not** use route-based dialogs; dialogs become pages with breadcrumbs. In
  practice staffing uses in-page `Sheet`s/`Dialog`s driven by component state or
  URL search params (for example `shift-editor-sheet.tsx`, `publish-dialog.tsx`,
  `copy-week-dialog.tsx`), and real pages for deep links (`team_.$staffId.tsx`,
  `hiring.applicants.$applicationId.tsx`).

## 2. Staffing UI organization

**Routes** (`apps/app/app/routes/_app+/$orgSlug_+/staff+/`): `_layout.tsx`,
`_index.tsx`, `token.ts`, `invite.ts`, `team.tsx`, `team.new.tsx`,
`team.bulk.tsx`, `team.import.tsx`, `team_.$staffId.tsx`,
`team_.$staffId.terminate.tsx`, `team_.$staffId.rehire.tsx`, `positions.tsx`,
`timeclock.tsx`, `timeclock._index.tsx`, `timeclock.rules.tsx`,
`timeclock.tablets.tsx`, `timeclock.timesheets.tsx`,
`timeclock.timesheets.new.tsx`, `timeclock.timesheets.$entryId.tsx`,
`schedule.tsx`, `schedule._index.tsx`, `schedule.time-off.tsx`,
`schedule.availability.tsx`, `labor.tsx`, `hiring.tsx`, `hiring._index.tsx`,
`hiring.new.tsx`, `hiring.$postingId.tsx`, `hiring.applicants.tsx`,
`hiring.applicants.$applicationId.tsx`, `hiring.onboarding.tsx`, plus colocated
`*-routes.test.ts`. Resource routes:
`apps/app/app/routes/resources+/staffing.*.ts`, `jobs.staffing-outbox.ts`.
Top-level non-org routes: `kiosk.tsx`, `kiosk._index.tsx`, `kiosk.pair.tsx`,
`my-schedule.tsx`.

**Components**: `apps/app/app/components/staff/**` (roster, profile tabs,
`sheet-frame.tsx`, `section-tabs.tsx`, `staff-client-provider.tsx`,
`region-staff-guard.tsx`, `reveal-gate.tsx`, `scope-wording-provider.tsx`,
`timeclock-today.tsx`, `labor/`, `onboarding/`, `schedule/`, `timesheets/`),
`components/hiring/` (applicant board with dnd-kit), `components/kiosk/`,
`components/my-schedule/`. `apps/app/app/modules/` only holds `chat/`.

**Hooks/utils**: `apps/app/app/hooks/use-staff-client.ts` (context +
`useStaffClient(scope)` + `useStaffQuery(client, path, zodSchema)`),
`hooks/use-staff-action.ts` (pending/error/field-issue wrapper for writes),
`hooks/use-live-clock.ts` (`useLiveNow`, `useVisiblePolling`),
`utils/staffing/staff-client.ts` (token pool), `utils/staffing/*-api.ts` (typed
REST calls), `*-types.ts` (Zod response schemas), `*-view.ts` (pure view math,
unit tested), `access.server.ts`, `sections.ts`, `token.server.ts`.

**Typical page flow**

1. `staff+/_layout.tsx` loader:
   `requireStaffingAccess(request, orgSlug, { feature: 'enabled', anyOf })`,
   then renders `ScopeWordingProvider` + `StaffClientProvider` (creates a
   per-org token pool; `forgetAll()` on unmount).
2. Section layout (`schedule.tsx`) re-checks access and only decides tabs; child
   loader (`schedule._index.tsx`) re-checks again (`requireScheduleAccess`) and
   returns only non-PII data (scope names/time zones). `shouldRevalidate`
   returns false unless `orgSlug` changes, because all data is browser-direct
   and view state is in the URL.
3. Component (`schedule-page.tsx`) calls `useStaffClient('schedule')`; the pool
   fetches `GET /:orgSlug/staff/token?scope=schedule` (`staff+/token.ts`:
   membership → flag (404) → permission (403) → `mintStaffingToken`, returns
   `{ jwt, tenantApiUrl, scope, grants, expiresAt, scopeIds }`, 15 min / 5 min
   for pay/private grants), then calls tenant-api `/operator/schedule/...` with
   Bearer auth.
4. Reads: `useStaffQuery` keeps old data while refreshing; parses with Zod;
   `reload()`.
5. Writes: not optimistic. Set a `busyShiftId` (block pulses, drags disabled),
   call the API with `expectedVersion` (optimistic concurrency), toast on error
   via `sonner`, reload on stale error, always `reload()` in `finally`. Poll
   with `useVisiblePolling(reloadWeek, 60_000)` while no editor/dialog is open.

An older, simpler variant: `customers.tsx` returns `{ jwt, tenantApiUrl }` from
the loader via `getOperatorTenantClient`; orders use
`hooks/use-orders-client.ts` (fetch `/:orgSlug/orders-token`, cache 10 min,
retry once on 401).

**Scheduling grid/timeline** (`apps/app/app/components/staff/schedule/`):

- `week-grid.tsx`: CSS-grid rows (people/positions) × 7 day cells; each cell is
  a `useDroppable`; shifts are `ShiftBlock` (`shift-block.tsx`).
- `day-timeline.tsx`: closest analog to a reservation timeline. Fixed
  `HOUR_PX = 56` (tablet-friendly), `PX_PER_MINUTE`, visible range 08:00-24:00
  widened by data, lanes per row, absolutely-positioned bars. Position uses a
  CSS var plus logical class: `style={{ '--shift-start': left+'px', width }}`
  with `start-(--shift-start)` so it mirrors in RTL. Move = dnd-kit
  `useDraggable`; resize = hand-rolled pointer-capture edge handles with a live
  preview, sign-flipped for RTL (`useDirection()` from `@repo/ui`). Snapping via
  `TIME_STEP_MINUTES` in `utils/staffing/schedule-view.ts`.
- `schedule-dnd.tsx`: shared `DndContext` with Pointer/Touch/Keyboard sensors,
  custom collision (`pointerWithin` then `closestCenter`), `DragOverlay`,
  localized screen-reader `Announcements`, and a custom keyboard coordinate
  getter (arrows jump cells, or slide by one step on the timeline). Tested in
  `schedule-dnd.test.ts`.
- Also `month-view.tsx`, `day-list.tsx` (phone), `use-block-keys.ts` (keyboard
  copy/paste/delete), `schedule-toolbar.tsx`, `scope-picker.tsx`,
  `demand-strip.tsx`, `forecast-strip.tsx`.

## 3. Libraries available

Declared in `apps/app/package.json`:

- Drag and drop: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/modifiers`,
  `@dnd-kit/utilities` (used in schedule, hiring board, menu sorting, form
  builder).
- Graph canvas: `@xyflow/react` (App and `packages/flow-editor`; used in
  `components/phone-agent/flow-editor/`).
- Grid layout: `react-grid-layout` v2 (dashboards; brings `react-draggable`,
  `react-resizable` transitively).
- Tables: `@tanstack/react-table` (used in
  `routes/_app+/$orgSlug_+/notes-table.tsx`). TanStack Query is NOT a dependency
  (only transitive in node_modules); do not import it.
- Dates: `date-fns` v4 (App and UI). No luxon/Temporal; `dayjs` only transitive.
  Time-zone math lives in `@repo/staffing` (`localMinuteOfDay`, etc.) and
  `Intl`.
- Calendar/date picker: `react-day-picker` v9 via `@repo/ui/calendar`.
- Charts: `recharts` via `@repo/ui/chart`.
- Other: `cmdk` (command), `vaul` (drawer), `sonner` (toasts), `motion` (UI
  pkg), `react-resizable-panels` (`@repo/ui/resizable`), `embla-carousel-react`,
  `hotkeys-js`, `qrcode`, `@tiptap/*`, `spin-delay`, `@floating-ui/dom`.
- Not present: `react-konva`/`konva`, `fabric`, `react-moveable`,
  `@use-gesture`, any virtualization library (`@tanstack/react-virtual`,
  `react-window`).

Fit:

- Timeline grid: reuse the day-timeline approach (absolute bars in lanes,
  dnd-kit for move/drop-on-table, pointer-capture resize). No new library
  needed.
- Floor-plan editor: no transform library exists. Options: (a) plain DOM/SVG
  with absolutely positioned elements, dnd-kit (with `@dnd-kit/modifiers` grid
  snapping / restrictToParentElement) for move, custom pointer handles for
  resize/rotate (same technique as timeline resize); allowed inline styles
  include `left/top/width/height/transform/transformOrigin`; (b) `@xyflow/react`
  is already bundled and gives pan/zoom, selection, `NodeResizer`, but no
  rotation and its graph/edge model is a poor fit. Recommend (a), optionally SVG
  for the room. Adding Konva would be a new dependency and canvas content is not
  accessible.

## 4. Real-time

- Team chat: WebSocket from browser to App Worker `/:orgSlug/chat/ws`, then
  `ChatOrg` Durable Object per org (`apps/app/workers/chat-org.ts`,
  `apps/app/app/utils/chat/upgrade.server.ts`, `apps/app/app/hooks/use-chat.ts`,
  `docs/team-chat.md`). This is US control-plane; it must not carry regional
  guest PII.
- SSE: `apps/app/app/routes/api+/notifications+/stream.tsx`
  (`text/event-stream`, but it polls D1 every 3 s internally, keep-alive 30 s).
  E2E fixtures abort this stream globally.
- Polling helpers: `useVisiblePolling(reload, ms)` and
  `useLiveNow(ms, offsetMs)` in `apps/app/app/hooks/use-live-clock.ts` (pause
  when tab hidden, reload on return, server clock offset for timers). Intervals
  in use: timeclock today 30 s, schedule/labor/timesheets 60 s, orders 15 s
  (`menu+/orders._index.tsx` uses its own `setInterval` + visibility check).
- tenant-api push: none. No WebSocket or SSE in `apps/tenant-api/src`. US node
  runs Hono inside `TenantOrg` Durable Object
  (`apps/tenant-api/workers/tenant-org.ts`, with alarms) which could host
  hibernatable WebSockets, but the KSA node is Node (`@hono/node-server`) with
  no ws support, so any push would need two implementations.
- Practical approach: polling with `useVisiblePolling` at 5-15 s for the host
  stand, `useLiveNow` for seated timers, version fields for conflict handling,
  optionally an ETag/`since` cursor endpoint to keep polls cheap. A later option
  is a PII-free "changed" ping (id/count only) over a push channel.

## 5. i18n (Lingui)

- Config: `apps/app/lingui.config.ts`, locales `en` (source) and `ar`; catalogs
  `apps/app/app/locales/{en,ar}.po`. Includes `app` plus `packages/ai`,
  `packages/marketing`, `packages/reports/src/ui`,
  `packages/marketing-workflow`. A new package with UI strings must be added to
  `include`.
- Usage: `import { t, msg, Trans, Plural, plural } from '@lingui/macro'` and
  `const { _, i18n } = useLingui()` from `@lingui/react`; patterns
  `_(t\`...\`)`, `_(msg\`...\`)`, `<Trans>...</Trans>`, `<Plural>`. Non-UI modules return `MessageDescriptor`s (see `use-staff-action.ts`). `eslint-plugin-lingui` `flat/recommended`is on in`apps/app/eslint.config.js`.
- Commands: `npm run lingui:extract` (root delegates to `-w app`);
  `npm run lingui:check` (`scripts/check-lingui.mjs`) fails when a source string
  is not extracted, any non-source catalog has an empty `msgstr` (Arabic must be
  translated), or `.po` files have unstaged changes. It runs in
  `.husky/pre-commit`; no GitHub workflow references it.
- RTL: use logical Tailwind utilities (`start-*`, `end-*`, `ps-*`, `pe-*`,
  `ms-*`, `text-start`), `useDirection()` from `@repo/ui` for pointer-math sign
  flips, `<bdi>` + `tabular-nums` for times and numbers. Dashboards mirror
  layout for display and store unmirrored. A floor plan should store canonical
  (LTR) coordinates; decide explicitly whether to mirror the room (likely not,
  since a physical room has a fixed geometry).

## 6. Design system

- `@repo/ui` primitives are built on `@base-ui/react` (not Radix, despite
  AGENTS.md), plus `vaul`, `cmdk`, `sonner`, `react-day-picker`.
- Components (`packages/ui/components/ui/`): accordion, alert, alert-dialog,
  aspect-ratio, avatar, badge, breadcrumb, button, button-group, calendar, card,
  carousel, chart, checkbox, collapsible, command, context-menu, dialog, drawer,
  dropdown-menu, empty, field, hover-card, input, input-group, input-otp, item,
  kbd, label, menubar, navigation-menu, pagination, popover, progress,
  radio-group, resizable, scroll-area, select, separator, sheet, sidebar,
  skeleton, slider, sonner, spinner, switch, table, tabs, textarea, toggle,
  toggle-group, tooltip. Extras in `packages/ui/components/`: page-header,
  page-title, frame, filters, status-button, position-color (`PositionDot`,
  `positionBlockClass`), priority-signal, color-picker, image-cropper,
  annotated-layout, icon, logo, not-found-page. Check `packages/ui/package.json`
  `exports` before importing: accordion, context-menu, aspect-ratio,
  button-group, menubar, navigation-menu and pagination exist as files but are
  not exported.
- Lint: `packages/config/eslint-preset.js`. `shadcn/no-restyle` allows `layout`
  everywhere plus per-component contracts (for example `Badge`/`TableCell` may
  set color/shape/spacing/typography; `DialogContent` only layout/shape/spacing;
  `SheetContent` layout/color/spacing; `Button` broad). `no-raw-colors` allows
  only emerald/green/blue/orange/amber/yellow/red/gray/slate/zinc palettes for
  status, otherwise theme tokens. `no-arbitrary-values` allows layout values and
  a fixed list. `no-inline-styles` allows only dynamic props (`left`, `top`,
  `width`, `height`, `transform`, `transformOrigin`, `backgroundColor`, `color`,
  `opacity`, `zIndex`, `cursor`, ...); CSS custom properties are used for
  logical positioning. `require-static-classes` is on. `cn` comes from
  `@repo/ui` (`cn` package).
- Theme tokens: `apps/app/app/styles/tailwind.css`.
- Patterns: tables `Table variant="card"` inside
  `Frame`/`FrameHeader`/`FrameTitle` (admin flags page) or TanStack Table
  (notes); side panels `Sheet` with `SheetPanel` chrome
  (`components/staff/sheet-frame.tsx`); confirmations `AlertDialog`; section
  tabs `components/staff/section-tabs.tsx` (link tabs) or `@repo/ui/tabs`;
  status `Badge` variants default/secondary/destructive/outline/ghost/link plus
  palette status colors; toasts `toast.*` from `sonner` (Toaster in
  `components/toaster.tsx`); headers `PageHeader`; empty
  `Empty`/`components/empty-state.tsx`; mobile `Drawer` and `useIsMobile`.

## 7. Dashboards

Documented in `apps/app/README.md#dashboards`. Registry
`apps/app/app/utils/dashboards/config.ts`
(`BUILT_IN_BLOCK_TYPES = ['stats','notes-chart','onboarding','leaderboard']`
plus `report`; `BLOCK_DEFINITIONS` with Lingui title/description, sizes,
`maxInstances`). Steps: add type and definition; if it needs server data extend
`loadBuiltInBlockData()` in `utils/dashboards/block-data.server.ts`; add a
component in `components/dashboard/blocks/` plus a `case` in
`dashboard-block-content.tsx`; visibility in `utils/dashboards/visibility.ts`;
extract strings; extend tests.

A "Today's reservations" block is feasible, but guest data must not go through
the server loader. Follow the report block, which already fetches the regional
tenant-api from the browser with a short-lived token
(`components/dashboard/blocks/report-block-result.tsx`, `tokenUrl` and
`tenantApiUrl`; test `report-block.test.tsx`). Server data should be limited to
flag/permission visibility (hide via `hiddenBlockIds`).

## 8. Admin app flags

UI: `apps/admin/app/routes/_admin+/feature-flags.tsx` with
`apps/admin/app/components/admin/feature-flags.tsx` (sidebar link in
`components/admin-sidebar.tsx`). Tabs System / Organization / User. The
Organization tab takes a raw organization ID, then lists **only keys that
already exist as system flags**, each with "Add/Edit Override"
(`OverrideDialog`, `level="organization"`). Writes `ConfigFlag` rows (key,
level, organizationId, userId, JSON value). Staffing keys are not hard-coded in
Admin; `docs/staffing.md` says to set them on this page (boolean, organization
level). Resolution in `packages/common/src/feature-flags.server.ts`
`getFeatureFlag`: user, then organization, then system. Staffing treats only
literal `true` as on (`isFlagOn` in `packages/staffing/src/flags.ts`). Admin
per-org pages (`routes/_admin+/organizations+/$organizationId_+/`) have no flag
panel.

## 9. Operator mobile app

`apps/mobile` (Expo 54, RN 0.81, uniwind): only `(auth)` screens,
`(dashboard)/index.tsx`, `organizations.tsx`, `create-organization.tsx`,
`settings/{index,profile,security}.tsx`. No staffing, orders, or customers.
Reservations on mobile would be new work.

## 10. UI testing

- Playwright: `apps/app/playwright.config.ts` (tests in `apps/app/tests/e2e`, 60
  s timeout, CI runs `npm run start:mocks` on the production build, otherwise
  reuses `npm run dev` on :3001; env forces `MOCKS=true`,
  `LAUNCH_STATUS=LAUNCHED`, and mock OAuth integration creds, including
  `OPENTABLE_*` and `RESY_*`).
- Fixtures: `apps/app/tests/playwright-utils.ts` exports `test` with `login()`
  (inserts user + session, sets cookie), `insertNewUser`, `navigate`,
  `prepareGitHubUser`; the page fixture sets cookie consent and aborts the
  notifications SSE. Seeding: `createTestOrganization(userId, role)` in
  `apps/app/tests/test-utils.ts`; flags inserted directly with
  `db.insert(ConfigFlag)` and removed in cleanup (see
  `enableScheduling`/`dropFlags` in `tests/e2e/staff-schedule.test.ts`).
- tenant-api is not running in e2e. Staff specs (`staff-schedule`,
  `staff-roster`, `staff-timeclock`, `staff-timesheets`, `staff-labor`,
  `staff-hiring`, `staff-applicants`, `staff-region-guard`) stub
  `**/operator/<area>/**` with `page.route`, CORS headers and the Zod-parsed
  response shapes; App routes (flags, token mint, loaders) are real.
- Vitest: `apps/app/vite.config.ts` `test.include ./app/**/*.test.{ts,tsx}`,
  setup `tests/setup/setup-test-env.ts`, default env `node`; component tests
  start with `// @vitest-environment jsdom`, render with `renderStaff()`
  (`apps/app/tests/staff-render.tsx`: English Lingui + `MemoryRouter`), and stub
  `fetch` with `vi.stubGlobal` to answer the token URL and API paths
  (`schedule-page.test.tsx`). Fixtures sit next to utils
  (`utils/staffing/schedule-fixtures.ts`). Route tests are colocated
  (`*-routes.test.ts`). Security sweep:
  `apps/app/app/utils/staffing/staffing-guards.test.ts` statically checks every
  `staff+/` loader/action awaits a guard first.

---

## Recommendations for reservation screens

- **Routes**: `apps/app/app/routes/_app+/$orgSlug_+/reservations+/` with
  `_layout.tsx` (guard + client provider), `_index.tsx` (book), `floor.tsx`
  (host stand), `floor-plan.tsx` (editor, full-screen draft with explicit Save,
  like the email designer), `waitlist.tsx` or a panel in the host stand,
  `settings.tsx` (+ `settings.shifts.tsx`, `settings.policies.tsx`),
  `guests.tsx`, `guests.$guestId.tsx`, `token.ts`. Use pages for deep links and
  Sheets for in-place edit (no route-based dialogs).
- **Data access**: copy the Staff pattern: `requireReservationsAccess()`
  (session → flag 404 → permission 403) in every loader/action; a `token.ts`
  that mints short-lived scoped grants; a client pool provider + `useXClient` /
  `useXQuery` (Zod-parsed) / `useXAction` hooks; loaders return only non-PII
  config; `shouldRevalidate` false within the org.
- **Timeline (book grid by shift)**: model on `day-timeline.tsx` +
  `schedule-dnd.tsx`: lanes = tables (grouped by room/section), x = time, bars
  absolutely positioned with a CSS var and logical `start-*`; dnd-kit drag to
  another lane or time; pointer-capture resize for duration; keyboard sensor +
  announcements; snap to the pacing interval; `date-fns` + `Intl` with the
  org/location time zone. List view: `Table variant="card"` or TanStack Table.
- **Floor-plan editor**: DOM/SVG absolutely positioned tables in a room
  container; dnd-kit (+ modifiers for grid snap and bounds) for move; custom
  handles for resize and rotate writing `transform: rotate()` (inline
  `transform`/`width`/`height`/`left`/`top` are lint-allowed); store canonical
  coordinates in room units, scale to viewport; arrow-key nudging; draft state
  with explicit Save and version check. Consider `@xyflow/react` only if
  pan/zoom becomes essential.
- **Live host stand**: same floor renderer read-only plus status colors (palette
  status colors or theme tokens) and `Badge`; drag a reservation/waitlist card
  (dnd-kit droppable per table) to seat;
  `useLiveNow(30_000 or 10_000, serverOffset)` for timers; `useVisiblePolling`
  at 5-15 s paused while a sheet or drag is active; `expectedVersion` on writes,
  `sonner` toasts and reload on conflict; busy-state pulse instead of optimistic
  updates (or narrowly optimistic for seat/unseat with rollback).
- **Settings**: Card + Field + conform/Zod forms, `Switch`, `Select`, `Slider`,
  `Calendar`; mirror `labor-policy-editor.tsx` and `timeclock.rules.tsx`.
- **Dashboard block**: optional "Today's reservations" block that fetches
  browser-direct like the report block.
- **Tests**: Vitest jsdom component tests with fetch stubs; pure view math in
  `utils/reservations/*-view.ts` with unit tests; Playwright specs that insert
  flags and stub `**/operator/reservations/**`; a `reservations-guards.test.ts`
  sweep like `staffing-guards.test.ts`.

## Constraints workers must follow

1. No guest PII in App loaders, actions, SSR HTML, the dashboard server loader,
   D1, or the chat Durable Object. The browser calls the regional tenant-api
   with short-lived operator tokens. Control-plane holds only flags,
   permissions, opaque ids, and non-PII config.
2. Every loader and action awaits the access guard first (flag off = 404,
   missing permission = 403); parent layouts do not protect children. Token mint
   checks the flag before signing.
3. Sidebar entries are computed server-side from flags and permissions (root
   loader, cached, fail-closed to hidden), and the server still enforces.
4. Use `@repo/ui` components (Base UI) and their variants; obey
   `shadcn/no-restyle` contracts, theme tokens, permitted palettes, and the
   inline-style allowlist; use `cn` from `@repo/ui`; no `clsx` or
   `tailwind-merge`.
5. Every string goes through Lingui (`t`/`msg`/`Trans`/`Plural`); run
   `npm run lingui:extract` and fill Arabic `msgstr` so `npm run lingui:check`
   passes; add any new UI package to `lingui.config.ts` `include`.
6. RTL: logical utilities, `useDirection()` for pointer math, `<bdi>` for times
   and numbers; test in Arabic.
7. No route-based dialogs (ADR 023); overlays must have obvious exits; the
   floor-plan editor is an explicit-Save draft.
8. Do not add new libraries for what dnd-kit, date-fns, TanStack Table,
   react-day-picker, and recharts already cover; TanStack Query is not a
   dependency.
9. Polling (`useVisiblePolling`) is the supported live-update mechanism today;
   tenant-api has no push channel on either runtime.
10. Admin per-org overrides need an existing system-level flag key (for example
    `reservations.enabled` = false) before the Organization tab shows it. Only
    literal `true` enables a feature.
11. Conventions from AGENTS.md: `ignored` prefix for unused vars, inline `type`
    imports, import order, Zod for all inputs, colocated tests.
