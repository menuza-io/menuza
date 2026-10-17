# App UI patterns (operator App, `apps/app`)

What belongs here: rules and reusable building blocks for the Reservations
operator screens in `apps/app`, including the `apps/app/AGENTS.md` rules that
workers must follow.

What does NOT belong here: the route-by-route screen list and loader contracts
(see `architecture.md` section 10), tenant-api and token internals (see
`staffing-patterns.md`), Sites pages (see `sites-patterns.md`).

Paths are relative to `/Users/zama/menuza` and were verified.

## Rules from `apps/app/AGENTS.md` (must follow)

- Sandbox start: `cd apps/app && VITE_DIRECT_DEV=1 npm run dev` (mission
  services table). The AGENTS.md form is
  `VITE_DIRECT_DEV=1 VITE_HMR_PORT=3001 npm run dev -w app`. Health check:
  `/resources/healthcheck`.
- Vitest, typecheck and dev need one prior `npm run build` (gitignored `dist` of
  `@repo/observability`, `@repo/security`, and the icon sprite).
- Single fetch: client data requests go to `<path>.data` (`/` becomes
  `/_.data`). A redirect thrown over `.data` returns HTTP 202 with the redirect
  in the body.
- `request.url` is the raw `.data` URL. Build user-facing URLs and `redirectTo`
  from the `url` argument.
- `window.fetch` is called with strings, `URL` and `Request` objects. A fetch
  wrapper or Playwright stub must handle all three.
- To check authorization by hand, POST `FormData` with the route's `intent` to
  the document URL and read the status. Index routes need `?index`.
- `@repo/ui` is Base UI (`@base-ui/react`), not Radix. Import by path
  (`@repo/ui/button`, `@repo/ui/sheet`, `@repo/ui/icon`).
- Use `render`, not `asChild`: `<Button render={<Link to="..." />}>`. Other
  triggers may need `nativeButton={false}` when the rendered element is not a
  `<button>`.
- Icons: `<Icon name="plus" />`. New SVGs go in `packages/ui/other/svg-icons/`,
  then run `npm run generate:icons` (it rewrites the tracked
  `packages/ui/components/icons/`).
- Design lint (header of `packages/config/eslint-preset.js`): use theme tokens
  and existing variants. If `shadcn/no-restyle` fails, fix the call site.
- `cn` comes from `@repo/ui`; never add `clsx` or `tailwind-merge`. Wrap long
  user-supplied names with `wrap-anywhere`.
- Lingui: wrap text with `Trans`, `t` or `msg` from `@lingui/macro`; use
  `useLingui()` from `@lingui/react` for `_()`.
- After text changes run `npm run lingui:extract -w app`, fill every new
  `msgstr` in `apps/app/app/locales/ar.po`, and verify with
  `node scripts/check-lingui.mjs`. It fails on unextracted strings, an empty
  `msgstr`, or an unstaged `.po` file.
- A new package with UI strings must be added to the `include` list in
  `apps/app/lingui.config.ts`. `@repo/reservations` has no UI strings by design.
- Forms: Conform (`parseWithZod`) + Zod. Fetcher routes with several actions
  parse `FormData` with a Zod discriminated union on `intent` (see
  `apps/app/app/utils/dashboards/actions.server.ts`).
- Status codes: 404 when the user may not know the resource exists (also when
  the flag is off), 403 when they can see it but lack the right, 401 when signed
  out.
- Decide "no access" UI from the actual response status, never from loader
  permission flags (see `refusalError` in
  `packages/reports/src/ui/use-report-runner.ts` and `isReportAccessDenied` in
  `apps/app/app/utils/dashboards/reports.ts`). Flags may only hide entry points.
- `useFormAction()` with no argument includes `location.search`. Use
  `useFormAction('.')` for effect dependencies and cache keys.
