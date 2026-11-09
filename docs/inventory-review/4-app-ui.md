# Review 4: Inventory App UI (branch pr/inventory, HEAD 12b1ce67d)

Reviewer: adversarial, read-only. Method: read code paths, grep sweeps, targeted
tests. No browser. Paths below are relative to `/Users/zama/menuza/apps/app/app`
unless they start with `packages/` or `apps/`. `R:` =
`routes/_app+/$orgSlug_+/inventory+`, `C:` = `components/inventory`, `U:` =
`utils/inventory`.

## 0. Tool results

| Check                                                             | Result                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx vitest run app/utils/inventory app/components/inventory`     | 48 files, 542 tests passed. 0 "not wrapped in act" warnings.                                                                                                                                                 |
| `npx vitest run 'app/routes/_app+/$orgSlug_+/inventory+'` (extra) | 12 files, 149 tests passed.                                                                                                                                                                                  |
| `npm run typecheck -w app`                                        | Clean (react-router typegen + tsc, no errors).                                                                                                                                                               |
| ESLint on inventory paths (+ both count hooks)                    | 0 errors, 4 warnings (see L-9).                                                                                                                                                                              |
| Side effect of my test run                                        | `packages/database/src/env.ts` is now modified (Varlock regenerated it; it was not in the initial git status). I did NOT revert it (rules). Caller: `git checkout packages/database/src/env.ts` if unwanted. |

## 1. What is good (verified)

- No `asChild`, no raw palette colours, no arbitrary values, no inline styles,
  no physical `ml-/pl-/left-/right-/text-left` classes anywhere in the inventory
  UI (rg over components/routes/stepper). Back/forward arrows carry
  `rtl:rotate-180`. Numbers sit in `<bdi dir="ltr">`. The stepper forces
  `dir="ltr"` so minus stays left.
- Lingui coverage is complete: no hard-coded JSX text, `aria-label` or
  `placeholder` found. 1081 inventory msgids; `ar.po` has 0 empty, 0 fuzzy, 0
  placeholder mismatches, full CLDR plural forms (zero/one/two/few/many/other)
  on plurals. Sampled 40 Arabic strings plus all terminology-bearing ones:
  natural, owner-friendly, not machine-looking (exceptions in M-9).
- Owner glossary: grep of UI strings finds none of par, AvT, COGS, 86, SKU, UoM,
  ledger, reconcile, variance, depletion, shrinkage, PO. "Batch" is used (plain
  English). Movement kinds are shown as "Delivered / Used by sales / Wasted /
  Counted / Adjusted / Moved in..." (`U:labels.ts`).
- Raw region error codes and messages never reach the user for mapped paths;
  `inventoryErrorMessage`/`inventorySaveErrorMessage` hide the English region
  message (gaps in M-1).
- Money gating is systematic (`canSeeCost` in 26 files): Today, Stock value
  column, Counts difference, waste chart (falls back to counts), delivery
  totals, order totals, price alerts panel not mounted without cost, price-rise
  alert gated server-side in `U:manager-alerts.ts`. Purchasing shows an explicit
  note to cost-less recorders. No money found in URL params.
- Idempotency: every create form keeps one `clientId` per attempt in a `useRef`
  and rotates it only after success (item, supplier, delivery, waste, batch,
  adjust, transfer, start count, add-many, order panels). Dialog forms unmount
  on close, so a reopened dialog starts with a fresh id.
- Child sheet routes (`stock.new`, `areas`, `lists`, `add-many`, `levels`) gate
  in the loader with `anyOf: [UPDATE_INVENTORY]` (not only by hiding buttons).
- Item edit does PATCH then PUT with an `itemSavedRef` so a retry after a
  half-failed save does not resend the first call. Thoughtful.
- Skeleton + `role="status"` + `sr-only` text, destructive Alert + "Try again",
  and `aria-busy` while refreshing are present on nearly every list screen.
- 5 tabs maximum (Waste leaves the bar when Prep is on, sidebar filtered the
  same way, `app-sidebar.tsx:895-902`).

## 2. Findings

### HIGH

**H-1 (high, confidence high). No Inventory Settings UI at all; four region
settings can never be changed.**

- Plan (`docs/inventory-plan.md:180`, 324, 559, 773, 900) promises "Settings
  (storage areas, count lists, units, target food cost) at
  `inventory/settings`". The region has `PUT /operator/inventory/settings`
  (`apps/tenant-api/src/routes/operator-inventory.ts:86`) with
  `targetFoodCostBp`, `unitSystem`, `countDayOfWeek`, `anyStaffCanReceive`
  (`packages/inventory/src/schemas.ts:12-37`). The App only ever GETs it
  (`C:inventory-prefs.tsx:42`); `rg` finds no writer, no route, no menu entry.
- Hurts: (a) "A count is due today" on Today can never fire because nobody can
  set the weekly count day; (b) food cost target is fixed at 30% ("Target 30%"
  on Today, the red/amber dots in the menu list); (c) a KSA org that wants US
  units (or the reverse) is stuck with the region default; (d) Station "any
  staff can receive deliveries" cannot be turned on from the App, so only till
  managers receive.
- Fix: add `inventory/settings` (WorkspaceSurface + SaveBar, `expectedVersion`)
  reached from the header ellipsis, as the plan says. Four fields, no more.

**H-2 (high, confidence high). Counting: a row can show a green "Saved" for an
entry the region REFUSED, and "enter it again" cannot work.**

- `U:count-sheet.ts:203-223` `rowSaveState` looks only at
  `snapshot.pending/sending/failed`. A refused entry is removed from the queue
  (`U:count-queue.ts` settle: `gone` includes refused) and `rowSaveState` then
  returns `'saved'` because `isRowCounted(row, amounts)` is true from the
  locally typed value. `snapshot.refused` is used only by the top banner
  (`C:counting-screen.tsx:444-453`), which says "N entries could not be saved...
  Check those items" without naming which items. Progress "32 of 48" also counts
  the refused row (`countProgress` reads local `amounts`).
- Re-entering the same value is a no-op: `commit()` returns early when
  `committedRef` already equals the value (`C:counting-screen.tsx:175-180`), and
  `committedRef` is not reset on refusal. So "enter it again" only works if the
  person changes the number.
- Hurts: a person finishing a stock count believes every row is saved; the
  missing item then shows as "not counted" in review (or is silently left out if
  they confirm).
- Fix: put refused `(itemId, areaId, unit)` slots into the snapshot and make
  `rowSaveState` return `'refused'` ("Could not save", with the plain reason);
  clear `committedRef` for that slot; name the items in the banner.

### MEDIUM

**M-1 (medium, confidence high). Region error codes without a plain-words
mapping; several fall into the wrong sentence.** Codes in
`packages/inventory/src/errors.ts` and what the user sees today
(`U:inventory-errors.ts`):

| Code (status)                                                                         | Emitted by region                                                   | User sees                                                                                                            | Problem                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit_reached` (409) x9 (items 5000, orders 200 lines, 100 open orders, 40 areas...) | yes                                                                 | "Someone else changed this first. Close it, open it again and retry." (generic 409 branch, `inventory-errors.ts:61`) | Wrong; retry loops forever. Needs "You have reached the limit for ..."                                                                                                                                                                                                                  |
| `idempotency_conflict` (409) x5                                                       | yes                                                                 | same "Someone else changed this first"                                                                               | After an ambiguous failure the person edits the form and resubmits with the SAME `clientId` (refs rotate only on success); every retry then fails with this message until the dialog is closed. Reset the id when the payload changes, or map the code to "Close this and start again". |
| `already_undone` / `undo_expired` (409)                                               | yes (24 h window)                                                   | "Someone else changed this first..." (Waste log undo `R:waste.tsx:388-391`)                                          | Should say "Already undone" / "Too late to undo".                                                                                                                                                                                                                                       |
| `not_found` (404) x4                                                                  | yes                                                                 | "We could not save this. Check your connection..."                                                                   | Misleading (item archived, order deleted).                                                                                                                                                                                                                                              |
| `count_closed` (409, send/approve/reopen)                                             | yes                                                                 | "Someone else changed this first"                                                                                    | Acceptable but not specific; review screen special-cases only the GET.                                                                                                                                                                                                                  |
| `task_closed` (409, prep)                                                             | yes                                                                 | same generic 409                                                                                                     | Acceptable ("done by someone else") but not stated.                                                                                                                                                                                                                                     |
| `reason_not_allowed` (400), `invalid_request` (400/409), `inventory_disabled`         | yes/no                                                              | "Something in this form was not accepted" / generic                                                                  | OK but vague.                                                                                                                                                                                                                                                                           |
| `name_taken`, `reader_*`, `transfer_*`, `count_in_progress`                           | listed in errors.ts; `name_taken` not emitted by inventory services | `transfer_*` and `count_in_progress` are handled in their own forms; `reader_*` handled                              | fine                                                                                                                                                                                                                                                                                    |

