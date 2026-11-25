# Sales and service insight

Category sales and product mix (#227), slow sellers (#261), dish profitability
(#519), the order step timeline (#243), sales missed while paused (#176) and
online uptime (#405). Everything extends something that already existed: the
report engine and catalog (`packages/reports`), the one items-sold walk
(`apps/tenant-api/src/services/item-sales.ts`), plate cost
(`packages/inventory`), the order status changes (`order-service.ts`, the
kitchen screen) and the ordering pause controls (`applyOrderingControl`).

## Data and migrations

| Where                                          | What                                                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant `0068_sales_insights`                   | `restaurant_order_steps` (append-only, triggers) and `pos_orders.line_catalog` (JSON, menu and category per dish at upload).                                                       |
| Control plane `0077_ordering_pause_history`    | `LocationOrderingPause`: the ONE pause history, shared by the missed sales estimate and the uptime report. Kinds `pause` (staff) and `closure` (hours taken away at short notice). |
| `restaurant_orders.lines` (JSON, no migration) | Web and QR lines carry `categoryId`, `categoryName`, `menuId`, `menuName` as the menu named them at placement.                                                                     |

`POS_CONTRACT_VERSION` stays **11**. The till sends only the item id, and the
region already reads the live menu for every upload, so it stamps the menu and
category itself (`buildItemPlacementIndex`, `lineCatalogFor` in
`@repo/common/item-placement`). A sale whose menu could not be reached, or that
was rung up before this shipped, reads **Earlier sales**.

Deploy order: control-plane `0077` and App (so pause history starts building),
tenant-api with `0068` (before Station), then the App UI, then Station.

## Category sales and product mix (#227)

- Subjects `product_mix` (one row per dish line) and `product_mix_options` (one
  per chosen option) load through `readSaleLines`, a second visitor of the
  items-sold walk (`item-sales.ts`): same channels, same "counts toward sales"
  rule, same net per line as the items-sold figures, so totals agree.
- The engine gained the **share** measure (`measure: 'share'`): each group's sum
  over the total of all groups in the same currency, so a currency's groups add
  up to 100. The sum rides on the segment as `amount`.
- `GET /analytics/product-mix` returns finest-grain rows; the browser folds them
  into the levels switched on (`packages/reports/src/product-mix.ts`): menu,
  category, dish, option group, option. The total is the dishes' sales whatever
  is shown, option sales are an "of which" of their dish, and money is one block
  per currency. CSV export per level or one file.
- A dish in two categories counts under the first one it sits in, in menu order
  (the order does not say which one the guest browsed).

## Slow sellers (#261)

`slow_sellers` lists menu dishes from the fewest sold. The roster of dishes
comes from the control plane by id (`GET /resources/report/menu-roster`,
internal token, menu data only), joined in the region with sales and sold-out
history (`loadSoldOutOccurrences`). Dishes with no sales come first; a dish
added in the period is **New** and listed after the ranked ones; a dish that was
sold out or hidden part of the period is ranked on its sales per available day
and sold-out days are left out of "days since last sold". Location and channel
narrow the sales a dish is ranked on (`ReportSubject.loaderFilterFields` and
`splitLoaderFilters` hand them to the loader). Food cost is shown only to a
member holding the inventory cost permission with recipes on.

The home has no top dishes block (#81 shipped the Today block), so there is no
"Least sold" toggle to add; the Slow sellers template is available as a report
block from Add block.

## Dish profitability (#519)

`POST /operator/inventory/recipes/profitability` (cost grant, recipes flag) and
the page Inventory, Today, Dish profitability. It reuses `recipeCostRows` (the
menu list's plate cost) and `engineerMenu`
(`packages/inventory/src/profitability.ts`): within each menu category a dish is
**popular** at 70% of an even split of the category's units and **earns well**
at or above the category's average margin per dish. Popular and earns well:
Keep; popular, earns little: Re-price; not popular, earns well: Promote;
neither: Rethink. Dishes with no recipe, typed cost, or only a partial cost are
listed apart. The menu list sorts by food cost %, margin per dish and margin
over 30 days (`FoodCostSortControl`).

## Order steps (#243)

`restaurant_order_steps`: order id, step, event (`done`/`undone`), when, who (an
opaque member, `staff:<id>` or `device:<id>`, never a name) and which screen,
and `offline`. Written in the same transaction as the status change:
`placeOrder` (placed, and an automatic accept), `applyOrderStatusPatchInTx`
(accepted, declined, started, ready, handed over, delivered; a delivery order's
ready also records out for delivery), the kitchen stage write
(`syncKitchenSteps`, which takes back a kitchen step with an `undone` row when a
dish is sent back and records it again later, keeping both). No second status
writer exists. A Station command may carry `clientAt`; a believable queued time
is recorded and marked offline (`resolveStepTime`). The order detail's Activity
list shows the steps and who did them (names are joined in the App from its own
members). Subject `order_timings` measures minutes to accept (people only), to
start, to ready and late against promised.

## Missed sales while paused (#176) and uptime (#405)

One history table. `applyOrderingControl` opens a row on pause, closes it on
resume, and closes a replaced one; a pause that ran out by itself is closed at
its own planned end on the next read (`closeExpiredPauses`). Busy mode writes
nothing. A pause running when the history began gets its row on the next read.

- **Estimate.** The App plans windows (`planMissedWindows`): the pause cut to
  the scheduled online hours, and the same window one to four weeks earlier; a
  week that was paused, closed or outside the hours is left out. The region sums
  web and QR sales that count toward sales in those windows
  (`POST /analytics/missed-estimate`, only windows in, only totals out) and
  averages them; fewer than two usable weeks gives **Not enough history yet**.
  Decision on the open question: **4 weeks**. Shown on the Orders pause card, as
  the Missed while paused line of Today (one amount per currency, apart from
  real sales) and as the weekly template. It is labelled an estimate everywhere
  and never added to sales.
- **Uptime.** `GET /analytics/online-uptime`: of the scheduled online hours,
  minutes paused by staff, dishes unavailable (every orderable dish out at once)
  and closed unexpectedly (an hours edit that took scheduled time away in the
  next 36 hours, kept as a `closure` row). Each moment counts once, in that
  order. Overnight closed hours are not scheduled time. Locations are compared,
  lowest uptime first.