- Tests: `cd apps/app && npx vitest run <paths>` (only
  `app/**/*.test.{ts,tsx}`). `tests/setup/setup-test-env.ts` turns
  `console.error` and `console.warn` into failures. For bug fixes, write the
  failing test first.
- E2E: `npm run build -w app`, then
  `cd apps/app && PORT=3101 CI=true npx playwright test <spec> --workers=1`.
  Check new specs with `--retries=0 --repeat-each=3`. Limits: 60 s per test, 15
  s per `expect`.
- Never wait for `networkidle` (the notifications SSE stays open); wait for
  elements or responses.
- Browser testing: fresh context per user, open `/login` directly, accept the
  cookie banner, two-step login. Do not log out to switch users. Arabic:
  `?lng=ar`.
- Lint and types: `npm run lint -w app` and `npm run typecheck -w app` (with
  `NODE_OPTIONS=--max-old-space-size=4096`; never run both at once). The App
  ESLint baseline is 59 pre-existing errors in menu files; add none.
- After Vitest, builds or dev servers, restore the regenerated
  `packages/reports/src/env.ts` and `packages/security/src/env.ts`; never commit
  them.
- Code style (root AGENTS.md): inline `type` imports; import order external,
  then `@repo/*`, then `#app/*`, then relative; unused names prefixed `ignored`;
  Zod for every input; colocated tests.

## Residency rules for App code

- No guest PII in App loaders, actions, SSR HTML, D1, the dashboard server
  loader, MCP tools or the chat Durable Object.
- Loaders return ids, flags, location facts and `can` booleans only. All guest
  data is fetched in the browser from the regional tenant-api with an `rsv+jwt`
  token.
- Every reservations loader and action awaits `requireReservationsAccess` first
  (enforced by a static guard test). No `clientLoader` or `clientAction`. Parent
  layouts do not protect children.
- `shouldRevalidate` returns false within the org (data is browser-direct and
  view state is in the URL).

## Navigation and entry points

- Routes live in `apps/app/app/routes/_app+/$orgSlug_+/reservations+/`.
  Flat-route rules: `+` folders, `_layout.tsx`, `_index.tsx`, dots are segments,
  a trailing `_` escapes the parent layout; `*.server.*`, `*.client.*`,
  `*.test.*` and `__*` files are not routes.
- Sidebar: `apps/app/app/components/app-sidebar.tsx` (the `navMain` array, then
  the `visibleNavMain` filter/map hides groups and sub-items).
- Visibility comes from the root loader in `apps/app/app/root.tsx`. Staff uses
  `staffingNav` (`cachified` 30 s, key per org and user, hidden on error; stale
  data can only hide links). Reservations adds an equivalent `reservationsNav`.
- Location settings card:
  `apps/app/app/routes/_app+/$orgSlug_+/settings+/locations.$locationId.tsx`
  hosts the Reservations card (mission milestone 2).
- Region switch guard pattern (counts, typed confirmation):
  `apps/app/app/components/staff/region-staff-guard.tsx` and
  `apps/app/app/utils/staffing/region-guard.server.ts`.
- Role editor group:
  `apps/app/app/components/roles/tenant-role-access-manager.tsx`.

## Dialogs, sheets, editors

- ADR `docs/decisions/023-route-based-dialogs.md`: no route-based dialogs. Use
  in-page `Sheet`/`Dialog` driven by state or search params, and real pages for
  deep links.
- Reservation detail is a `Sheet` opened by `?r=<id>`. Chrome:
  `apps/app/app/components/staff/sheet-frame.tsx` (`SheetPanel`). Confirmations
  use `AlertDialog`. Section tabs:
  `apps/app/app/components/staff/section-tabs.tsx` or `@repo/ui/tabs`.
- Full-screen editors are drafts with an explicit Save and an obvious exit
  (precedent:
  `packages/marketing/src/components/email/email-design-overlay.tsx`).
- The floor plan editor saves with `floorPlanVersion`; a stale version is shown
  as a conflict.