**M-2 (medium, confidence high). Counting offline queue is only flushed by the
counting screen of that same count; entries can be orphaned or misattributed.**

- `hooks/use-count-entry-sync.ts` is the only consumer of the queue (`rg`
  confirms). Closing the tab while offline leaves entries in `localStorage`
  (`inventory-count-queue:<org>:<count>`) with no indicator on Counts/Today, so
  a person who counted in the walk-in and walked away believes it was sent. If
  the count is approved/cancelled meanwhile, the screen opens as "no longer
  takes entries" and never says "N entries on this device were not used".
- Key has no user id: on a shared tablet, user B opening that count flushes user
  A's entries under B's token, so the region records B as the counter.
- Two tabs on the same count: each tab keeps its own in-memory queue and
  overwrites the whole key (`writeQueue`), with no `storage` listener. Last
  writer wins; an offline tab can lose entries typed in the other.
- A write blocked by quota is swallowed (`writeQueue` catch) with no warning
  that a reload would lose the entries.
- Reload while offline is impossible (the sheet fetch fails, whole screen shows
  "We could not load your inventory"); there is no cached sheet. Station is the
  offline app, so this may be acceptable, but say so in the offline banner.
- Fix: show "N entries waiting on this device" on Counts (read the keys), add
  user id to the key, listen to `storage`, warn on quota failure.

