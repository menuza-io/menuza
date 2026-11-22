# Manager alerts (#106, #366, #131, #265, #241, #300, #190)

One page for seven features that tell the right people, at the right moment,
that something needs them: operator push on the Menuza phone app, quiet hours
and snooze, stuck orders, the Orders page chime, chosen people by email or text,
large orders and offline Station tablets. Every one of them extends something
that already existed: the `Notification` table and its notify routes, the
Notifications settings card, the regional orders tick, the home Needs attention
feed, Terminals and the heartbeat of #356. There is no second alert engine, no
second quiet-hours system and no second feed.

Nothing in an alert, a push, a banner, a desktop notification, an email or a
text may contain a guest's name, phone, email, address, notes or items. An alert
is a kind, a location, an order number, a count, a time and a total.

## Flags, kill switches and defaults

| Name                               | Where                     | What it does                                                                             |
| ---------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| Flag `notifications.operator_push` | organization, default off | Push to the operator phone app.                                                          |
| Flag `orders.manager_alerts`       | organization, default off | The order and tablet alerts, the large-order flag and the Station heartbeat watch.       |
| `OPERATOR_PUSH_ENABLED`            | App                       | Every operator push.                                                                     |
| `ORDERS_ALERTS_ENABLED`            | App and tenant-api        | Every order and tablet alert; tenant-api stops posting and marks queued rows `dropped`.  |
| `ORDERS_EMAIL_ENABLED`             | App                       | The email of those alerts (the bell is unaffected).                                      |
| `ORDER_ALERT_SMS_ENABLED`          | App and tenant-api (US)   | Texts to the people a location chose.                                                    |
| `ORDER_ALERT_HASH_SECRET`          | App and tenant-api (US)   | Secret (32+ chars, not `INTERNAL_COMMAND_TOKEN`) that keys the phone hash and code hash. |

A kill switch **drops**: nothing is queued, so switching it back on sends no
backlog. Alerts held by quiet hours are the one thing that waits, and they are
dropped at release time if a switch is off by then.

Defaults: new-order and large-order push is on for owners and managers (members
holding `update:settings:any`) and off for other members. A new order reaches
the bell but does not email every manager (every other kind emails by default).
Payment needs review and "every kitchen tablet is offline while an order waits"
are critical: always on, never held by quiet hours or snooze.

## One notification engine (#106)

- `Notification` rows stay the in-app alert. The staffing, reservations,
  inventory and team chat paths call `pushStoredNotifications` where they write
  a row, so push **mirrors** the table (`utils/alerts/push.server.ts`). The new
  order and tablet alerts go through `deliverOrderAlert`
  (`utils/alerts/order-alerts.server.ts`), the same `Notification` upsert with
  the same notify-route pattern as inventory (`resources+/orders.notify.ts`).
- Push categories (`@repo/common/operator-alerts`): new orders, orders waiting,
  ordering paused, payment needs review, large orders, a kitchen tablet offline,
  staff, inventory, reservations, team chat mentions. The member's choice is
  `NotificationPreference.push` (null means the role default). The order kinds
  keep email, in-app and push on their own row; the older categories get a
  `push.<category>` row.