- Other primitives: `Table variant="card"` in `Frame`/`FrameHeader`;
  `@tanstack/react-table` (used in `notes-table.tsx`); `Badge` variants;
  `PageHeader`; `Empty` or `components/empty-state.tsx`; `Drawer` plus
  `useIsMobile` on phones; toasts via `sonner` (`toast.*`).
- Before importing an `@repo/ui` component, check the `exports` in
  `packages/ui/package.json`. Accordion, context-menu, aspect-ratio,
  button-group, menubar, navigation-menu and pagination exist as files but are
  not exported.

## Data access hooks (copy from Staff)

- Token pool: `apps/app/app/utils/staffing/staff-client.ts`.
- Provider: `apps/app/app/components/staff/staff-client-provider.tsx` (forgets
  tokens on unmount).
- Hooks: `apps/app/app/hooks/use-staff-client.ts` (`useStaffClient(scope)`,
  `useStaffQuery(client, path | null, zodSchema)`, which keeps old data while
  refreshing) and `apps/app/app/hooks/use-staff-action.ts`.
- Writes are not optimistic: set a busy id (pulse, drags disabled), send
  `expectedVersion`, toast on error, reload on `stale_version`, and always
  reload in `finally`.
- Per-area files: `*-api.ts`, `*-types.ts` (Zod from `@repo/reservations`),
  `*-view.ts` (pure, unit-tested), `errors.ts` (code -> Lingui message).
- Do not use TanStack Query (it is only a transitive dependency).

## Live updates (ETag polling only)

- `apps/app/app/hooks/use-live-clock.ts` provides
  `useVisiblePolling(reload, ms)` (pauses when the tab is hidden, reloads on
  return) and `useLiveNow(ms, offsetMs)` (server clock offset for timers).
- Intervals (mission): host stand, floor and waitlist 5 s; book and timeline 10
  s; calendar, overview and the `bookings-today` dashboard block 60 s; Guestbook
  and settings none. Timers tick every 15 s.
- Polling pauses during drags and while a sheet or editor is open.
- Send `If-None-Match` with the last ETag; 304 means no change.
  `/changes?since=<dayVersion>` is the cheapest probe.
- No WebSockets. tenant-api has no push channel (KSA is Node). The App chat
  WebSocket is control-plane and must never carry guest data.

## Timeline and drag and drop

- Model on `apps/app/app/components/staff/schedule/day-timeline.tsx`:
  - fixed `HOUR_PX = 56`, absolutely positioned bars in lanes;
  - position via a CSS var plus a logical class,
    `style={{ '--shift-start': left + 'px', width }}` with
    `start-(--shift-start)`, so it mirrors in RTL;
  - move via dnd-kit `useDraggable`;
  - resize via pointer-capture edge handles with live preview, sign-flipped for
    RTL using `useDirection()` from `@repo/ui`;
  - snap step from `apps/app/app/utils/staffing/schedule-view.ts`.
- `apps/app/app/components/staff/schedule/schedule-dnd.tsx` has the shared
  `DndContext`: Pointer, Touch and Keyboard sensors; collision `pointerWithin`
  then `closestCenter`; `DragOverlay`; localized screen-reader `Announcements`;
  a custom keyboard coordinate getter. Tested in `schedule-dnd.test.ts`.
- Reservations must have keyboard drag and drop with spoken announcements.
- Lanes are tables grouped by area, with an unassigned lane on top and a pacing
  strip (see `demand-strip.tsx`, `forecast-strip.tsx`).
- Drop on a table asks Assign vs Lock. Drop on an occupied table offers swap,
  move the other party (if soft) or overbook. A locked party asks "Unlock and
  move?". Show automatic moves to hosts after each write.

## Floor plan (editor and live view)