**M-3 (medium, confidence high). Typing an unusable number silently CLEARS an
already-saved count.**

- `packages/ui/components/ui/quantity-stepper.tsx` `onChange`: text that does
  not parse ("1,5", "5,5", letters, above 1,000,000,000) calls
  `onValueChange(null)`. In the counting screen that is
  `change(row, unit, null)`, which commits a "clear this counter's entry"
  (`amount: null`) after 700 ms (`C:counting-screen.tsx:222-229`,
  `U:count-queue.ts` null = clear) and blur then blanks the field. A person
  correcting 5 to "5,5" (comma decimal is refused by design) deletes their saved
  count. Only a red border (`aria-invalid`) hints at it. Same stepper in waste,
  batch, transfers, delivery.
- Fix: keep the previous value (do not emit `null`) while the text is invalid,
  and show a one-line hint ("Use a dot: 5.5"); only emit null when the field is
  truly empty.

**M-4 (medium, confidence high). Plan items not built (Screens section).** Not
built and NOT in the acknowledged list (Station transfers screen, edit planned
transfer, reservations nudge, `inventory_sold_out` kind):

1. Settings page (H-1).
2. Log waste dialog is items only (`C:item-picker.tsx:25` "dishes come with
   recipes"; recipes shipped in phase 3). Plan Waste section: picker over items
   AND dishes, a wasted dish recorded as its ingredients. Today a
   cancelled-after-cooking dish can only be logged from Station Kitchen.
3. Item sheet "Used in: dishes and options that use it" (plan Stock section):
   absent (`R:stock.$itemId.tsx`).
4. Menu items list "sort by Food cost" (plan Dish costs): only the column
   exists.
5. Today header says "What needs you today." without the location name; plan
   says "...at Olaya branch" (cosmetic).
6. "Last count shown faintly after a value is entered" (plan Counts): not
   implemented. Built beyond/against the plan: none found that the plan said to
   leave out. Today shows up to 12 attention kinds (the region caps at 5,
   `todaySchema` `.max(5)`), within plan.

**M-5 (medium, confidence medium). Refresh failures are silent; stale data stays
on screen.** `hooks/use-inventory-client.ts` keeps the previous `data` and sets
`error` when a reload fails, but Stock (`R:stock.tsx:~257`), Today, Counts,
Purchasing and Waste render the error Alert only when `error && !data`. After
"Log waste" or an item save triggers a refetch that fails, numbers stay old with
no notice and no `aria-busy`. Violates principle 8 "nothing silently fails".
Fix: a small "Could not refresh. Try again" line when `error && data`.

**M-6 (medium, confidence medium). Switching location shows the previous
location's numbers.** `useInventoryQuery` keeps `data` when `path` changes
(`loading: current.data === null`), so on a location switch Stock/Today/Counts
keep the old location's rows (dimmed with opacity 70) until the response lands,
and the user can open an item from the wrong location. Fix: drop data when the
path's `locationId` changes (key the hook on path).

**M-7 (medium, confidence medium). Non-pluralised sentences (Arabic needs six
forms).**

- `C:send-order-dialog.tsx:115` "will get {itemCount} items" (reads "1 items").
- `R:stock.add-many.tsx:109` `added === 1 ? t\`1 item added.\` : t\`${added}
  items added.\``.
- `R:waste.tsx` "Showing {shown} entries".
- `R:today.tsx:675` "{counted} of {total} items counted" (acceptable in English,
  wrong agreement in Arabic).
- `U:manager-alerts.ts:119-176` email copy hard-coded English with ad-hoc
  `count === 1` (same pattern as staffing; the in-app bell copy in
  `U:alert-copy.ts` IS translated). Fix: use `Plural`.

**M-8 (medium, confidence high). Arabic translation defects.**

- `msgid "Short"` => `قصير` (means short in length). It is a shared msgid with
  `website+/pages.$pageId.tsx:5075`, and the delivery screen
  (`C:record-delivery-screen.tsx:951`) uses it for "delivered short" next to
  "Missing". Should be `ناقص`. Fix with a context
  (`msg({ message: 'Short', context: 'delivery line' })`).
- Terminology drift for the same concept: item = عنصر (65) / صنف (8-10 incl.
  "Add your items" => "أضف أصنافك", "Item {position}" => "الصنف"); delivery =
  شحنة (32) / تسليم (7) / توصيلة (2, colloquial, "Add a delivery to see..." and
  "Add a delivery to price it"); supplier = مورّد (31) / مورد (5). Pick one
  each.
- `Someone else also counted {X} here.` => "جرد شخص آخر أيضًا ... هنا" reads
  like "another person's count also ..."; prefer "عدّ شخص آخر أيضًا".

### LOW

**L-1 (low, high). Tab links carry the whole query string.**
`C:inventory-chrome.tsx:131`
`search = locations.length > 1 ? location.search : ''`: with several locations
every tab link inherits Stock filters (`q`, `category`, `area`, `low`, `limit`),
`unpaid=1`, waste `from/to`, so they reappear later (and the URL is noisy).
Carry only `locationId`.

**L-2 (low, high). Accessible names of steppers.** In every row the buttons are
just "Less" / "More" (`C:counting-screen.tsx`, log-waste, etc.); with 100 rows a
screen-reader user hears "Less, button" with no item name. Give the stepper
wrapper `role="group"` + `aria-label` (item name), or include the name in the
button labels.

**L-3 (low, medium). Counting screen performance with big sheets.** No
virtualization or memoization: every keystroke `setAmounts` re-renders every
`CountRowView` of the active area; `rowSaveState` runs `pending.filter` and
`[...dirtyRef].some` per row, so O(rows x pending) (offline = pending grows to
all rows). Items cap is 5000 and "Not in an area" can be one huge tab. Fine up
to a few hundred rows; `memo` the row and pass `rowSaveState` precomputed by
slot map.

**L-4 (low, high). Breadcrumb has no `prep` label.**
`components/workspace-breadcrumb.tsx` SEGMENT_LABELS lacks `prep`, so the crumb
falls back to the raw English "Prep" in Arabic. Add `prep: <Trans>Prep</Trans>`.

**L-5 (low, high). Forms are not Conform+Zod except item and supplier.** Plan
"Forms" says Conform + Zod 4. Delivery, waste, batch, adjust, transfers, levels,
recipe and order panels use hand-rolled `*Problems()` validators in `U:*.ts`
(tested, consistent among themselves, but not the app-wide pattern, and no
field-level `aria-describedby` wiring from Conform).

**L-6 (low, medium). Counting and Review reimplement the sticky header**
(`C:counting-screen.tsx:344`, `C:count-review-screen.tsx:255`: identical class
strings) while Record delivery and Review order use `MenuFormHeader`. Plan said
full editors use `MenuFormHeader`. Two copies to drift.

**L-7 (low, high). Lingui lint warnings.** `C:prep-levels-panel.tsx:78`
(`set.length`) and `C:prep-screen.tsx:403` (`Math.abs(percent)`) put expressions
in `Trans`, so the msgid has an anonymous `{0}` placeholder (worse for
translators; ESLint warns). `today.tsx:159` `menuDishes` should be memoised
(exhaustive-deps warning); `sold-out-panel.test.tsx:7` import order.

**L-8 (low, medium). SSR/hydration date.** `C:record-delivery-screen.tsx:103`
`today()` runs in the `useState` initialiser, so server (UTC) and browser local
date can differ in the evening (KSA +3), a hydration mismatch. Today uses the
correct `useEffect(() => setNow(new Date()))` pattern; `prep-screen.tsx:53` also
uses `new Date()` in render.

**L-9 (low, medium). Skeletons without `role="status"`**:
`C:prep-screen.tsx:~158` (`<Skeleton className="h-64 ...">`), item history in
`R:stock.$itemId.tsx:~562`, Today waste summary. Convention elsewhere is
`role="status"` + sr-only text.

**L-10 (low, medium). No unsaved-changes guard** on Record delivery / Review
order / Recipe sections (`useBlocker`/`beforeunload` absent). Not used elsewhere
in the App either (only `labor-policy-editor`), so consistent, but these are the
longest forms; a refresh loses 30 lines.

**L-11 (low, medium). Waste "by reason" chart shows values only in the hover
tooltip** (`C:waste-bars.tsx`); no data labels, so on touch devices the numbers
are invisible. Add visible values (LabelList) or a text list. Y-axis labels are
cut at width 110 for long Arabic reasons.

**L-12 (low, high). Count review shows the raw ISO date**
(`C:count-review-screen.tsx:~282` `<bdi>{count.businessDate}</bdi>`), whereas
Counts formats it with `Intl`.

**L-13 (low, medium). Version-skew brittleness.** Strict enums/discriminated
unions (`attentionItemSchema` in `packages/inventory/src/contract/today.ts:31`)
make `useInventoryQuery` fail the whole screen when a newer region emits a new
kind to an older open tab; the user sees "Check your connection"
(`malformed_response` maps to the generic load error). Consider `.catch` on
array items or a version hint.

**L-14 (low, low). Settings query failure is silent** (`C:inventory-prefs.tsx`):
the unit system flips to the region default and back (flicker on first paint for
orgs that chose the other system), no error.

**L-15 (low, medium). Prep tab auto-writes on view** (`C:prep-screen.tsx:~130`):
the first time an editor opens an unplanned day, a `POST /prep/generate` fires
from an effect (a GET-with-side-effect for a person who only looked). Also a
single `busy` state is shared by generate and every task, so a second tap on
another task re-enables the first one's buttons.

**L-16 (low, medium). Stock list renders both the desktop table and the mobile
list** (`C:stock-list.tsx`, `hidden md:flex` / `md:hidden`), doubling DOM and
duplicate test ids for up to 200 rows.

**L-17 (info). Plan wording**: plan says sheets open "from the start side", code
(like staff/hiring/notes) opens from the end side and flips in RTL
(`R:stock.tsx:432`, `R:purchasing.tsx:706`). Code matches siblings; plan text is
wrong.

**L-18 (info). Recharts** is imported statically by Today (`waste-bars`) and the
item sheet (price line); no lazy loading. Recharts is already in the app for
dashboards, so marginal.

## 3. Check-by-check coverage (1 to 10)

1. Glossary/density: clean (section 1). Today = metrics + at most 5 attention
   sentences + week + waste bars; Stock row = name + on hand (bar) + status;
   Purchasing is the densest tab (suggested orders, open orders, price alerts,
   moving stock, owed bar, deliveries, suppliers on one page) but each is a
   titled panel. Record delivery (1540 lines) is the densest screen; fine for an
   invoice. Setup path (items -> areas -> first count -> delivery) is the 4-step
   checklist (`U:setup-progress.ts`), but the "areas" step links to Stock and
   areas are only reachable from the Stock ellipsis menu.
2. Consistency: same chrome (`PageHeader`, `WorkspaceTabBar`, `WorkspacePanel`),
   `FilterSelect`, `EmptyState` (separate "none yet" / "no matches"), `Sheet` +
   `SheetPanel`, `Badge` variants. One-offs: sticky headers (L-6), `ItemPicker`
   is a popover+Command (same pattern as loyalty catalog picker, acceptable).
3. Forms: see M-1, M-3, L-5. 409 stale: generic message tells the user to close
   and reopen; only recipe sections refetch (`isStaleVersion`). Undo toast: 60 s
   on the toast, region window 24 h (waste page offers it later), good.
   Optimistic UI: none (writes are confirmed), so no rollbacks needed.
4. Permissions: flags off -> 404 (loader) and nav hidden; read-only
   (impersonation or no update) hides primary buttons and sheets 403 in loaders;
   counting shows "You can look at this count but not change it". Cost-less
   members: no money anywhere found. Location picker hidden for one location;
   multi-location uses `locationIds` from the token. Gap: none blocking; "Record
   delivery" needs `update:inventory` even for a purchasing-only member (they
   get "You can look at deliveries but not record them",
   `C:record-delivery-screen.tsx:~420`), arguably intended.
