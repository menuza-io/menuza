# Inventory: plan

Status: phase 0 built on `pr/inventory` (domain package, flags and permissions,
regional schema `0033_inventory`, tenant-api auth and the first operator routes,
the items-sold reader, the App shell with empty tabs behind
`inventory.enabled`); phase 1 built behind the same flag (Stock, Counts,
Purchasing deliveries and suppliers, Waste, Today). The **phase 2 wire contract
is written** in `@repo/inventory`
(`contract/{levels,orders,orders-rules,receiving, notify,station}.ts`, see
[Phase 2 wire contract](#phase-2-wire-contract)); the region, Station and App
implement against it. Nothing is user-visible until the flag is on. Placement is
recorded in [ADR 049](./decisions/049-inventory-data-residency.md). Research
current as of 8 November 2026. An earlier uncommitted attempt was rejected and
is parked on the local branch `wip/inventory-v1` for reference only.

Inspiration: the Mise prep and waste product (shared as screen recordings) for
its calm "Today" page, one-sentence insight cards, the waste dialog and the prep
board; the earlier `menuza-inventory-v2` prototype for its domain coverage, and
as the example of what to avoid (17 sub-pages, jargon, dense number rows, every
field entered twice in two languages).

## Goal

Give a restaurant owner or chef straight answers to five questions, in their own
words, with as little typing as possible:

1. **What do I have?** Stock on hand per location, what is running low, what it
   is worth.
2. **What should I order?** A suggested order per supplier, sent from Menuza,
   checked off when the delivery arrives.
3. **What is my food costing me?** Food cost % for the week, what each dish
   costs to make, and when a supplier price moves it.
4. **What am I throwing away?** Waste logged in seconds, totalled by reason and
   cost.
5. **What do we prep today?** (later) A prep list from what is on hand and what
   we expect to sell.

Every answer must be useful **before** the owner has typed a single recipe:
items, a count and deliveries already give stock value, usage and food cost %.
Recipes add plate cost, automatic stock deduction from sales and "expected vs
counted", for owners who want them.

Not in this plan: accounting sync (QuickBooks, Xero, Qoyod), paying suppliers,
supplier portals or EDI, barcode and Bluetooth scale counting, lot and expiry
tracking, FIFO valuation, ordering without a person reviewing it, AI demand
forecasting beyond simple history rules, bar bottle-weight counting.

## What owners told the research

Full sources are at the end. The findings that shape this plan:

- **People adopt the features that remove typing**, and abandon tools over three
  things: the recipe-entry wall (a half-entered recipe book shows a confident
  wrong number), invoice scanning that misreads lines, and item/vendor mapping
  chores. ERPs (Restaurant365, Apicbase: "2 months to implement, 20 to ROI") are
  called "too much" by small shops. Foodics, the KSA leader, gets its weakest
  reviews for the inventory module.
- **Food cost % needs no recipes.** Opening stock + purchases − closing stock,
  divided by sales. MarginEdge built a business on invoices + counts + POS
  sales. Recipes add the "expected" side.
- **Counting habits:** about half of operators count weekly, a quarter monthly;
  proteins are often counted daily. Counts follow the walk (walk-in, freezer,
  dry store), start blank (pre-filled numbers invite rubber-stamping; Foodics
  switched to blank), several people count at once, and a manager approves.
  Walk-ins have no signal: a count must never look saved when it is not.
- **Modifiers need recipes from day one.** Square cannot cost "oat milk" or
  "extra cheese", which breaks cafes and pizzerias. Toppings, sizes and shawarma
  extras are where the money goes.
- **Plate cost at the latest price, stock value at a weighted average,** chosen
  for the owner, never asked.
- **KSA:** meat and produce by the kg with the real weight on the invoice (catch
  weight), 15% VAT kept apart from the price, the supplier's ZATCA invoice
  number kept, supplier credit is normal ("what do I owe"), Ramadan moves demand
  to iftar and suhoor, kitchen teams are multilingual (icons and numbers carry
  more than words), alcohol does not exist.
- **Benchmarks** for targets and hints: food cost quick service 25–30%, casual
  28–32%, fine dining 32–40%, pizza 20–35%, cafe 25–35%. Expected vs counted gap
  under 2 points is good, over 3–5 needs a look. Pre-consumer waste 4–10% of
  purchases. (Mostly vendor sources; used as ranges only.)

## Personas

We read every screen as these owners. "Uses" is what they would open weekly;
"ignores" is what must stay out of their way.

| Owner                                | Top jobs                                                                        | Uses                                                 | Ignores                         |
| ------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------- |
| Shawarma / burger shop, one location | Meat, bread and oil spend; reorder 15–30 items; sold out when the cone runs out | Today, quick count, deliveries, waste, auto sold out | Recipes beyond top 5, transfers |
| Pizzeria                             | Cheese portioning, dough batches, boxes                                         | Topping recipes (halves), batch dough, waste         | Orders by approval              |
| Cafe + bakery                        | Milk, coffee, cups; milk options; day-old pastry waste                          | Option recipes, daily waste, quick count             | Purchase orders, transfers      |
| Casual dining                        | Weekly full count, price rises, 3–6 suppliers' usual orders, dish margins       | Everything in phases 1–3                             | Prep forecast until trusted     |
| Fine-dining chef-owner               | Exact dish cost with usable %, changing specials, protein swings                | Recipes, price alerts, prep list                     | Fill-up-to ordering             |
| Chain with a central kitchen (KSA)   | Branch requests, production, transfers, branch comparison                       | Phase 5, per-location views                          | —                               |
| Cloud kitchen, several brands        | One stock pool for several menus; one ingredient out shuts many brands          | Shared items across menus, auto sold out             | Front-of-house                  |
| Food truck                           | Load list for the day, end-of-day count, offline                                | Station count app, quick count                       | Almost everything else          |
| Bar-heavy (US only)                  | Bottle counts in tenths, pour cost                                              | Counts with fractions, drinks category               | Hidden for KSA organizations    |

## Product principles

These are the rules the rejected prototype broke. Each screen in review is
checked against them.

1. **Five tabs, not seventeen.** The module has at most five tabs at any phase
   (when Prep arrives, Waste moves into Today; see [Navigation](#navigation)).
   Anything else is a section, a sheet, or a link.
2. **One name per thing.** Item, supplier, storage area, unit and note fields
   are one plain text field each, stored as typed. No per-locale maps, no second
   Arabic name. Inventory is back office; only fields shown on Sites or in the
   customer app are translated, and inventory has none. Dish names come from the
   menu and are shown with the existing menu name helper.
3. **App strings are Lingui.** Every label, button, reason, unit name, built-in
   category and message goes through Lingui macros and is translated in `ar.po`.
   Unit names use `Intl.NumberFormat` unit formatting where the unit is standard
   (kilogram, gram, liter, milliliter, pound, ounce, gallon, fluid-ounce), so
   Arabic and RTL come for free.
4. **Owner words, not stock-control words.** See the glossary below. No
   abbreviation is ever shown (no AvT, COGS, PO, UoM, 86).
5. **A row shows a name, one number and one status.** Details open in a sheet.
   Money columns only show to people allowed to see cost.
6. **Every insight is one sentence and one action.** "Chicken is running low.
   Order from Al Watania ›". No insight without a next step.
7. **Works with zero setup beyond items.** Recipes, levels and suppliers are
   each optional and each adds one more answer.
8. **Nothing silently fails.** Counts and waste save per line with visible
   state; a failed save stays on screen with retry.
9. **Reuse before building.** Every screen is assembled from `@repo/ui` and the
   module patterns below. New shared pieces (a quantity stepper, an undo toast)
   are added once, in `@repo/ui` or the App components, and reused.

### Glossary (what the UI says)

| Industry term             | Menuza says                                     |
| ------------------------- | ----------------------------------------------- |
| Par level                 | **Fill up to**                                  |
| Reorder point             | **Order more when below**                       |
| Purchase order (PO)       | **Order**                                       |
| Receiving                 | **Delivery** / **Receive delivery**             |
| COGS / actual food cost   | **Food cost**                                   |
| Theoretical usage         | **Expected use**                                |
| AvT / variance            | **Expected vs counted** / **Missing**           |
| Depletion                 | **Used by sales**                               |
| 86                        | **Sold out**                                    |
| Yield / trim loss         | **Usable %**                                    |
| Unit of measure           | **Unit**                                        |
| Catch weight              | **Priced by weight**                            |
| Sub-recipe / batch recipe | **Made in house** (an item with its own recipe) |
| Commissary                | **Central kitchen**                             |
| Shrinkage                 | **Missing**                                     |

## Navigation

A sidebar item **Inventory** with an animated icon, gated by the
`inventory.enabled` flag and `read:inventory:any`, following the loyalty pattern
(`computeInventoryNavAccess` in `root.tsx`, sub-items filtered by URL, parent
points at the first visible child). Menu stays where it is; recipes live on menu
items (see [Dish costs](#dish-costs-in-the-menu)).

| Tab            | Route                  | Phase | One-line purpose                              |
| -------------- | ---------------------- | ----- | --------------------------------------------- |
| **Today**      | `inventory/today`      | 1     | What needs you now, this week's numbers       |
| **Stock**      | `inventory/stock`      | 1     | Every item, how much, where, what it is worth |
| **Counts**     | `inventory/counts`     | 1     | Start, continue and review counts             |
| **Purchasing** | `inventory/purchasing` | 1–2   | Deliveries, suggested orders, suppliers       |
| **Waste**      | `inventory/waste`      | 1     | Log and see waste by reason and cost          |
| **Prep**       | `inventory/prep`       | 4     | Today's prep list and board                   |

At phase 4 there are six tabs; Waste then folds into Today as a panel with its
"See all" page kept at `inventory/waste` but out of the tab bar, so the bar
stays at five. Settings (storage areas, count lists, units, target food cost)
open from the header's ellipsis menu at `inventory/settings`, like the Team
page's actions menu, not as a tab.

"Purchasing" rather than "Orders": the sidebar already has customer **Orders**,
and "Ordering" reads as online ordering. In the page the words are "order" and
"delivery".

## Screens

All screens use the same chrome, copied from loyalty: `inventory+/_layout.tsx`
wraps `InventoryClientProvider` and `InventoryChrome`
(`components/inventory/inventory-chrome.tsx`, modelled on
`components/loyalty/loyalty-chrome.tsx`): one `PageHeader` with a per-tab title
and description, header actions, and a `WorkspaceTabBar` filtered by `nav`
access. The location picker sits in the header controls exactly like
`ReservationsHeaderControls` and is hidden when the organization has one
location. Every screen fetches browser-direct from tenant-api through
`useOperatorClient` with an inventory token, and uses the loading, error and
refresh conventions of `useStaffQuery` (skeleton rows in `role="status"`,
destructive `Alert` with Try again, `aria-busy` while refreshing).

**Header actions on every tab:** `Log waste` (secondary) and the tab's primary
action. Log waste is everywhere because waste happens everywhere.

### Today

The Mise "Today" page, without the AI theatre. Rule-based, explainable.

```
Inventory                                      [Log waste] [Start count]  ⋯
What needs you today at Olaya branch                       Location ▾
─ Today ─ Stock ─ Counts ─ Purchasing ─ Waste ───────────────────────────────
┌──────────────┬──────────────┬───────────────┬──────────────┐
│ Stock value  │ Food cost    │ Waste this wk │ To order     │
│ SAR 18,420   │ 31.2%        │ SAR 640       │ 9 items      │
│ last count 3d│ target 30%   │ 2.4% of buys  │ 2 suppliers  │
└──────────────┴──────────────┴───────────────┴──────────────┘
 Needs attention (4)                     │ This week
 ● Chicken thighs are running low.       │ Thu  Delivery · Al Watania
   About 1 day left.  Order ›            │ Sat  Weekly count
 ● Weekly count is due today.  Start ›   │ Sun  Delivery · Fresh Farms
 ● Tomatoes went up 14% on the last      │
   delivery. 3 dishes affected.  See ›   │ Waste by reason (bar, 7 days)
 ● Order from Fresh Farms by 4 PM for    │ ▇▇▇▇▇ Expired
   Thursday.  Review order ›             │ ▇▇▇ Over-prepped
                                         │ ▇ Dropped
```

- `WorkspaceMetricGrid` with four `WorkspaceMetric`s (values in
  `<bdi dir="ltr">` with `tabular-nums`). Money metrics are replaced by quantity
  metrics ("Items low", "Counts this month") for people without the cost grant.
- **Needs attention:** at most five rows, ranked by money at stake, each one
  sentence plus one link. Sources, all computed in the region: items below
  "order more when below"; count due (from the count schedule); unreviewed
  count; delivery expected today; order cut-off today; price rise over 5% on the
  last delivery; dishes over the target food cost (phase 3); dishes sold without
  a recipe, ranked by sales (phase 3); items sold out by stock (phase 3).
- **This week:** deliveries expected, counts scheduled, prep (phase 4).
- **New organization:** a setup checklist in place of the attention list, copied
  from `components/reservations/settings/setup-checklist.tsx` with its pure
  progress logic in `utils/inventory/setup-progress.ts`: (1) Add your items (2)
  Say where you keep them (3) Do your first count (4) Record a delivery.
  Dismissible; each step links to its screen.

### Stock

The item list. One list for everything you count: bought items and items made in
house.

```
Stock                                          [Log waste] [Add item]  ⋯
[ Search items… ]  [All ▾ category]  [All areas ▾]  [ Low only ]
┌───────────────────────────────┬──────────────────┬──────────┬────────┐
│ Item                          │ On hand          │ Value    │        │
├───────────────────────────────┼──────────────────┼──────────┼────────┤
│ Chicken thighs                │ 6 kg   ▃▁▁▁▁     │ SAR 168  │ Low    │
│ Meat · Walk-in fridge         │                  │          │        │
│ Garlic sauce   Made in house  │ 4 L    ▆▆▆▁▁     │ SAR 22   │        │
│ Sauces · Walk-in fridge       │                  │          │        │
│ Pita bread                    │ 0 bags           │ —        │ Out    │
└───────────────────────────────┴──────────────────┴──────────┴────────┘
Showing 48 of 112 · Show more
```

- `Frame` + `Table variant="card"` on `md` and up; `ItemGroup` of outline
  `Item`s below `md` (the `staff-roster.tsx` pattern). Search is a debounced
  `Input type="search"` in `role="search"`; filters are `FilterSelect` and an
  `aria-pressed` toggle; filter state lives in URL params; "Show more" raises
  the limit (50, max 200).
- **On hand** shows the quantity in the item's count unit and, when a "fill up
  to" level exists, a small bar against it. Status `Badge`: `warning` Low,
  `destructive` Out, nothing when fine. No "OK" badges.
- **Item sheet** (row click; child route rendered in a `Sheet` from the parent,
  side flipped for RTL, chrome from `SheetPanel` as in `team.tsx`). Sections,
  not tabs:
  - Summary: on hand per location (one line per location for "all locations"),
    last counted, levels.
  - Cost (cost grant): cost per unit from the last delivery and a small price
    history line chart (`@repo/ui/chart`), stock value.
  - Buying: suppliers and their pack sizes and prices.
  - Recipe (made-in-house items): ingredients, makes how much (phase 3).
  - Used in: dishes and options that use it (phase 3).
  - History: the last movements (delivered, used by sales, wasted, counted,
    adjusted), with who and when.
  - Actions: Edit, Adjust stock (with a required reason), Archive.
- **Add / edit item** is a sheet with progressive questions, only the first two
  required:

  ```
  Name            [ Chicken thighs              ]
  Category        [ Meat ▾ ]
  Measured in     ( kg ) ( L ) ( pieces )                  ← base unit
  How you buy it  [ Al Watania ▾ ]  [ Box ] of [ 10 ] [ kg ]  SAR [ 280 ]
                  □ Priced by weight (the invoice shows the real kg)
  How you count   ( kg ) ( Box )                           ← count unit
  Kept in         [ Walk-in fridge ▾ ]
  Order more when below [ 8 ] kg     Fill up to [ 30 ] kg   (phase 2)
  ```

- **Add many items** (ellipsis menu, and the setup checklist):
  - **Starter list by restaurant type** (shawarma/grill, burger, pizza, cafe,
    bakery, casual dining): a checklist of common items with categories, units
    and storage areas. Names come from Lingui and are saved as plain text in the
    language the operator is using when they add them.
  - **Paste from a spreadsheet**: a textarea that takes name, category, unit,
    price per unit; preview, fix, add. Same shape as `staff+/team.bulk.tsx`.
  - **From a delivery**: recording a delivery can create items on the fly.

### Counts

```
Counts                                         [Log waste] [Start count]  ⋯
 In progress
 ┌─────────────────────────────────────────────────────────────────────┐
 │ Weekly count · Olaya · started 9:12 by Sara      32 of 48  [Resume] │
 └─────────────────────────────────────────────────────────────────────┘
 Past counts
 Date        Count            By        Items   Difference   Status
 Sat 1 Nov   Weekly count     Omar      48      −SAR 212     Approved
 Thu 30 Oct  Proteins         Sara      9       −SAR 40      Approved
```

- **Start count** asks one thing: which list. "Everything" or a saved **count
  list** ("Proteins daily", "Bar weekly"); lists are edited in Settings. A count
  belongs to one location and one business date.
- **Counting** is a full page built for a phone held in one hand:
  - Area tabs (stock `TabsList variant="line"` inside `WorkspaceTabDivider`) in
    shelf order; within an area, items in the saved shelf order.
  - Each row: name, the count unit, a large numeric field with − and + (a new
    `QuantityStepper`, 44 px touch targets, Arabic-digit aware parsing shared
    with `utils/money-input.ts`), quick fractions ¼ ½ ¾ for open packs, and a
    unit switch when the item has more than one count unit ("2 boxes and 3 kg"
    becomes two entries in one row).
  - Fields start blank. Last count is shown faintly only after a value is
    entered, never as a default.
  - Each entry saves on blur to the region with a visible state per row (saving,
    saved, failed with retry). Unsent entries are also kept in `localStorage`
    keyed by count id, so a dropped signal in the walk-in loses nothing; the
    page shows "3 entries waiting to send" until they land.
  - Several people can count the same count at once; each entry records who and
    when; the same item counted in two areas is added up.
  - Progress "32 of 48" in the header; **Finish** when done.
- **Review** (Mise's chef review, simplified): a list of only the rows that need
  a look, and a detail panel on desktop (stacked on mobile):
  - not counted (choose "Same as before" or "None left"),
  - big differences: more than 20% and more than SAR/USD 25 away from what we
    expected (with recipes: expected use; without: last count + deliveries −
    waste). Each shows "Expected 49 kg · Counted 46 kg · 3 kg missing · SAR 84"
    and a note field.
  - "41 items match and need no review."
  - **Approve count** (cost grant) posts the adjustments and closes the count; a
    completion dialog summarises: items counted, difference in money, food cost
    for the period now available.

### Purchasing

Phase 1 ships deliveries and suppliers; phase 2 adds suggested orders.

```
Purchasing                     [Log waste] [Record delivery] [New order]  ⋯
 Suggested orders                                          (phase 2)
 ┌───────────────────────────────┐ ┌───────────────────────────────┐
 │ Al Watania Poultry            │ │ Fresh Farms                   │
 │ 6 items · SAR 1,840           │ │ 4 items · SAR 310             │
 │ Order by Wed 4 PM for Thu     │ │ Below minimum SAR 400         │
 │                [Review order] │ │                [Review order] │
 └───────────────────────────────┘ └───────────────────────────────┘
 Open orders        Al Watania · sent Tue · due Thu · SAR 1,920 [Receive]
 Recent deliveries  Mon 3 Nov · Fresh Farms · INV-4471 · SAR 412  Unpaid
 Suppliers ›
```

- **Record delivery / Receive delivery** is a full page with the
  `MenuFormHeader` sticky bar (Back, title, Cancel, Save):
  - From an order, lines are pre-filled: ordered vs received (stepper), price
    pre-filled from the supplier price; changing it highlights the change in %.
    Short or missing lines offer "Ask for credit" which drafts the credit
    message.
  - Without an order, add lines by searching items (create one inline if
    missing).
  - "Priced by weight" lines ask for the real weight on the invoice.
  - Footer: supplier invoice number, invoice date, VAT amount (separate from
    prices), total check against the invoice ("Lines SAR 1,912 · Invoice SAR
    1,920 · SAR 8 apart"), ZATCA invoice reference for KSA (optional text or a
    scanned QR value), attach a photo of the invoice (phase 2), paid / unpaid.
  - Save posts stock in, updates last prices, and toasts "Prices updated for 2
    items".
- **Suggested orders** (phase 2): per supplier, items at or below "order more
  when below", quantity to reach "fill up to", rounded up to whole packs. When
  recipes and sales exist, "fill up to" can be suggested from use ("you use
  about 22 kg a week"). Nothing is ever sent without review.
- **Review order** (full page): lines in packs with steppers, total, minimum
  order and cut-off from the supplier, then **Send** by email (tenant-api email
  for KSA, App email for US, from the organization's sending identity), WhatsApp
  (a `wa.me` link with the order text; no WhatsApp API), copy text, or PDF.
  Status: Draft, Sent, Partly received, Received, Cancelled.
- **Suppliers** (`inventory/purchasing/suppliers`, list + sheet): name, contact
  person, phone, email, order by (email/WhatsApp/phone), delivery days, order
  cut-off, minimum order, payment terms, VAT number. Unpaid deliveries total
  ("You owe SAR 4,210") with **Mark paid** per delivery. That is the whole of
  accounts payable in this plan.

### Waste

The dialog is the Mise dialog, almost unchanged, because it is right.

```
┌ Log waste ──────────────────────────────────────────┐
│ What was wasted?                                    │
│ [ 🔍 Chicken thighs                             ▾ ] │
│ Recent  (Tomato sauce) (Pita bread) (Chicken plate) │
│ Amount                                              │
│ [ 2.3          ]   ( kg ) ( Box ) ( portions )      │
│ Reason                                              │
│ (Expired) (Spoiled) (Over-prepped) (Dropped)        │
│ (Returned plate) (Staff meal) (Other)               │
│ Note (optional) [                               ]   │
│ Cost SAR 64.40                                      │
│ Logged as Sara           [Cancel] [Log waste]       │
└─────────────────────────────────────────────────────┘
```

- `Dialog` with a `Popover` + `Command` picker over items **and** dishes (the
  pattern of `components/loyalty/catalog-picker.tsx`); recent chips; a
  `ToggleGroup` for unit and for reason. A wasted dish is recorded as its
  recipe's ingredients (phase 3); before recipes exist, dishes are not offered.
- After saving: a toast "Waste logged: chicken thighs, 2.3 kg" with **Undo** for
  60 seconds (Sonner's action button; undo writes a reversing entry, the
  original stays). This is the first undo toast in the App; it goes in
  `components/undo-toast.ts` for reuse.
- **Waste tab:** metrics (waste this week in money, % of purchases, top reason),
  a horizontal bar of waste by reason and one by category (`@repo/ui/chart`
  Recharts; no hex or waffle charts), and the log (`Table variant="card"`,
  newest first, who, item, amount, reason, cost). Station POS line voids with
  reason `quality` show as "Remade at the till" in the log (phase 3).

### Dish costs in the menu

Owners think "what is in my burger" at the burger, so recipes live on the menu
item, not on an inventory page. Shown only when `inventory.recipes` is on.

- **Menu item editor** gets an **Ingredients and cost** section in its right
  column summary and a full section in the form:

  ```
  Ingredients                                  per dish
  Chicken thighs        180 g    usable 85%    SAR 5.93
  Pita bread            1 piece                SAR 0.40
  Garlic sauce (made)   40 ml                  SAR 0.22
  [ + Add ingredient ]
  ───────────────────────────────────────────────────
  Cost to make  SAR 6.55   Price SAR 22.00   Food cost 29.8% ●
  Target 30%    Price for target  SAR 21.83
  ```

  - Sizes (variants): each size gets a multiplier of the base recipe (default
    1×) or its own recipe.
  - **Options** get a recipe effect in the modifier option editor: "Adds 30 g
    Mozzarella" or "Replaces Milk with Oat milk". Pizza halves take half.
  - **Type a cost instead** for dishes the owner will not break down (bought-in
    desserts, cans): a fixed cost per dish, labelled as typed.

- **Menu items list** gets a "Food cost" column (percent with a status dot) and
  a sort by it.
- **Made in house items** (sauces, dough, marinated meat) have their recipe in
  the Stock item sheet: ingredients and "makes 4 L".
- A **Dishes without a recipe** panel on Today ranks dishes by last 30 days'
  sales, so the owner sets up the top 10 first and stops.

### Prep (phase 4)

The Mise prep board, built on our data instead of a forecast black box.

- **Prep list** for a location and day: made-in-house items with a "fill up to"
  per weekday, suggested amount = fill up to − on hand, rounded to the batch
  size, nudged by expected demand (same weekday last 4 weeks of item sales, plus
  booked covers from reservations when that module is on). Every number explains
  itself in a tooltip ("Fill up to 6 L · have 2 L · Fridays sell 20% more").
- **Board** view (To do, In progress, Done) and list view, filtered by kitchen
  station. Stations are the ones the location already named in Kitchen setup (up
  to 12, `docs/pos.md#kitchen-display`); inventory adds no station list of its
  own. A made item is routed to a station the way menu items are. Marking a
  batch done records "Made 4 L garlic sauce", which adds the item and takes its
  ingredients.
- **Station:** the Kitchen app gets the same board for the tablet on the wall
  (see [Station apps](#station-apps)).

## Station apps

Station (`apps/station`) is the collection of apps staff use on a paired tablet:
Register, Kitchen, Time clock and Reservations today. Inventory work that
happens with hands full and away from a desk belongs there. The rule that splits
the work: **Station is for doing, the App is for deciding.** On a tablet staff
count, log waste, receive deliveries and work the prep list. They never see
money, never edit items, recipes, suppliers or levels, and never approve a
count. Those stay in the App, where the cost grant and the manager are.

### Stock (new app, phase 2)

A fifth app in the launcher, **Stock**, with three big tiles on its home:
**Count**, **Waste** and **Delivery**, plus "In progress" cards for a count
already started on any device.

- **Count.** Start a count from a count list or join one in progress (from the
  App, a phone or another tablet; each device takes its areas). Same screen
  rules as the App count page, sized for a tablet: area tabs in shelf order,
  blank fields, large − and + with ¼ ½ ¾, a unit switch per row, "32 of 48". No
  expected figures and no last count on the tablet, so nobody copies a number.
  **Send for review** ends the tablet's part; review and approval happen in the
  App.
- **Waste.** The waste dialog as a full-screen sheet: items and (with recipes)
  dishes from the till's menu, recent chips for this terminal, unit, reason,
  optional note. No cost shown. Undo for 60 seconds.
- **Delivery.** Today's expected deliveries for this location (open orders), or
  "Delivery without an order" (pick a supplier, add items). Tick each line
  received, change the amount for shorts, type the real weight for "priced by
  weight" lines, enter the invoice number, and take a photo of the invoice. **No
  prices on the tablet.** The delivery lands in the App as "Received at the
  tablet by Omar · check prices" on Today and in Purchasing, where a person with
  the purchasing grant confirms prices, VAT and the invoice total.

**Offline.** Walk-ins and freezers have no signal, so Stock is offline-first,
like punches and unlike the host stand:

- The catalogue the app needs (items, count units, storage areas, shelf order,
  count lists, open counts, expected deliveries, waste reasons; never prices) is
  downloaded per location from `GET /pos/inventory/catalog` and cached in
  IndexedDB, refreshed like the menu (every 5 minutes while open and on focus).
  A catalogue older than 24 hours shows a warning but still counts.
- Count entries, waste and delivery receipts are queued in a new Dexie store
  (`db.ts` version 7: `stockCatalog`, `stockQueue`) with client ids, and sent
  oldest first through the till's outbox (`lib/outbox.ts`). The server
  de-duplicates by client id. Invoice photos are queued as blobs with a size cap
  and upload when online (to in-region storage).
- An outage (5xx with nothing answered, 502, 503, 504, 429) stops the run and
  never drops an entry, the punch-queue rule. Waste and deliveries made more
  than 48 hours before they reach the server are accepted and flagged
  `late_sync` for a manager. Count entries for a count that was approved or
  cancelled while the tablet was offline answer 409 `count_closed` and are
  listed on the tablet ("Sent after the count closed: 3 entries") until cleared;
  the manager sees them in the App's review history.
- The header's sync dot and the "waiting to send" count cover Stock entries as
  they cover sales.

**Who and where.**

- Per-terminal setting `pos_devices.inventory_enabled` (and its pairing-code
  copy), switched in the App at Settings, Terminals, Station apps (or when
  pairing), **and** the organization flag `inventory.enabled`. Switching it on
  needs `update:inventory:any`, signed into the operator token's `stationApps`
  claim; deploy App before tenant-api when the claim gains the field. `/pos/me`
  reports `apps.inventory`.
- Needs a location (the terminal's bound location is the stock's location) and
  staff sign-in on the terminal (the server refuses the setting otherwise), like
  the host stand. Every entry records the signed-in staff id; the App shows
  first name and last initial.
- Any signed-in staff member may count and log waste. Receiving a delivery needs
  a till manager (`pos_managers`) unless the location turns on "Any staff can
  receive deliveries" in inventory Settings.

**Server.** `routes/pos-inventory.ts` under `/pos/inventory/*`: `GET /catalog`,
`POST /counts` (start), `POST /counts/:id/entries` (batch, client ids),
`POST /counts/:id/send`, `POST /waste` (batch), `POST /deliveries`,
`POST /deliveries/:id/photo` (presigned in-region upload). Every call verifies
the device, its server-bound location and a current `Pos-Staff-Session`;
`POS_ENABLED=false`, `INVENTORY_ENABLED=false` and revocation stop it; responses
are `no-store` and carry no money and no supplier contacts. Writes go through
`withInventoryWrite`. CORS allows `POS_ORIGINS` on `/pos/*` as today.

**Contract and tests.** Wire schemas live in `@repo/inventory`
(`contract/station.ts`). The tablet's payloads are recorded fixtures in
`apps/station/src/apps/stock/fixtures`, kept in step by
`apps/tenant-api/src/routes/pos-inventory-contract.test.ts` (re-record with
`RECORD_STATION_FIXTURES=1`, as for the host stand). A Station e2e spec covers
offline count → reconnect → review in the App, waste undo, and a delivery with a
short line. **Demo mode** gets a sample catalogue and an in-memory count, like
the Kitchen demo, and sends nothing.

### Kitchen (existing app)

- **Log waste** button in the Kitchen header (phase 2, with Stock), opening the
  same waste sheet and queue. Cooks waste food in the kitchen, not at a desk.
- **"Log it as waste?"** (phase 3): when a ticket shows the stop-prep warning
  (cancelled, voided or fully refunded after Preparing started), the ticket
  offers one tap to record the dishes already started as waste with reason
  "Cancelled after cooking". Never automatic: the cook knows whether the food
  was saved.
- **Prep** (phase 4): a Prep view beside the ticket board, filtered by the
  screen's own kitchen station, with Start and Done per task; Done asks "How
  much did you make?" pre-filled with the plan. Prep writes follow the Kitchen
  rules, not the Stock queue: online only, read back after an uncertain write,
  never replayed blindly.

### Register (existing app)

No new screens in this plan.

- Dishes sold out by stock (phase 3) arrive through menu availability, so the
  till shows its existing "Sold out" within its 5-minute menu refresh.
- Line voids already carry a reason. The region turns `quality` voids into dish
  waste ("Remade at the till") and lists `out_of_stock` voids on Today ("Ran out
  at the till: pita bread, 3 times"), with no change to the till or the order
  contract.
- Later, not in this plan: "Only 4 left" on menu buttons for items with auto
  sold out on, and a manager action to mark a dish sold out from the till (the
  till can only show sold out today; that is a menu feature, not inventory).

### Time clock and Reservations

Nothing changes. Expected covers from reservations feed the prep nudge on the
server side only.

### Languages

Station strings are Lingui (`npm run lingui:extract -w station`, fill `ar.po`;
re-run extract after adding strings or the preview build shows hashed ids).
Item, area and supplier names show exactly as typed; dish names resolve through
`lib/menu-text.ts` like the till. Quantities use the same `formatQuantity` as
the App, so units read in the till's language.

## Architecture

### Placement (decision, to be written as ADR 049)

**All inventory data lives in the regional tenant database**, for both `us` and
`ksa` organizations. The control plane keeps only feature flags and permissions.

Why regional and not the control plane (where discount definitions live):

- Stock is used by sales, and sales are regional (`restaurant_orders`,
  `pos_orders`). Deducting inside the region keeps the sale and the stock
  movement in one database and lets the deduction be queued in the sale's own
  transaction, the way loyalty does it.
- Station counts and waste go browser-direct (and offline) to the region, like
  punches.
- Counts, waste and deliveries name staff (who counted, who logged), and
  suppliers carry business contacts. Both are personal data under the same rules
  as staffing.
- KSA operators expect their purchasing records and supplier invoices in-region.

Cross-plane traffic is ids and counts only:

- Recipes reference menu item, variant and option ids (opaque strings from the
  control plane). The App menu editor reads and writes them browser-direct with
  an inventory token. No menu names are copied into the region; the browser
  joins names.
- **Auto sold out** (phase 3): the region posts
  `{orgId, locationId, entityType, entityId, available}` to an App resource
  route (`/resources/inventory/availability`, internal token). The App writes
  the location override `availabilityStatus` and purges the menu cache, which
  reaches Sites at once, QR at once, and Station within its 5-minute menu
  refresh.
- Alerts reuse the manager-alert shape:
  `{orgId, eventId, kind, locationId, count}` to `/resources/inventory/notify`.

### Locations

Stock lives at a location. The item catalogue, suppliers and recipes are
organization-wide; storage areas, levels, counts, deliveries, orders, waste,
prep and stock are per location. An organization with no locations uses the
implicit location `main`, the same fallback as staffing's `DEFAULT_SCOPE_ID`,
and every location picker is hidden while there is one. The token carries
`locationIds` from `UserOrganization.locationScope` (resolver shared with
discounts and loyalty), and every list and write route enforces it with one
helper.

### Data model

Tenant conventions as elsewhere: snake_case, `*_at` epoch ms UTC, `*_date`
`YYYY-MM-DD` in the location's time zone with the location's day start,
quantities as integer thousandths of the item's base unit (see [Units](#units)),
money as integer minor units with currency, rates in basis points. One tenant
migration per release (`00NN_inventory`; next free number after the in-flight
sync, `0033` at the time of writing — recheck). Movements, count entries,
delivery lines and waste are append-only with triggers like `0025_loyalty.sql`.

| Group      | Tables                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup      | `inv_settings` (target food cost, units system, count schedule), `inv_storage_areas`, `inv_count_lists`                                           |
| Catalogue  | `inv_items` (name, category, kind bought/made, base unit, archived), `inv_item_units` (named units: "Box" = 10 kg)                                |
| Per place  | `inv_item_places` (item × location: areas and shelf order, order-more-when-below, fill-up-to, per-weekday prep level)                             |
| Ledger     | `inv_movements` (signed quantity, value, kind, source, reason, actor, business date) — on hand is the sum                                         |
| Cost       | `inv_item_costs` (item: last price per base unit and date, weighted average, updated on delivery)                                                 |
| Counts     | `inv_counts` (location, list, status, business date, approved by), `inv_count_entries` (item, area, quantity, unit, counter)                      |
| Buying     | `inv_suppliers`, `inv_supplier_products` (pack, price, priced by weight), `inv_orders`, `inv_order_lines`                                         |
| Deliveries | `inv_deliveries` (invoice no., date, VAT, ZATCA ref, photo key, paid), `inv_delivery_lines` (received, price, real weight)                        |
| Waste      | `inv_waste` (what: item or dish, amount, reason, note, actor) — its movements reference it                                                        |
| Recipes    | `inv_recipes` (owner: menu item, variant, option, or made item; version, effective from), `inv_recipe_lines` (item, quantity, usable %, replaces) |
| Sales use  | `inv_sale_usage` (source kind and id, item, location, quantity now deducted), `inv_outbox` (sources to settle)                                    |
| Prep       | `inv_prep_tasks` (location, date, item, amount, kitchen station id, status)                                                                       |
| Transfers  | `inv_transfers`, `inv_transfer_lines` (phase 5)                                                                                                   |
| Audit      | `inv_audit_log`                                                                                                                                   |

Supplier contact fields and actor columns are added to the person-erasure PII
column test with a reason (business contacts, staff actors), and erasing a staff
member clears actor names, keeping quantities and money.

### Phase 2 wire contract

Written in `@repo/inventory` before any region, Station or App code; additive to
phase 1 (nothing renamed or removed). Requests are strict, money is omitted
without `read:inventory_cost:any`, versioned rows take `expectedVersion`, and
creates carry a `clientId`. "Flag" is the control-plane flag the route needs on
top of `inventory.enabled`; "purchasing" is `update:inventory_purchasing:any`.
Operator routes are under `/operator/inventory`.

| Route                                            | Grant                  | Flag       | Answer                                                                |
| ------------------------------------------------ | ---------------------- | ---------- | --------------------------------------------------------------------- |
| `GET /levels?locationId=`                        | read                   | purchasing | `listLevelsResultSchema` (every item with its levels)                 |
| `GET /levels/suggestions?locationId=`            | read                   | purchasing | `levelSuggestionsSchema` ("you use about 22 kg a week")               |
| `PUT /levels/bulk`                               | purchasing             | purchasing | `putLevelsResultSchema` (per row `updated` or `refused`)              |
| `GET /orders/suggested?locationId=`              | read (money: cost)     | purchasing | `suggestedOrdersSchema` (a card per supplier, `unsourced` items)      |
| `POST /orders`                                   | purchasing             | purchasing | `orderDetailSchema` (draft, from the suggestion or blank)             |
| `GET /orders?locationId=&status=`                | read                   | purchasing | `listOrdersResultSchema`                                              |
| `GET /orders/:id`                                | read                   | purchasing | `orderDetailSchema`                                                   |
| `PATCH /orders/:id`                              | purchasing             | purchasing | `orderDetailSchema` (lines only while draft)                          |
| `POST /orders/:id/send`                          | purchasing             | purchasing | `sendOrderResultSchema` (`emailSent`, `waLink`, `mailto`, text)       |
| `POST /orders/:id/cancel`                        | purchasing             | purchasing | `orderDetailSchema`                                                   |
| `GET /orders/:id/text?locale=`                   | read                   | purchasing | `orderTextSchema` (never money)                                       |
| `GET /orders/:id/receive-prefill`                | read (money: cost)     | purchasing | `receivePrefillSchema` (lines prefilled with what is outstanding)     |
| `POST /deliveries` (extended)                    | update (`paid`: purch) | none       | `recordDeliveryResultSchema`; `orderId`, `quantityOnly`, `closeOrder` |
| `POST /deliveries/:id/confirm-prices`            | purchasing             | none       | `recordDeliveryResultSchema` (quantity-only delivery gets its prices) |
| `POST /deliveries/:id/credit-message`            | read                   | none       | `creditMessageSchema` (draft text for short and missing lines)        |
| `POST /deliveries/:id/invoice-photo` + `confirm` | update                 | none       | `invoicePhotoUploadSchema`, then `deliveryDetailSchema`               |
| `GET /price-alerts?locationId=&days=`            | cost                   | none       | `priceAlertsSchema` (rises over 5%)                                   |
| `POST /api/inventory/tick`                       | internal token         | none       | `inventoryTickAnswerSchema` (counts only)                             |
| App `POST /resources/inventory/notify`           | internal token         | none       | `inventoryNotifyEventSchema` in, `inventoryNotifyResultSchema` out    |

Station (`/pos/inventory/*`, device secret plus `Pos-Staff-Session`, contract
header `Pos-Inventory-Contract`, `INVENTORY_POS_CONTRACT_VERSION = 1`; all in
`contract/station.ts`): `GET /catalog`, `POST /counts` (start or join),
`GET /counts/:id`, `POST /counts/:id/entries`, `POST /counts/:id/send`,
`POST /waste`, `POST /waste/:id/undo`, `POST /deliveries`,
`POST /deliveries/:id/photo` and `/photo/confirm`. No money anywhere in a
Station response (a test walks the schemas). The tablet's Dexie queue row is
`stationOutboxItemSchema`; `classifyStationFailure` decides permanent, pause,
retry or unpair for each error code.

Rules decided in the contract (pure code with tests in
`contract/orders-rules.ts`, shared by region, App and Station):

- **Needs an order** when on hand plus what is on sent orders is **below**
  "order more when below" (the same `<` as the Low badge), or out with only
  "fill up to" set. Quantity reaches "fill up to", **rounded up to whole
  packs**, never below one pack; a pack priced by weight is ordered in
  **halves**. With no "fill up to" the target is "order more when below". Drafts
  do not count as on order, so a suggestion shows the draft id and the App
  offers "Continue draft".
- **Supplier choice** per item: the preferred product, else the only one, else
  the cheapest per base unit; an item with levels but no supplier product is
  listed under `unsourced`.
- **Expected date and cut-off** from the supplier's delivery days and cut-off
  (`nextOrderableDelivery`): the first delivery day whose cut-off has not
  passed; the region owns time zones, the contract carries local date and time.
- **Order status**: `draft` → `sent` (send, any channel) → `partly_received` →
  `received` (`orderStatusAfterReceipt`; a priced-by-weight line counts as
  complete at 95% of the ordered weight; `closeOrder` ends it short).
  `cancelled` and `received` are final. Receiving against a draft is allowed.
- **Send** is one call: it renders the text, emails it only when the node can
  (otherwise `emailSent: false`, `emailSkipped`, and a `mailto`), builds a
  `wa.me` link for WhatsApp, and marks the order sent. PDF is the App printing
  the same text; there is no server PDF in phase 2. Order text never contains
  money and is written in the caller's `locale` (`en` or `ar`) by the region.
- **Quantity-only receiving** (`quantityOnly: true`): any token with
  `update:inventory:any` may record received quantities without prices; costs
  and supplier prices are untouched; the delivery is `pricesPending` until a
  person with the purchasing grant calls `confirm-prices`. `paid: true` needs
  the purchasing grant (403 `purchasing_required`). Priced receiving is
  unchanged.
- **Station deliveries never refuse goods**: a closed, unknown or other-supplier
  order is recorded unlinked (`orderLinkIgnored`), unlike the operator route
  (409 `order_closed`, `supplier_mismatch`). Receiving at the tablet needs a
  till manager unless `anyStaffCanReceive` (inventory Settings).
- **Price alerts** are the whole answer in money, so they need the cost grant
  (403 otherwise). A rise of more than 5% against the previous priced delivery;
  20% or more is "big".
- **Invoice photo**: one per delivery, JPEG, PNG or WebP up to 5 MB, uploaded
  straight from the browser to the region's own object storage with a presigned
  `PUT` (generalised `lib/recording-storage.ts`, prefix
  `inventory-invoices/<orgId>/`), then confirmed. Read link on
  `GET /deliveries/:id` only, five minutes. Deprovisioning deletes the prefix.
- **Notifications**: counts and ids only, `eventId` is a SHA-256 hex digest of
  `inventoryNotifyDedupeKey` (date for digests and due deliveries, count id for
  review, delivery id for a price rise). The tick posts them, retries deferred
  ones and reports counts only.

### Phase 2 schema needs

The wire contract needs these additions to `packages/tenant-db` (one new
migration, built as `0034_inventory_orders`, items 1 to 8 included, with guard
triggers: order lines change only while the order is a draft, order status only
moves forward and a closed order is final, a quantity-only delivery line may be
priced exactly once, waste source and invoice photo type are checked).
`inv_deliveries.currency` stays NOT NULL, so a quantity-only delivery stores the
organization's currency. `inv_orders` and `inv_order_lines` were in the data
model above but not in `0033_inventory`; they are new in `0034`. The Durable
Object bundle (`workers/migrations.generated.ts`) is generated from the journal,
so it picks `0034` up with `npm run generate:do-migrations`.

1. **`inv_orders`**: `id`, `number` (integer, unique, from
   `inv_settings.next_order_number`), `location_id`, `supplier_id` (not null),
   `status` (`draft|sent|partly_received|received|cancelled`, check),
   `expected_date`, `note`, `currency`, `created_by_kind`, `created_by_id`,
   `sent_at` (first send), `sent_via` (`email|whatsapp|copy|pdf`), `closed_at`,
   `version`, `created_at`, `updated_at`. Indexes on `(location_id, status)` and
   `(supplier_id)`. A unique client id for create (or the idempotency table, as
   for deliveries).
2. **`inv_order_lines`**: `id`, `order_id`, `item_id`, `supplier_product_id`,
   `pack_name`, `pack_base_quantity`, `priced_by_weight`, `packs` (thousandths
   of a pack), `quantity` (base thousandths, packs × pack size), `price_minor`
   (pack price snapshot, null when unpriced), `suggested_packs` (thousandths,
   null), `sort_order`. Lines are replaced wholesale while the order is a draft.
3. **`inv_deliveries`**: `order_id` (nullable), `prices_confirmed_at` (null
   while a quantity-only delivery waits), `quantity_only` (boolean), `late_sync`
   (boolean), `photo_content_type`, `photo_uploaded_at`. `photo_key` already
   exists. `source = 'station'` already exists.
4. **`inv_delivery_lines`**: `order_line_id` (nullable), `priced_at` (null for a
   quantity-only line). `line_total_minor` stays NOT NULL: a quantity-only line
   stores 0 with `priced_at` null, which avoids rebuilding the table. The
   append-only trigger must allow ONE update of `price_minor`,
   `line_total_minor` and `priced_at` while `priced_at` is null (confirm
   prices), and nothing else. Received per order line is the sum over delivery
   lines with that `order_line_id` (index it).
5. **`inv_settings`**: `any_staff_can_receive` (boolean, default 0) and
   `next_order_number` (integer, default 1).
6. **`pos_devices.inventory_enabled`** (and the same column on
   `pos_pairing_codes`), default 0; optionally `inventory_disabled_at` like the
   time clock's, so a replay can tell a switch turned off after the item was
   made.
7. **`inv_waste`**: `source` (`operator|station`), `device_id`, `late_sync`
   (boolean). `device_id` feeds the recent-items chips per terminal. Optionally
   `device_id` on `inv_count_entries`.
8. **`inv_alert_log`** (notification dedupe and retry): `kind`, `location_id`,
   `dedupe_key`, `count`, `status` (`sent|pending`), `attempts`, `sent_at`;
   unique on `(kind, location_id, dedupe_key)`. Without it the tick would resend
   an alert every hour (the App dedupes by event id, but a retry state is needed
   for the 50-second budget and App outages).
9. **No table** for credit (the message is drafted on request), price alerts
   (computed from priced delivery lines, `idx_inv_delivery_lines_item_created`),
   suggestions or levels from use (computed from movements). An optional
   `inv_deliveries.credit_requested_at` would let the list show "Credit asked".
10. Person-erasure column test: `inv_orders.created_by_id` and the new actor
    columns, like the other actor columns.

### Phase 2 operator API: how it was built

The operator routes of the table above are built in `apps/tenant-api`
(`routes/operator-inventory-{levels,orders,purchasing}.ts`, services
`inventory-{levels,orders,receiving,tick}-service.ts`, order and credit text in
`inventory-order-text.ts`). Decisions the contract left open:

- **Flag.** `inventoryGuard({ feature: 'purchasing' })` answers 403
  `feature_disabled` for levels and orders. `POST /deliveries` has no flag, but
  an `orderId` in it needs `purchasing` (the route checks the token's claim; the
  Station route will check the region's flags).
- **Order number** comes from `inv_settings.next_order_number`. An organization
  that never saved its settings gets a row written at **version 0** by its first
  order (it still reads as "never saved": the first `PUT /settings` sends
  `expectedVersion: 0`).
- **Cut-off.** A supplier with no cut-off time shows `cutoff: null` (a delivery
  day is still chosen with the default cut-off of 23:59 the day before).
  `cutoffPassed` is only true when the supplier has delivery days and none fits
  the 14-day look-ahead.
- **Pack steps.** `packs` must be a multiple of 1 (0.5 for a pack priced by
  weight); anything else is 400 `pack_step`.
- **Email.** `POST /orders/:id/send` with `channel: 'email'` delivers through
  `sendTenantEmail` before the order is marked sent (a provider failure is 502
  `email_failed` and nothing changes). "Can send" means OCI is configured, the
  mock transport is on, or the Node entry registered the development file sink
  (`canSendTenantEmail`); otherwise `emailSkipped: 'not_configured'` and a
  `mailto`. There is no inventory email kill switch (the order is sent by a
  person; `INVENTORY_ENABLED` already stops the routes), so
  `emailSkipped: 'disabled'` is never produced.
- **Quantity-only receiving** stores the delivery's currency as: what the items
  already cost in, else the order's or supplier's currency, else the location's
  reservations currency, else USD. The movement has no value; lines are stored
  with a zero total and `priced_at` null. `confirm-prices` prices the lines once
  and writes the value of the purchase as a **zero-quantity `delivery`
  movement** (movements are append-only), so food cost counts it from the day it
  is confirmed.
- **Price rises** (alerts, Today, the tick) are measured on lines whose price is
  set (`priced_at`), against the previous priced delivery of the item at the
  location, among prices set in the window.
- **Invoice photos** use the region's recording bucket (`RECORDING_S3_*`) under
  `inventory-invoices/<orgId>/`; there is no local fallback (a node with no
  bucket answers 503 `upload_not_configured`). Deprovisioning deletes both the
  call-recording and the invoice prefix. An upload that was never confirmed
  stays in the bucket until deprovisioning.
- **Tick.** `inv_alert_log` rows are created from 07:00 local for the daily
  kinds; see `docs/scheduled-jobs.md#inventory-tick`.

### Units

- Every item has one base unit: **gram** (mass), **millilitre** (volume) or
  **piece**. Quantities are stored as integer **thousandths** of the base unit,
  so 1.5 kg is 1,500,000 and a quarter of a piece is 250. One rule for all three
  keeps fractions of open packs exact and fits SQLite integers.
- Standard units convert automatically: g, kg, ml, L, and for US organizations
  oz, lb, fl oz, qt, gal. Display system (metric or US) comes from the region
  and can be changed in Settings; storage is always metric.
- Named units are per item ("Box" = 10 kg, "Case" = 6 × 1 L, "Bag" = 25 kg,
  "Tray" = 30 pieces). A named unit that has been used cannot change its size;
  the owner adds a new one ("Box (12 kg)") and archives the old. This avoids the
  Restroworks complaint without rewriting history.
- Weight ↔ volume conversion is not automatic. An item measured in pieces can
  have an average weight ("1 piece ≈ 120 g") for recipes that use grams.

### Cost

- **Plate cost and price alerts use the last delivered price** per base unit. It
  is what owners reason with ("chicken went up").
- **Stock value and food cost use a moving weighted average**, updated on each
  delivery, kept out of sight. The owner never chooses a costing method.
- Prices are stored before VAT. VAT on a delivery is stored per delivery, never
  folded into item cost.
- **Food cost %** for a location and period (between two approved counts, or a
  calendar week using the closest counts) = (opening value + deliveries +
  transfers in − transfers out − closing value) ÷ net sales. Net sales = item
  sales less discounts and loyalty rewards, before tax, excluding tips and
  delivery fees, from **both** web/QR orders and Station sales. The UI shows the
  parts on hover so the number is never a black box.

### Sales: one reader for web, QR and Station

There is no single "items sold" source today.
`restaurant/staffing-order-source.ts` and the report subjects read
`restaurant_orders` only; Station sales live in `pos_orders` (lines JSON with
options, `lineVoids`) and `pos_order_lines` (no options, unread). Phase 0 adds
`services/item-sales.ts`: items, variants and options sold per location and
business date from both tables, using the reports' "counted" rule for web/QR and
paid-minus-voided lines for Station. It is the input for depletion, expected
use, "dishes without a recipe", food cost sales and the prep demand nudge.
(Staffing's labor % has the same gap; switching its order source to this reader
is a separate follow-up.)

### Used by sales (phase 3)

Copy the loyalty settle queue (`loyaltySettleQueue` in
`services/loyalty-purchase-service.ts`), not a synchronous deduction:

1. At the same call sites loyalty uses — `placeOrder`, `applyPaymentEvent`,
   `updateOperatorOrder`, `sweepExpiredHolds` in `order-service.ts`; the QR tab
   service; `upsertPosOrder(..., { onStored })` in `routes/pos.ts` — queue
   `(source kind, source id)` into `inv_outbox` inside the sale's transaction.
2. After commit, settle: re-read the source, compute the **desired** usage from
   its current lines and the recipe versions in effect at the sale time, and
   compare with `inv_sale_usage` for that source. Write movements for the
   difference only. A replayed or revised Station upload, a cancelled order or
   an edited tab therefore converges, and never double counts.
3. Rules: counted web/QR orders use stock; cancelled and expired ones return to
   zero. Station: current lines minus voided lines; a void with reason `quality`
   is recorded as waste of the dish; refunds never return stock (the food was
   made).
4. Made-in-house items: a per-item switch **"We make this in batches and count
   it"**. Off (default): sales use its ingredients directly. On: sales use the
   made item, and recording a batch (Prep, or "Record a batch" in the item
   sheet) adds it and uses its ingredients.
5. Sold dishes with no recipe add nothing and feed "Dishes without a recipe".
6. Retries through the hourly inventory tick and the org alarm, like loyalty; a
   paid sale is never refused because of inventory.
7. Writes go through `withInventoryWrite` (modelled on `lib/loyalty-write.ts`:
   `runExclusive`, `retryOnSqliteBusy`, `runTenantTransaction`, idempotency
   keys, `afterCommit`). Every `IN (...)` over data-sized lists uses
   `queryInChunks` (100 bound parameters per statement on Durable Objects).

### Auto sold out (phase 3)

Per item, opt-in: **"Mark dishes sold out when this runs out"**. When on hand of
that item at a location reaches zero **and** the item was counted in the last 7
days (so a drifting estimate cannot take dishes off the menu), the region marks
every dish and option that needs it as sold out at that location until a
delivery, count or adjustment brings it back. The Today page lists what was sold
out by stock, and a manager can undo it from there or from the menu as today.

### Flags, permissions, tokens

**Flags** (control plane, default off, only a literal `true` counts, children
need the master), folded by `foldInventoryFeatures` in `@repo/inventory`:

| Flag                   | Turns on                                                                  |
| ---------------------- | ------------------------------------------------------------------------- |
| `inventory.enabled`    | Today, Stock, Counts, Waste, deliveries and suppliers                     |
| `inventory.purchasing` | Levels, suggested orders, sending orders, unpaid tracking                 |
| `inventory.recipes`    | Dish costs in the menu, used by sales, expected vs counted, auto sold out |
| `inventory.prep`       | Prep tab, Station prep panel                                              |
| `inventory.transfers`  | Transfers and central kitchen (phase 5)                                   |

**Permissions** (`action:entity:access`; update implies read; existing custom
roles get none):

| Permission                        | Covers                                                              |
| --------------------------------- | ------------------------------------------------------------------- |
| `read:inventory:any`              | See stock, counts, waste, deliveries (quantities)                   |
| `update:inventory:any`            | Items, storage areas, counting, waste, recording deliveries, prep   |
| `read:inventory_cost:any`         | Every money figure: costs, values, food cost, waste cost, approvals |
| `update:inventory_purchasing:any` | Suppliers, prices, orders, mark paid                                |
| `update:inventory_recipe:any`     | Recipes, typed costs, auto sold out settings                        |

Approving a count needs `update:inventory:any` and `read:inventory_cost:any`.
Money fields are left out of responses (not hidden in the UI) without the cost
grant. Role presets (editable custom roles, as staffing does): **Kitchen team**
(read and update inventory, no cost), **Kitchen manager** (all five). Built-in
admin gets all five.

**Token:** `inv+jwt`, audience `tenant-api-inventory-operator`, minted at
`GET /<orgSlug>/inventory-token?scope=read|write`, 15 minutes, claims `grants`,
`features`, `locationIds`, `impersonated` (impersonation gets read only).
**Station:** device secret plus `Pos-Staff-Session`, per-terminal toggle and
`stationApps` claim; details in [Station apps](#station-apps).

**Kill switch:** `INVENTORY_ENABLED=false` on a node answers 503 on operator and
Station inventory routes. The sale-side queue keeps queuing and settles when it
is back, so no sale is lost.

### Packages and files

- `packages/inventory` (`@repo/inventory`, no I/O): units and conversion, cost
  math (weighted average, plate cost, food cost %), recipe expansion (variants,
  options that add or replace, halves, made items, cycle detection), suggested
  order and prep math, count difference rules, flags, permissions, token
  contract, Zod schemas for every route, error codes. Money helpers re-exported
  from `@repo/discounts` `money.ts`.
- tenant-api: `lib/inventory-{auth,guard,write,context,switches,alarm}.ts`,
  `routes/operator-inventory.ts`, `routes/pos-inventory.ts` (phase 2),
  `services/item-sales.ts`, `services/inventory-*.ts`, hook calls at the loyalty
  call sites, `POST /api/inventory/tick` in the hourly jobs-cron fan-out, and
  `registerOrgTickModule('inventory')` for the Durable Object alarm.
- App:
  `utils/inventory/{access.server,token.server,nav,setup-progress,format,inventory-guards.test}.ts`,
  `routes/_app+/$orgSlug_+/inventory-token.ts`, `inventory+/*`,
  `components/inventory/*`, menu editor sections, `resources+/inventory.*`
  (context, availability, notify), sidebar, icon, breadcrumbs
  (`SEGMENT_LABELS`), `.po` catalogs.
- Control plane: one migration (`00NN_inventory`: permission rows, admin grants,
  system flag rows; next free number after the in-flight sync, `0040` at the
  time of writing — recheck), `setup-roles.ts`, `ORG_PERMISSIONS`,
  `TENANT_ROLE_PERMISSION_IDS`, `tenant-role-access-manager.tsx`.
- Station: `src/apps/stock/` (phase 2: count, waste, delivery; Dexie v7 stores,
  till outbox, fixtures), `lib/config.ts` (`StationApp` gains `'stock'`),
  `screens/AppLauncher.tsx`, `pos-orders.ts` `PosDeviceApps` gains `inventory`,
  App Terminals page toggle; Kitchen app waste button (phase 2), waste prompt
  (phase 3) and prep view (phase 4); `docs/pos.md` Station apps section.
- Docs: `docs/inventory.md` (operator guide and runbook), ADR 049, an AGENTS.md
  section, `docs/scheduled-jobs.md#inventory-tick`.

### UI building blocks

| Need                  | Use                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Page shell            | `WorkspacePage`, `PageHeader`, `WorkspaceTabBar` via `InventoryChrome`                   |
| KPIs                  | `WorkspaceMetricGrid` + `WorkspaceMetric` (tone `warning`/`danger` for alerts)           |
| Sections              | `WorkspacePanel`; settings cards `WorkspaceSurface` + `SaveBar`                          |
| Lists                 | `Frame` + `Table variant="card"`; mobile `ItemGroup`/`Item`; `FilterSelect`; search      |
| Detail and quick edit | `Sheet` child routes (`SheetPanel`, `SheetForm` from `components/staff/sheet-frame.tsx`) |
| Full editors          | `MenuFormHeader` sticky bar + `lg:grid-cols-12` form and summary aside                   |
| Pickers               | `Popover` + `Command` (catalog-picker pattern)                                           |
| Choices               | `ToggleGroup` (units, reasons), `ChoiceCard` for setup questions                         |
| Status                | `Badge` `warning` / `destructive` / `success` / `secondary`                              |
| Charts                | `@repo/ui/chart` (Recharts): bars and a price line, nothing exotic                       |
| Empty states          | `EmptyState` with separate "nothing yet" and "no matches" copy                           |
| Forms                 | Conform + Zod 4 (`@conform-to/zod/v4`), posting to the region in `onSubmit`              |
| New, shared           | `QuantityStepper` (`@repo/ui`), undo toast helper, `formatQuantity` (Intl units)         |

Lingui: newer-module style (`Trans`, `Plural`, `useLingui` from
`@lingui/react/macro`, label maps of `msg` descriptors). Run
`npm run lingui:extract -w app` (and `-w station` from phase 2), fill `ar.po`,
check with `node scripts/check-lingui.mjs`. Check every screen in Arabic with
`?lng=ar`: numbers and units in `<bdi dir="ltr">`, sheets open from the start
side, steppers keep − on the left of the number in both directions.

### Notifications and jobs

- Kinds: `inventory_low_stock` (daily digest at the location's morning, count of
  items), `inventory_count_review` (a count is waiting for approval),
  `inventory_delivery_due`, `inventory_price_rise`, `inventory_sold_out` (phase
  3). In-app always, email by preference, through the existing notification
  pipeline and bell.
- Hourly tick (shared jobs-cron trigger; the free plan's five crons are taken):
  retry the sales outbox, send due digests and reminders, check order cut-offs.
  Idempotent; one org with `{orgId}` or all within a 50-second budget; reports
  counts only.

### Reports

Phase 3 adds report subjects to `packages/reports`: stock movements, waste,
deliveries, and food cost by period, so owners can build their own views and
dashboards. No inventory reports page of its own.

### Tests and gates

- `@repo/inventory`: unit and property tests for unit conversion round trips,
  weighted average, food cost math, recipe expansion (sizes, options adding and
  replacing, halves, made items, cycles refused), suggested order rounding.
- tenant-api: `inventory-security.test.ts` (every operator and Station route:
  forged, wrong audience, grantless, cost-less responses, cross-organization,
  excluded location, impersonated, kill switch), depletion convergence (replay,
  revise, void, cancel, recipe change after the sale), `queryInChunks` above 100
  ids, append-only triggers, migrations test.
- App: `inventory-guards.test.ts` (every loader and action awaits
  `requireInventoryAccess` first), component tests for the count page's offline
  queue and the waste dialog, a Playwright spec for setup → count → delivery →
  food cost (on a developer machine, ask before running E2E).
- Station (phase 2): contract fixtures, Dexie queue unit tests, and an e2e spec
  like `station-apps.spec.ts` (see [Station apps](#station-apps)).

## Phases

Each phase is one PR (one migration per plane each), shippable behind its flag,
and useful on its own.

| Phase | Name                      | Ships                                                                                                                                                                                                                            | Owner gets                                                            |
| ----- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0     | Foundations               | `@repo/inventory`, flags, permissions, token, regional schema, `item-sales.ts` (web + QR + Station), ADR 049, chrome and empty tabs behind the flag                                                                              | Nothing visible                                                       |
| 1     | Know what you have        | Stock, item sheet, starter lists and paste import, storage areas, counts (phone-first, review, approve), waste dialog and tab, deliveries and suppliers, Today v1                                                                | Stock value, low items, waste cost, usage, food cost % after 2 counts |
| 2     | Order the right amount    | Levels, suggested orders, send by email/WhatsApp/PDF, receive against an order, ask for credit, price rise alerts, unpaid deliveries, invoice photo; Station Stock app (offline count, waste, delivery) and Kitchen waste button | Ordering in minutes, price surprises caught, counting without Wi-Fi   |
| 3     | Know what each dish costs | Recipes on items, sizes and options; typed cost; made-in-house recipes; used by sales; expected vs counted in review; auto sold out; till void signals; Kitchen "log it as waste?"; report subjects                              | Plate cost, live stock, missing stock in money                        |
| 4     | Plan the day              | Prep list and board, Kitchen prep view, history-based demand nudge, Ramadan-aware weekday patterns                                                                                                                               | Less over-prep                                                        |
| 5     | More than one kitchen     | Transfers, central kitchen production and branch requests, location comparison, reading invoice photos (in-region model only for KSA)                                                                                            | Chains and commissaries                                               |

Phase 4's Ramadan handling is plain: when the organization's region is KSA (or
the owner turns it on), demand patterns compare Ramadan days with the previous
Ramadan's same weekdays (Hijri calendar via `Intl.DateTimeFormat` with
`islamic-umalqura`), not with last month.

## What we took from Mise, and what we left

| Took                                                          | Left                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| Today: four numbers, "needs attention" with one link each     | AI covers forecast as the front door                   |
| Log waste dialog: recent chips, reason chips, logged as, undo | Photo-estimated waste amounts                          |
| Count review as a short review queue with "41 need no review" | Hex and waffle charts                                  |
| Prep board with To do, In progress, Done, filtered by station | Photos on every row (dish photos only, from the menu)  |
| Completion summary after a count or delivery                  | "What Mise noticed" as generated prose (ours is rules) |

And from the rejected prototype: its coverage (counts, invoices, prices, levels,
recipes, waste, prep, transfers) is right; its shape is not. It had 17
sub-pages; this plan has five tabs. Its words (AvT, par, stock-aware menu) are
replaced by the glossary; its two-language item names are gone; its rows of
eight numbers become a name, a number and a status.

## Open decisions

Recommendations first; none blocks phase 0.

1. **Tab name "Purchasing".** Alternative: "Suppliers". Recommend Purchasing.
2. **Kitchen team sees costs?** Recommend no by default (cost is its own grant).
3. **Invoice photo reading.** Recommend phase 5, US first through `@repo/ai`;
   KSA only with an in-region model (the tenant-api OpenAI-compatible client),
   and always with a "check these lines" step. _Phase 2 decision: photos are
   stored and shown only; no reading, nothing in the contract._
4. **Invoice photo storage.** Recommend in-region object storage (generalise
   `lib/recording-storage.ts`) rather than US App storage. _Phase 2 decision:
   yes, presigned `PUT` from the browser to the region's own bucket (see
   [Phase 2 wire contract](#phase-2-wire-contract))._
5. **Auto sold out default.** Recommend off per item, opt-in. _Phase 3; no phase
   2 contract._
6. **Unpaid deliveries in phase 2.** Recommend yes, mark paid only, no payments.
   _Phase 2 decision: yes. `POST /deliveries/:id/paid` and the supplier unpaid
   totals already exist; `paid: true` on a new delivery needs the purchasing
   grant, and `confirm-prices` may mark paid in the same step._

## Risks

- **Recipe wall.** Mitigated by value without recipes, "top 10 by sales first",
  typed costs, and never showing expected vs counted for items whose dishes lack
  recipes.
- **Wrong stock takes dishes off the menu.** Auto sold out is opt-in, needs a
  count in the last 7 days, and is listed on Today with undo.
- **Double counting Station revisions.** Settling is desired-state diffing per
  source, tested with replays and revisions.
- **Counting without signal in the App.** Per-row save state plus a
  `localStorage` queue in phase 1; the offline Station Stock app in phase 2.
- **Unit mistakes.** Named units are immutable once used; conversions are only
  within mass or volume; pieces carry an optional average weight.
- **Durable Object limits.** Chunked `IN` lists, ledger reads by item and
  location with indexes, daily on-hand snapshots only if reads get slow.
- **Scope creep toward an ERP.** Anything that needs a sixth tab, an approval
  chain or an accounting concept waits for phase 5 or a separate decision.

## Sources

Competitors and reviews:
[MarketMan on Capterra](https://www.capterra.com/reviews/136439/Marketman-Restaurant-Inventory),
[MarketMan on G2](https://www.g2.com/products/marketman/reviews),
[MarginEdge, how it works](https://www.marginedge.com/how-it-works),
[Restaurant365 review](https://www.techrepublic.com/es/article/restaurant365-review/),
[xtraCHEF on Capterra](https://capterra.com/p/165935/xtraCHEF/),
[Toast IQ Inventory FAQ](https://support.toasttab.com/en/article/Toast-IQ-Inventory-FAQ),
[Square recipes beta](https://squareup.com/help/us/en/article/8629-beta-track-ingredient-costs-with-square-recipes),
[Lightspeed and KitchenCut](https://www.lightspeedhq.com/uk/integrations/kitchencut/),
[Craftable on Capterra](https://www.capterra.com/p/200434/Craftable/reviews/),
[Apicbase on G2](https://www.g2.com/products/apicbase/reviews),
[meez pricing](https://www.capterra.com/p/246573/meez/pricing/),
[Supy invoice receiving](https://supy.io/product-features/invoice-receiving),
[Foodics features](https://www.foodics.com/rms-features),
[Foodics cost guide](https://help.foodics.com/hc/en-us/articles/17585701041692-Cost-Guide-in-Foodics-Console),
[Foodics count changelog](https://changelog.foodics.com/inventory-count-gN5io),
[Supy on recipe setup as the blocker](https://supy.io/blog/learn-recipe-setup-onboarding-blocker).

Practice and benchmarks:
[count frequency survey (BackBar)](https://academy.getbackbar.com/how-often-should-you-take-inventory-at-your-restaurant-or-bar),
[counting routines (Restaurant Dive)](https://www.restaurantdive.com/news/jim-lange-proper-inventory-counting-routines-reduce-erros/833140/),
[unit conversions (R365)](https://docs.restaurant365.com/docs/unit-of-measure-conversions),
[unit conversion and yield (Supy)](https://supy.io/blog/learn-restaurant-inventory-unit-conversion),
[catch weight](https://www.cleverence.com/inventory/guides/catch-weight/),
[costing methods (Toast)](https://pos.toasttab.com/blog/on-the-line/restaurant-inventory-costing-methods),
[actual vs theoretical (meez)](https://getmeez.com/blog/actual-vs-theoretical-food-costs),
[foodservice waste (ReFED)](https://docs.refed.org/methodologies/food_waste_monitor/foodservice.html),
[waste tracking ROI (Leanpath)](https://blog.leanpath.com/restaurant-foodwaste-initiatives-see-7-to-1-roi),
[offline counting (R365)](https://docs.restaurant365.com/docs/mobile-inventory-counts-overview),
[ZATCA input VAT (Wafeq)](https://www.wafeq.com/en-sa/tax-and-reporting/fatoora-portal-direct-integration-protecting-your-b2b-invoices-from-rejections-and-input-vat-loss),
[Ramadan demand in Saudi Arabia](https://gulfnews.com/world/gulf/saudi/ramadan-2025-surge-in-demand-for-culinary-items-in-saudi-arabia-2-1.500060724),
[Mise prep list](https://mise-dusky.vercel.app/blog/why-your-prep-list-is-costing-you-money).
Reddit could not be read by the research tools; owner voice comes from review
sites and vendor help centres. Most time-saved and ROI figures are vendor claims
and are used only as ranges.