- Plain DOM/SVG with absolutely positioned tables in an area container. dnd-kit
  (with `@dnd-kit/modifiers` for grid snap and bounds) for move; custom pointer
  handles for resize and rotate; arrow-key nudge.
- No new canvas library (no Konva or fabric). `@xyflow/react` exists but is a
  poor fit.
- Inline styles are lint-allowed only for dynamic props (`left`, `top`, `width`,
  `height`, `transform`, `transformOrigin`, `backgroundColor`, `color`,
  `opacity`, `zIndex`, `cursor`, ...).
- Store canonical LTR coordinates in canvas units (`canvas_w` 1200 x `canvas_h`
  800 by default) and scale to the viewport. In RTL, mirror the surrounding
  chrome but not the room geometry or numbers.
- Live view: tables colored by status with timers; drag a reservation or
  waitlist card onto a table to seat; section overlay.
- Section colors are theme-token keys (the `PositionDot` palette in
  `packages/ui/components/position-color.tsx`).
- Status colors come only from permitted palettes (`no-raw-colors` allows
  emerald, green, blue, orange, amber, yellow, red, gray, slate, zinc) or theme
  tokens (`apps/app/app/styles/tailwind.css`). Never hex in App UI.

## RTL and locale formatting

- Use logical utilities (`start-*`, `end-*`, `ps-*`, `pe-*`, `ms-*`,
  `text-start`), `useDirection()` for pointer math, and `<bdi>` plus
  `tabular-nums` for times and numbers.
- Times are restaurant-local (location time zone), formatted with `Intl` or
  `date-fns` v4. Zone math comes from `@repo/zoned-time` via
  `@repo/reservations`.
- Calendar picker: `react-day-picker` v9 via `@repo/ui/calendar`. Charts:
  `recharts` via `@repo/ui/chart`.

## Dashboard block (`bookings-today`)

- Registry: `apps/app/app/utils/dashboards/config.ts` (`BUILT_IN_BLOCK_TYPES`,
  `BLOCK_DEFINITIONS`).
- Component in `apps/app/app/components/dashboard/blocks/` plus a `case` in
  `dashboard-block-content.tsx`.
- Visibility: `apps/app/app/utils/dashboards/visibility.ts` (`hiddenBlockIds`
  without the flag and permission).
- Fetch browser-direct like the report block
  (`apps/app/app/components/dashboard/blocks/report-block-result.tsx`,
  `tokenUrl` + `tenantApiUrl`), never through `loadBuiltInBlockData()` in
  `block-data.server.ts`. Refresh every 60 s.
- Naming: the mission names the block `bookings-today`; the architecture draft
  called it `reservations-today`. Use the mission name.

## Tests

- Component tests: `// @vitest-environment jsdom`; render with
  `apps/app/tests/staff-render.tsx` (English Lingui + `MemoryRouter`) or a
  reservations copy; stub `fetch` with `vi.stubGlobal`, answering the token URL
  and API paths (see `schedule-page.test.tsx`). Keep fixtures next to utils.
- Route tests are colocated as `*-routes.test.ts`. The guard sweep
  `apps/app/app/utils/reservations/reservations-guards.test.ts` is modeled on
  `staffing-guards.test.ts`.
- Playwright: `apps/app/tests/playwright-utils.ts` (`login`, `insertNewUser`,
  `navigate`; the page fixture aborts the SSE).
- Flags are inserted with `db.insert(ConfigFlag)` and removed in cleanup
  (`enableScheduling`/`dropFlags` in
  `apps/app/tests/e2e/staff-schedule.test.ts`).
- tenant-api is not running in E2E: stub `**/operator/reservations/**` with
  `page.route`, CORS headers and Zod-valid shapes. App routes (flags, token
  mint, loaders) stay real. Region guard example:
  `apps/app/tests/e2e/staff-region-guard.test.ts`.

## Admin (platform fee only)