5. Offline: M-2, H-2. Retry storm: 15 s timer only while entries wait, bounded;
   a 403/location_forbidden keeps retrying forever (any non-400 error rejects),
   so a revoked member's tab retries every 15 s indefinitely (low).
6. i18n/RTL: M-7, M-8, L-4, L-7; digits in placeholder `"0"` are Latin
   (trivial). Currency/number/date go through `Intl` with `i18n.locale`;
   currency is the region's (USD/SAR) via `formatMoney` with correct exponent
   (waste-bars `/100` then `*100` round-trips, checked, not a bug).
7. Accessibility: L-2, L-9, L-11. Positives: `aria-live="polite"` per-row save
   state with icon+text (not colour only), `FoodCostDot` has `role="img"` +
   label, status badges are text, `aria-pressed` on toggles, focus handled by
   Base UI Dialog/Sheet, the `Button` has a 44 px touch hit area via `after:` on
   touch.
8. Performance: L-3, L-16, L-18. Pickers do server search (limit 20, 200 ms
   debounce); Stock paginates by URL `limit` (50 to 200) but cannot show beyond
   200 without searching ("Search or filter to narrow the list" is shown; items
   cap is 5000).
9. Plan vs built: M-4.
10. Tests: all passing, no act warnings, no fake-timer reliance. Untested UI
    flows: `InventoryChrome` and the location picker (no test),
    `InventoryClientProvider`/token cache and 401 retry, `AdjustStockDialog`
    (moves stock; only touched via `stock.$itemId.test`), `ConfirmPricesDialog`
    (via purchasing tests only), `CreditMessageDialog`, `SendOrderDialog` (only
    via review-order test), `SetupChecklist` (inventory copy; only the
    reservations one is tested), `ItemPicker` error/loading states,
    `stock.areas`/`stock.lists` reorder, any Arabic/RTL render of a screen (only
    the stepper has an RTL test), multi-tab and quota paths of the count queue,
    a refused entry on the counting screen (would have caught H-2).

## 4. Suggested order of fixes

1. H-2 (data trust in counting), M-3 (stepper clearing counts), H-1 (settings
   page).
2. M-1 error mapping (one function, ten lines) and M-2 (count queue visibility,
   user-scoped key).
3. M-5/M-6 (stale data) and the Arabic fixes (M-8), then the
   plural/breadcrumb/lint items.
