# Print shop

**Marketing, Print shop** turns the organization's branding into print-ready
posters, flyers and window stickers. Every approved print downloads as a free
PDF; posters and flyers can also be printed and shipped (US addresses in v1),
with the platform as the merchant.

The core knows no business type. A print vertical adds products (cards, tents),
QR codes of its own, featured items and the business's places: see
[print-shop-verticals.md](./print-shop-verticals.md).

## Turning it on

| Flag / variable                          | Effect                                            |
| ---------------------------------------- | ------------------------------------------------- |
| `print_shop.enabled` (org flag)          | Designs and free PDF downloads                    |
| `print_shop.shipping` (org flag)         | Paid shipped orders (needs the master flag)       |
| `PRINT_SHIPPING_ENABLED=false` (App env) | Pauses new paid orders everywhere (vendor outage) |

`PRINT_SHIPPING_ENABLED` keeps shipping on only when it is unset or an explicit
on-value (`true`, `1`, `on`, `yes`, `enabled`); any other value pauses it, so a
typo fails closed.

Permissions: the marketing (campaign) permissions read and edit designs; paying
for shipped prints also needs the settings (billing) permission.

## Designing

1. **New print:** pick the product, size and one of three styles (Classic, Bold,
   Minimal).
2. **Editor:** words per language (one or two of the organization's site
   languages; empty fields use the suggested words), the QR target (a page on
   the organization's own site, never an external URL; no QR code; or a
   vertical's own target), up to four featured items when the vertical has an
   item source, the address of one of its places, and the website.
3. **Proof:** the live proof shows the cut line and bleed. **Approve proof**
   freezes a snapshot (copy, prices, piece labels and code versions, images);
   downloads and orders print that snapshot until the next approval.
4. The page warns when items or codes changed since approval. A print whose
   per-piece codes or labels changed cannot be ordered until it is approved
   again.

A vertical's QR codes can be capabilities (a code that lets someone in to
something). The vertical then says who may see them, and that check guards the
proof, the download and the order, whoever approved the print. Such codes are
checked again when the price is made and when payment starts; a code renewed
after that (an order held for days) is not caught.

QR codes encode the destination directly with
`utm_source=print&utm_medium=qr&utm_campaign=<design id>`: there is no redirect
service, so a printed code keeps working as long as the page exists.

## Downloads (free)

- **Print at home:** Letter or A4 sheets, cards tiled with crop marks and no
  bleed; posters and flyers scaled to the sheet.
- **For a print shop:** one piece per page at trim size plus 3 mm bleed.

PDFs are rendered by Cloudflare Browser Rendering (REST `/pdf`, headless
Chrome), so Arabic, RTL and web fonts match the proof. Output is RGB. If a
render fails for a reason other than the account (a font host that is down makes
it time out), it is rendered once more without web fonts. Files are cached in
the platform bucket per organization by a hash of their inputs; the same input
is never rendered twice for an organization. Each organization may render
`PRINT_RENDER_LIMIT_PER_HOUR` new files per hour for downloads (default 30): the
render reserves its slot in one statement with the limit check, so concurrent
requests cannot render past it, and a failed render gives the slot back. Renders
for paid orders do not count. Without `PRINT_BROWSER_ACCOUNT_ID` and
`PRINT_BROWSER_API_TOKEN` (local dev) the download opens a print-ready page and
the browser's print dialog saves it.

## Shipped prints

- **Price:** the vendor's live wholesale price times the Admin markup, plus
  shipping at cost, plus sales tax from Stripe Tax on the ship-to address. The
  price is held for the quote window (default 30 minutes).
- **Payment:** a one-off Stripe Checkout on the organization's Stripe customer
  (created on the first order and reused by subscriptions). The order goes to
  the vendor only after Stripe confirms payment.
- **Vendors:** each product and size prints at one vendor (Gelato or Prodigi),
  set in Admin. A cart with products at both vendors becomes one vendor order
  each, with its own tracking. Each piece is sent as its own PDF with the
  vendor's bleed through a signed URL.
- **Drift hold:** a paid order is re-quoted before submission. If the wholesale
  price rose by more than the Admin drift limit (default 10%), the order is held
  for Admin instead of being sold at a loss.
- **Cancel:** operators can cancel until the vendor starts production (full
  refund). A cart split across vendors is cancelled only if no vendor has
  started; if production starts mid-cancel, the order is held (`partial_cancel`)
  for Admin to refund what was cancelled. A vendor refusal or a vendor-side
  cancellation refunds in full automatically. A payment that lands after a
  cancel is refunded automatically (`late_payment`). Defects after delivery go
  through Admin (reprint by vendor claim, or refund). An order held while the
  vendor may already have it (`vendor_unknown`, `stale_claim`,
  `submission_error`) cannot be cancelled by the operator (`needs_support`):
  Admin checks the vendor first.