- Devices: control-plane `OperatorPushDevice` (unique Expo token, one row per
  phone, moved when someone else signs in on it). It is **not** the guest
  customer-app token table (`customer_push_devices`, regional, #105): guest and
  operator tokens never mix. `OperatorPushDelivery` is the claim, unique per
  notification and device, so a retry sends nothing twice. The provider is
  behind `OperatorPushProvider` (Expo, and `MockOperatorPushProvider` for
  `MOCKS=true` and tests).
- API for the phone (the mobile operator JWT):
  `GET/POST/DELETE /api/push/devices`, `GET/PUT /api/push/preferences`. The web
  uses `/api/notifications/alerts`.
- Dead tokens: a token the provider refuses is deleted at once; the hourly
  receipts sweep (`POST /resources/jobs/operator-alerts`) reads the receipts and
  deletes the rest.
- Removing a member, signing out (the phone deletes its token first) or losing
  the permission stops pushes: the recipient lookup and the push both re-check
  membership at send time.
- Mobile: `expo-notifications` (a native rebuild; Android needs FCM credentials
  in EAS). Settings, Notifications and Settings, Your phones. A tap opens the
  App address in the push, only when it is on the App's own origin.

## Quiet hours, snooze, thresholds and the log (#366)

- `utils/alerts/policy.server.ts` is the only decision: `decideDelivery` in
  `@repo/common/operator-alerts` (critical, then threshold, then snooze, then
  quiet hours). Person settings live on the member's `alerts.settings` row of
  `NotificationPreference` (quiet hours with their time zone, `snoozedUntil`); a
  threshold lives on its kind's row.
- A snoozed or held alert keeps its in-app row. A held one is sent when quiet
  hours end, unless it was already seen, the member left, a switch is off, or
  they changed their hours again (`held.server.ts`). jobs-cron wakes the App at
  that moment with `OperatorAlertsWorkflow` (`sleepUntil`) and the hourly sweep
  is the backstop; there is no sixth cron slot.
- Thresholds ("tell me after 3 in an hour") apply to new orders and waiting
  orders. The preview is `previewAlertCount` over the last seven days of the
  log, so it changes as the threshold changes.
- `AlertLog` (90 days): what fired, to whom, the outcome (`delivered`,
  `critical`, `snoozed`, `held`, `below_threshold`, `dropped`) and the channels.
  Members see their own rows, members with `update:settings:any` see everyone's.
  Ids and numbers only.

## Stuck orders, payment review and long pauses (#131)

- The regional orders tick (`services/order-alerts.ts`, run by
  `runOrdersTickForOrg`: hourly cron, Durable Object alarm, Node interval)
  finds: an ASAP order still New (`accepted` or `pending_acceptance`, standing,
  not a table round) after the location's `orderAlertMinutes` (default 10,
  counted from payment for an online order); orders that cross the line within
  five minutes of the first go in one alert; a scheduled order due in 15 minutes
  and still New; a payment in review. Each posts ids and order numbers to
  `POST /resources/orders/notify`. One alert per order per kind: the
  `order_alerts` row is the claim, written before the post and taken back only
  if the App could not be reached.
- Pause over two hours and busy mode over three hours are computed by the App
  sweep (`alertLongOrderingControls`), once per pause (`busyStartedAt` is new).
- No alert outside the location's opening hours plus an hour (the region reads
  the open intervals from `GET /resources/orders/alert-settings`; the App checks
  them again).
- Recipients are active members holding `read:menu:any` whose location scope
  covers the location, with the kind on.

## Orders page (#265)

