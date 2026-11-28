# Guest ordering conveniences and launch confidence

Saved delivery addresses (#113), favorite dishes (#158), free test orders
(#119), guest order problem reports (#191) and group orders (#170). Everything a
guest writes here (addresses, favorites, first names, problem notes and photos)
is guest data: it lives in the **regional** tenant database
(`packages/tenant-db`, migration `0077_guest_ordering`) and is reached
browser-direct. Sites SSR and the App see ids, counts and booleans only (see
`docs/tenant-data-residency.md`).

One control-plane migration (`0086_guest_ordering`, three `ConfigFlag` rows) and
one tenant migration (`0077`), both widening only. `POS_CONTRACT_VERSION` stays
13 and `INVENTORY_POS_CONTRACT_VERSION` 2. No new environment variable.

| Feature                    | Flag (default off, only a literal `true`) | Where it is read                                                                 |
| -------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| Saved addresses, favorites | none (a signed-in guest's own data)       | customer token                                                                   |
| Free test orders           | `launch.test_order`                       | order context `guestOrdering.testOrders`                                         |
| Order problem reports      | `ordering.problem_reports`                | order context `guestOrdering.problemReports`                                     |
| Group orders               | `ordering.group`                          | order context `guestOrdering.group`, public menu `features.group` (Sites button) |

The App folds the three flags into `GET /resources/order-context`
(`guestOrdering`); a missing or malformed value reads as off.

**Deploy order:** tenant-api, then the App (with the control-plane migration),
then Sites and the customer app, then Station (kitchen labels).

## Saved addresses and favorites (#113, #158)

- Tables `customer_addresses` (at most 10 per guest) and `customer_favorites`
  (at most 100). `GET/POST/PATCH/DELETE /customer/addresses*`,
  `/customer/favorites*`, customer token only; another customer's id is the
  uniform 404.
- A saved address is never trusted: `POST /delivery/quote` and
  `/delivery/locations` take `addressId`, re-check the address against the
  delivery area every time and return a fresh signed quote token.
- Person erasure deletes both tables (`person-erasure-pii-columns.test.ts`).
- Sites: addresses and favorites pages, checkout picker, hearts and the "Your
  favorites" rail. The customer app has the same lists.

## Free test orders (#119)

- The Place a test order button (Orders page, Launch checklist) asks the region
  to mint a one-time code (`POST /operator/orders/test-code`, `orders:write`, 10
  per location per day). The App returns the website menu URL with the code in
  the **fragment**; Sites moves it to `sessionStorage` and sends it as
  `X-Test-Order`.
- The nonce is spent in the order's own transaction (a refusal commits, an
  insert failure gives the code back): a second order with the same code is 422
  `test_code_invalid`.
- A test order (`restaurant_orders.is_test`, final by trigger) is inert: never
  charged, no loyalty, inventory, discount, referral, guest text or sales
  figure. The central predicates (`countedOrderCondition`,
  `orderCountsTowardSales`) exclude it, so every report skips it. Inbox, Station
  Orders, the Kitchen and tickets say TEST.
- Station asks "Did the ticket print?" (`POST /operator/orders/:id/test-print`,
  `/pos/...`); a yes, or a person moving the order through the kitchen, ticks
  the launch step. An open test order completes itself after 2 hours (orders
  tick).

## Order problem reports (#191)

- Guest: `GET/POST /orders/:id/problems` and
  `POST /orders/:id/problems/:problemId/photo` with the receipt token or the
  order link (every refusal of a capability is the uniform order 404). The
  forwardable **order link is read-only and redacted**: it reads the reports
  without the note, the words of the thread or the credit code, and cannot
  report or attach a photo (403 `receipt_required`); only the placing browser's
  receipt token writes. Kinds: missing item, wrong item, late, quality, other.
  One open report per order (a second adds to it, at most ten additions),
  accepted for 48 hours after completion, five per order, `Idempotency-Key`
  required, durable limits per order and per address. Bodies are capped by the
  bytes that arrive, not by `Content-Length`.
- The photo is checked by its bytes (not the announced type), re-encoded (drops
  EXIF and GPS), capped at 5 MB and stored in the region's bucket under
  `order-problems/<orgId>/`. Deprovision deletes the prefix; person erasure
  empties the note, the photo and every thread body (the thread is append-only;
  triggers allow only that).
- Operator: `GET /operator/orders/problems[?status=&orderId=]`,
  `GET /operator/orders/problems/:id` (short-lived photo link),
  `POST /operator/orders/problems/:id/answer` (`orders:write`):
  - **refund** the affected items (or an amount): an online payment books a
    provider refund intent (normal refund rules and limits, #80; needs the
    `refundProvider` grant), a payment at handoff is a recorded refund. The
    report is **claimed first** (compare-and-set `open` to `answered`), so a
    refund and a credit can never both land; a refused booking gives the claim
    back, a claim that never booked (a crash) can be taken over after two
    minutes (the refund key is the report's, so it never refunds twice), and a
    provider refund that later fails opens the report again;
  - **credit**: a single-use `discount_issued_codes` row (source
    `order_problem`), resolved at checkout by `resolveProblemCreditForOrder`
    (one synthetic fixed-amount discount worth the credit, `maxUses` 1, same
    currency, expiry). A credit is a cash-equivalent code: it needs the refund
    grant (403 `credit_forbidden`, never while impersonating) and cannot exceed
    the order total (422 `credit_too_large`);
  - **reply** and **close** (the App asks before closing).
- The guest sees the thread, refund and credit code on the order page and gets
  the answer by email (and a text only with "Text me order updates", US node,
  within the daily order text cap). Sending is best effort and never throws. The
  refund message says a refund was **started** (a provider refund is pending
  when it is sent), and the Problems report counts only what the refund row has
  settled.
- Managers: a generic `order_problem` event (kind word and order number only)
  through `/resources/orders/notify` (alert kind `orders_problem`, shares the
  "orders waiting" push switch); the orders tick retries an alert the App could
  not take and sends the 24-hour reminder once. Unanswered reports appear in
  Needs attention (`/operator/orders/attention` carries `problems`).
- Erasure also deletes the cloud printer ticket jobs (`print_jobs`) of the
  erased orders: their payload carries the first name, the address and "For Sam"
  labels.
- Reports: subjects `order_problems` (by type, status, location, refunded and
  credited totals, minutes to answer) and `order_problem_dishes`, in the sales
  family. They hold ids, kinds and amounts, never a note.
- The receipt email says where to report (`guest_messages.problemReports`,
  stored at placement). The post-visit feedback request (#133) does not exist in
  this repository yet; `orderHasOpenProblem` is the one function it will call to
  skip an order with an open report.
- App: Orders, Problems (`/orders/problems`) and a panel on each order.

## Group orders (#170)

- Tables `group_carts`, `group_cart_people`, `group_cart_lines`; the order keeps
  `restaurant_orders.group_id` and each stored line may carry `forName`.
- Capabilities, in headers and URL fragments only: the link's **share token**
  (`gs1.` plus an HMAC of the group and its share version; bumping the version
  burns links, which the host does with "Make a new link" in the host panel,
  `POST /orders/group/:id/share/rotate`) lets a friend look and join; a person's
  own token (`gp1.`, 256 random bits, only its hash stored) changes their own
  dishes; the host's places the order. Every refusal is the uniform 404
  `group_not_found`. Sent as `X-Group-Token`.
- `/orders/group/*` (mounted before `/orders`): create (customer token), view
  (polled every 5 seconds), join (first name), add and remove a dish (priced by
  the order engine with the walk-in gates), done, host PATCH (deadline 15
  minutes to 7 days, limits, lock), leave (friends), end (host, deletes).
  Limits: 25 people, 100 dishes, 5 open groups per host, per-person and total
  spend limits (`group_limit_reached`).
- Checkout is the normal `POST /orders` with `groupId`, `groupVersion` and the
  host's token. The region prices the **group's own lines** (the body's `lines`
  only anchor what the host saw): a stale version is 409 `group_changed`, dishes
  that left the menu are listed (409 `group_items_unavailable`), and the group
  is claimed by compare-and-set inside the order's transaction (a lost race
  throws, so nothing is half placed). A retry answers with the order already
  placed.
- Rate limits count the address first (429 before anything about the group is
  touched), count the per-group budget only for a request that holds a valid
  capability (a made-up group id writes no counter row), and give a refused
  request back. Polls reuse the priced lines per group version.
- The Kitchen display, cloud tickets, Station Orders, the guest receipt page,
  the receipt email and the App order detail show each person's dishes under
  "For Sam". The forwardable order link leaves names out. Person erasure deletes
  a host's groups and scrubs `forName` from their orders.
- A group with no activity for seven days is deleted by the orders tick.
- Sites: `/menu/group` (start, join, view, host panel); the host's checkout
  copies the group into its own cart key (`menuza_cart_<org>_group`), leaves a
  note in `sessionStorage` (good for 30 minutes, cleared on any `group_*`
  refusal and whenever the group page opens) and uses the normal checkout page.
  The group view redraws only when the group's version changes and keeps focus.
- `#test=` and `#join=` capabilities are moved out of the address bar by an
  inline script in the layout, before any analytics tag loads, into
  `sessionStorage` (`menuza_pending_test`, `menuza_pending_join`); the menu and
  group scripts adopt them from there, and the address is cleaned even when
  storage is blocked.

## Security gates

`apps/tenant-api/src/routes/{customer-addresses,customer-favorites, orders-test-orders,order-problems,group-orders}.test.ts`
(tokens, other customer's or order's ids, windows, limits, erasure),
`services/person-erasure.test.ts`, `workers/org-router.*.test.ts` (routing by
Origin and identity only) and `lib/bound-parameters.test.ts`.
