# Own-driver deliveries (#287, #324)

A restaurant that delivers with its own staff can dispatch from Orders, give
each driver a run on the Station tablet or phone, and read driver reports. It is
behind the organization flag `delivery.in_house` (default **off**, only a
literal `true`). Third-party couriers and automatic dispatch are out of scope.

## Where things live

- **Region only.** Runs, stops, cash, problems, driver availability, notices and
  the live position live in the regional tenant DB (tenant-db `0070`):
  `delivery_runs`, `delivery_run_stops`, `delivery_run_positions`,
  `delivery_driver_status`, `delivery_driver_notices`, and
  `staff_positions.delivers_orders`. The control plane keeps the flag only (no
  migration). A guest name, phone or address never reaches the US control plane.
- **Drivers are staff.** A driver is an active staff member with an open job in
  a position marked **Delivers orders** (Staff, Jobs). No second driver table,
  no second login: Station's device secret plus the staff PIN session
  (`Pos-Staff-Session`) authenticate every driver call.
- **One order timeline.** Picking a run up writes `out_for_delivery` and handing
  over writes `delivered` through `applyOrderStatusPatchInTx`
  (`restaurant_order_steps` stays append-only). A run adds no status of its own
  to the order.

## Runs

- A run is one driver and one to 12 stops (`MAX_STOPS_PER_RUN`), at one
  location. Only a delivery order that is ready, not in another open run and not
  cancelled can be added (a partial unique index on the active stop keeps one
  open stop per order).
- Dispatch: Orders (App) → Deliveries panel, or Station's Deliveries app.
  `POST /operator/deliveries/runs` and `POST /pos/deliveries/runs` create a run;
  a driver can also claim ready orders for themselves (`/pos/deliveries/claim`).
  Reassigning moves the run and leaves a notice for both drivers. The board
  lists ready orders, runs in progress and each driver's availability. A manager
  can mark a driver unavailable; a driver can mark themselves.
- Pickup sets every stop of the run to on the road and queues the guest
  messages. Deliver and Problem are per stop. A problem (`not_home`,
  `wrong_address`, `refused`, `cannot_reach`, `other`) or Release puts the order
  back on the board.
- The run closes itself when no stop is waiting or on the road. When it closes,
  or the driver is changed, the **live position is deleted** and the driver's
  view is empty again: addresses disappear from the device after a run.

## Cash

Each stop carries the cash due on delivery (`cashDueFor`, orders paid at handoff
in cash). The driver confirms the amount collected. Collected cash is summed per
driver on the Station shift report (`deliveryCash`, App `pos-day-report`) and
per delivery in the reports.

## Guest messages

`out_for_delivery` and the new `delivered` kind use the existing order message
outbox and its switches (`ordering.guest_messages`, `ORDERS_EMAIL_ENABLED`,
`ORDERS_SMS_ENABLED`). Email everywhere; text only on the US node with the
guest's opt-in. Copy exists in all six Sites languages.

## Driver view

Station's **Deliveries** app (`apps/station/src/apps/deliveries`, launcher icon
`route`) shows the signed-in driver their run: stops in order, the address, a
map link (`mapUrlForAddress`), the order's items count, cash to collect, and
Call.

- **Call** is masked. The driver's device never receives the guest's number: the
  region reads both numbers and rings the driver, then the guest
  (`apps/tenant-api/src/lib/masked-call.ts`). Twilio, US node only; elsewhere
  the button is hidden. Nothing about the numbers is returned or logged. Dev and
  tests use a bridge that connects nothing.
- **Share my position** is opt-in per run (`POST /pos/deliveries/run/location`).
  Only the latest point is kept, against the run, and it is deleted when the run
  ends or the driver stops sharing (`DELETE /pos/deliveries/run/location`).
  Coordinates are never logged.
- **Notices** ("A run was assigned", "A run was taken away", "A stop was
  released") are read once per device and marked read.

The Deliveries app has no per-terminal switch: it appears when the region says
`apps.deliveries` (the flag on, plus a signed-in staff member).

## Reports (#324)

Two report subjects in `packages/reports/src/catalog-deliveries.ts`, loaded in
the region (`services/delivery-report-records.ts`, `routes/analytics.ts`):

- `deliveries`: one record per delivery: minutes ready to picked up, picked up
  to delivered, placed to delivered, against the promised time
  (`promisedUntil ?? promisedAt`), late, cash, tip, problem.
- `driver_deliveries`: one row per driver for the period; each row opens that
  driver's deliveries (`rowRefField: 'driverKey'`).

Both appear in a reports token only while `delivery.in_house` is on and only for
members who may read orders. Records hold a **zone**, minutes and money, never a
guest name, phone or address. The `driver` name is staff data: without the staff
grant (`SALES_STAFF_FIELD_PERMISSION`) it reads "Driver 1", "Driver 2" and the
totals stay. Templates (category Deliveries): `deliveries-by-driver`,
`driver-deliveries-list`, and delivery time, promised time and late deliveries
by hour and by zone.

## Deploy order

App (flag read, tokens, panel), then tenant-api (`0070` migration), then
Station, then Sites. An older region without the routes answers 404 and the
panel shows "not available yet".

## Tests

`apps/tenant-api/src/routes/pos-deliveries.test.ts`,
`operator-deliveries.test.ts`, `analytics.deliveries.test.ts`,
`apps/station/src/apps/deliveries/*.test.ts`,
`packages/reports/src/catalog-deliveries.test.ts`.