`useNewOrderAlerts` works off the list the page already loads every 15 seconds:
a new online order chimes (every 30 seconds until it is opened or accepted),
shows a banner, counts in the tab title and, with permission and the tab in the
background, shows a desktop notification. A scheduled order is told softly once
and loudly at its time. The bell sets sound, volume, one of three sounds and
Test, remembered per browser (`localStorage`); the first visit shows a one-line
prompt; a browser that blocks sound says so. The sound system is
`@repo/common/order-chime`, shared with Station's kitchen chime. Orders waiting
for acceptance keep the "Waiting for you" lane's chime (one sound, not two).
There is no test-order feature in the product yet (#119): the alert text helpers
accept `test` and prefix TEST so it will show up marked.

## People chosen by a location (#241) and large orders (#300)

- Location settings, Order alerts: up to five recipients per location, an email
  address or a mobile number, not necessarily a member, each confirmed with a
  one-time code (10 minutes, 5 tries, 3 sends an hour), switches for online and
  scheduled orders, removal at once (the row is deleted; the next alert asks the
  database). Control plane `OrderAlertRecipient`: staff contact details, never a
  guest's. There is no catering-request event in the product, so there is no
  catering switch yet.
- The code check takes each try with one atomic
  `UPDATE ... WHERE verify_attempts < 5` before comparing, so parallel guesses
  cannot beat the limit. Sending a code is also throttled where deleting the
  recipient cannot reset it: per destination (3 an hour and 10 a day across
  every organization, keyed by the number's hash or the email address's) and per
  organization (30 a day), in the App's database; the US tenant-api adds
  per-isolate caps per destination and per organization as a backstop.
- Phone hashes and code hashes use `ORDER_ALERT_HASH_SECRET`, not
  `INTERNAL_COMMAND_TOKEN`: rotating the command token never breaks STOP, and a
  holder of the command token cannot compute the hashes. The hash carries a
  version (`alert-phone:v1`); a rotation adds a version beside it.
- The region posts `order_placed` (number, type, wanted time, total, dish count,
  large flag) after the order's own transaction; the App emails or texts the
  confirmed recipients and tells subscribed members. An unaccepted order
  triggers one reminder to location recipients (the waiting alert), once per
  order.
- Texts: the App has no SMS credentials; the only route is the US tenant-api
  (`POST /api/alert-texts`, internal token, US and Canadian mobile numbers, ends
  with `Reply STOP to opt out.`). Saudi organizations get email only until #78.
  STOP and START replies arrive at the inbound webhook, which forwards only an
  HMAC of the sender to `POST /resources/orders/alert-keyword`; the recipient
  with that hash is stopped or brought back.
- Large orders: the location's own threshold (dishes or amount), defaulting to
  the existing large-order rule, is carried to the region in the order context
  (`largeOrderAlert`) and stamps `restaurant_orders.large_order` at placement. A
  large order is told once as a large order (a member with large alerts off gets
  the ordinary new-order alert instead), badged in the Orders list and on the
  kitchen ticket (Station), and a scheduled one is told again a set time before
  it starts (`large_order_soon`).

## Station tablets (#190)

- The heartbeat route of #356 (`POST /pos/heartbeat`) now also counts the tablet
  as seen at once and keeps its battery and version
  (`pos_devices.battery_percent`, `app_version`, `last_heartbeat_at`) while the
  organization has manager alerts on, whether or not connection history is
  collected. Without alerts it behaves as before. A tablet is watched only after
  its first such heartbeat.
- The tick finds tablets silent for five minutes inside opening hours plus half
  an hour (a location with no hours is never called an outage), alerts once per
  outage (`offline_alerted_at` is the outage's start) and sends "back online"
  when it checks in again, which also marks the bell alert read. Removed
  tablets, tablets named "spare" and tablets that never connected never alert.
- Every kitchen tablet of a location offline while an online order waits is
  critical: told at once (the order's own post-commit path checks), and every
  five minutes until the order is started.
- Terminals shows Online, Offline since a time or Never connected, with battery
  and version. The home Needs attention feed shows offline tablets in opening
  hours (`station_offline`, urgent, not dismissible).

## Tests

- `packages/common/src/operator-alerts.test.ts`, `operator-alert-copy.test.ts`,
  `order-chime.test.ts`: kinds, strict events, policy, preview, copy without
  PII.
- App: `resources+/orders.notify.test.ts`, `utils/alerts/operator-push.test.ts`,
  `settings+/locations_.$locationId.order-alerts.test.ts`, the Orders hook and
  tracker tests, Terminals and the attention feed.
- tenant-api: `routes/order-alerts.test.ts`, `routes/alert-texts.test.ts`,
  `lib/alert-keyword.test.ts`. jobs-cron: `operator-alerts-workflow.test.ts`.
  Mobile: `lib/push/__tests__`, `lib/api/__tests__/push.test.ts`.

## Deploy order

App (control-plane migration `0073_operator_alerts`, routes, preferences, Orders
page, recipient settings), then jobs-cron (the workflow and the sweep), then
tenant-api (tenant migration `0061_manager_alerts`, ticks, heartbeat, order
events, text route), then Station (the kitchen badge), then the operator phone
app. The flags default off, so nothing changes until an organization is switched
on.