- **Crash safety:** the hourly `print-sync` job submits paid orders that were
  never sent (after 5 minutes) and holds orders stuck sending or cancelling for
  15 minutes (`stale_claim`), since a vendor call may have gone through. A
  timeout or an error once the order was sent holds it as `vendor_unknown`. For
  these (and `submission_error`) Admin's **Retry** and refunds show the vendor
  references and ask to search the vendor first; **Found it at the vendor**
  records the vendor's order id instead of sending again (the id is checked at
  the vendor first, and only for these holds). Prodigi also gets an idempotency
  key. A cancel that fails after another vendor was cancelled holds the order as
  `partial_cancel`; a refund that fails after vendors were cancelled holds it as
  `refund_failed`. Held refund cases (`refund_failed`, `partial_cancel`) can
  only be refunded. Paid orders are not counted against the hourly render limit.
- **Vendor errors:** only 400 and 422 count as the vendor refusing the order
  (automatic refund). A 409 on create can mean the order already exists (a
  retry), so it holds as `vendor_unknown`; Gelato's 409 on cancel means too
  late. A key, account or endpoint problem (401, 403, 404) and every 5xx or 429
  hold the order for Admin. Looking a Gelato order up by our reference is not
  wired yet: Admin searches the dashboard.
- **Tracking:** vendor webhooks
  (`/resources/print/webhook/<vendor>?token=PRINT_WEBHOOK_TOKEN`) only trigger a
  status fetch from the vendor's API (bodies are capped at 64 KB as read, ids at
  200 characters); the hourly `print-sync` job in `apps/jobs-cron` is the safety
  net. It checks orders not yet shipped first (oldest check first) and follows
  shipped ones for 30 days. Operators get an email and an in-app notification
  when an order is paid, shipped, or refunded.

## Admin

**Admin, Print shop:** pricing rules (markup, drift limit, quote window), the
vendor catalog (product and size to vendor SKU and bleed; changing the vendor is
how held orders are rerouted), and the last 100 orders with margin, **Retry**,
**Accept new price** and three refunds:

- **Refund in full** cancels vendor orders not yet printing first; if a vendor
  already started, it refunds nothing and says so.
- **Refund, vendor keeps printing** (in production, shipped, delivered or held
  orders): a defect claim or a lost parcel, the platform still pays the vendor.
- **Refund part** (held `partial_cancel` orders only, enforced by the App): the
  amount that was cancelled; the rest keeps printing and is tracked again,
  unless a vendor order is still waiting to be sent (then it stays held).

Only paid orders can be refunded. Held, sending and cancelling orders are always
listed, however old, on top of the last 100 orders; there is no alert yet, so
check the list. Refunds and retries run in the App through
`/resources/print/admin-command` (internal token), so Stripe and vendor keys
live in one app.

## Environment

App: `PRINT_BROWSER_ACCOUNT_ID`, `PRINT_BROWSER_API_TOKEN`,
`PRINT_RENDER_LIMIT_PER_HOUR`, `PRINT_SHIPPING_ENABLED`, `GELATO_API_KEY`,
`PRODIGI_API_KEY`, `PRODIGI_SANDBOX`, `PRINT_WEBHOOK_TOKEN` (32+ characters),
`PRINT_MOCK` (local only: a stateless vendor emulator, ignored unless `BASE_URL`
is a local host). Admin: `APP_URL`. Stripe webhook events as for the rest of the
App (`checkout.session.*`).

## Rotating the webhook token

Gelato and Prodigi call a URL, so `PRINT_WEBHOOK_TOKEN` sits in the query string
and can show in access logs and vendor dashboards. A missing or short token
(under 32 characters) refuses every vendor event, and the App logs that once. To
rotate it:

1. Set the new `PRINT_WEBHOOK_TOKEN` on the App.
2. Update the webhook URL in each vendor's dashboard to the new token.
3. Events sent with the old token in between are refused. The hourly
   `print-sync` job picks up status changes of the orders it follows (submitted,
   in production, and shipped in the last 30 days); an event for an order
   shipped longer ago is not recovered.

## Launch checklist (business)

- Confirm each vendor's terms allow resale with the platform as merchant of
  record.
- Register for sales tax where the platform has nexus and enable Stripe Tax.
- Map SKUs in Admin and place a sandbox order per product (Prodigi sandbox,
  Gelato draft orders); check colour on a real print (RGB files).
- Shipping outside the US (KSA via Gelato's UAE production) is a later step:
  quote a Riyadh address first.