- The Admin feature flags page `apps/admin/app/routes/_admin+/feature-flags.tsx`
  lists org overrides only for keys that already exist as system flags
  (migration `0025` seeds system `false` rows for that reason).
- The platform fee control (`reservations.platform_fee_bp`) is a validated Admin
  control, not a raw flag edit.
- Admin writes `packages/database/db/data.db` while App dev reads local D1;
  validators copy the value into D1 before checking amounts.

## Superseded research

- `app-ui-frontend.md` says `@repo/ui` is Base UI "despite AGENTS.md" saying
  Radix. Current AGENTS.md files already say Base UI; there is no conflict.
- The research's suggested route names (`settings.shifts.tsx`, a top-level
  `floor-plan.tsx`, `_index.tsx` as the book) are superseded by the architecture
  route map: services, not shifts; `settings.floor-plan.tsx`; `_index.tsx`
  redirects to the first allowed section.
- Research polling advice (5-15 s, timers every 10-30 s) is superseded by the
  mission intervals above.

## Scrutiny findings — foh-core (round 1 at 403e6c0c; re-verified in round 2 at 275d4b30)

Round 2 confirmed every round-1 finding below is resolved. The facts that are
still true, plus new round-2 facts:

- `node scripts/check-lingui.mjs` only validates strings that are Lingui
  messages. Hardcoded English literals (label/option tables, `{enum}` renders,
  status badges, template-string aria-labels and live-region announcements) pass
  it while still rendering English under `?lng=ar`. Grep the touched routes for
  them before declaring Arabic complete. Round-2 residuals:
  `settings.services.tsx:1239` (channel), `settings._index.tsx`
  (issue.code/conflict.reason), `detail-sheet.tsx:403` and `today.tsx:376`
  (status), `timeline.tsx:1101` (bar aria-label), English default section names
  (`settings.sections.tsx:78-80`).
- Polling cadences now match the table above: today 5 s, timeline/book 10 s,
  calendar/overview 60 s, floor 5 s, host-stand timers 15 s (`useLiveNow`).
  Stale "30 s" comments remain in `floor.tsx:146` and
  `hooks/use-live-now.ts:31-38`.
- The detail sheet pauses the day-feed poll while `?r=<id>` is open
  (`useHostStand` passes `detailReservationId`; `useReservationsPoll` clears its
  interval), and `detail-sheet.tsx` skips dirty fields when a new reservation
  arrives, so unsaved notes/party size/time/duration survive a poll.
- The floor-plan canvas clears `dirty` only when `onSave` resolves `true`
  (write + refetch both succeeded). Residual: if the PUT succeeds but the
  follow-up `fetchFloorPlan` throws, the handler returns false, the route keeps
  the consumed `floorPlanVersion`, and the next Save 409s until "Reload latest
  floor plan" or a reload. Prefer deriving the saved version from the PUT
  response instead of the refetch.
- UI option lists must match the API enum: the pacing channel select offers
  `phone`/`walk_in` while the API schema allows only `all|online`
  (`packages/reservations/src/schemas/setup.ts:266`).

## Scrutiny findings — guest-channels-and-crm (round 1)

- **One location-settings version is shared by three settings surfaces.**
  General settings, waitlist settings and message settings all read and write
  the same `rsv_location_settings.version` row
  (`apps/tenant-api/src/services/rsv-waitlist-settings.ts:47-60` delegates to
  `updateLocationSettings`;
  `apps/tenant-api/src/services/rsv-message-settings-service.ts:96,154-165`). A
  save on one surface makes the other two stale, so every settings screen must
  send the version from the same location-settings payload and recover from
  `409 stale_version` (the waitlist and message screens rebase or show a
  conflict banner). Do not cache the version per screen.
- **The module header's Date and Service controls render on every section.**
  `reservations+/_layout.tsx:305-344` shows them on Guests and Reports too,
  where they filter nothing (only Location applies there). Harmless but
  confusing; hide them per-section if you touch that layout.
