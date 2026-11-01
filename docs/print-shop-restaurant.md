# Print shop: restaurant vertical

The restaurant print vertical (see
[print-shop-verticals.md](./print-shop-verticals.md)) adds:

- **Products:** table QR cards (shippable) and table tents (folded, print it
  yourself), listed first.
- **QR targets:** a table set (`table`, one card per QR ordering table,
  `['all']` means every live table at proof and approval time), the order-ahead
  menu of a location (`menu`), and table booking (`reservations`).
- **Products:** also a **coupon card** (A6 or 4 × 6 in; free PDF, or shipped
  once Admin maps a vendor SKU per size).
- **Coupon target:** a discount or coupon from Marketing, Discounts (`coupon`,
  `{discountId, codeId}`); see "Coupons" below.
- **Scopes:** the organization's active locations (footer address, menu prices,
  ship-to prefill).
- **Featured items:** dishes of the location's live menus (no drops), with
  location prices and menu photos.

Files: `packages/common/src/print-shop-restaurant.ts`,
`apps/app/app/utils/print/restaurant/` (`vertical.server.ts`,
`qr-tables.server.ts`) and `apps/app/app/components/print/restaurant/`.

## Table codes

Table cards carry each table's code (see [qr-ordering.md](./qr-ordering.md)). A
table code lets anyone order at that table, so the table target needs QR dine-in
on for the organization and the menu edit permission (the right that mints table
codes on the QR tables page), for the proof, the download and the order, whoever
approved the card. The App server fetches codes from the region with a
short-lived `qr:write` token that never reaches the browser. **New QR code** on
a table invalidates its printed cards; renew codes only after shipped cards
arrive.

A table card with no tables yet links to **Settings, QR tables**
(`/settings/qr-tables`), where tables are added.

## Coupons

A coupon print (the **coupon card**, or a poster or flyer with the **Discount or
coupon** QR target) hands out an offer from Discounts. Start one from **Print
coupons** on a discount's page
(`print/new?product=coupon_card&start=coupon:<id>`), or pick the discount in the
editor; a new coupon card starts on the most recently changed offer.

**What the customer gets.** The code as a "Code SAVE10" badge, the offer and its
terms, and a QR to `/menu?coupon=SAVE10` (plus `location=` when the offer works
at one location, and the usual `utm_*` tags). Sites keeps a plausible code like
a typed one (`adoptCouponFromUrl`) and says so on the menu ("Code SAVE10 is
saved…"); the cart and checkout price it, and the region decides and counts
every guess against the code rate limits. An automatic offer prints no code: its
QR opens the menu, where the offer shows.

**Words.** Empty fields print words written from the discount in each print
language (`coupon-copy.ts`): the headline is the value ("10% off", "$5 off",
"Free delivery"; a deal, ladder or set price uses the discount's name), the
message lists every term that could turn a customer away (dates, first order
only, signed in, rewards members, one per customer, pickup, delivery or dine-in
only, the one location, online only, minimum order), and the call to action says
the code is added for them. The owner can replace any of it. Codes are never
redeemable at the till (a code discount is never a till rule), so a code card
always says "Online orders only" and never sends anyone to the counter.

**Which offers.** Active discounts a printed QR can use: online (`web` channel),
not manual, a code discount with at least one code, and not ended (an end counts
once it has passed in every time zone). The editor says how many active
discounts it left out. An offer that later stops qualifying (paused, archived,
ended, moved off the web, code removed) resolves to nothing: approval is refused
and an approved print is stale. Any save of the discount bumps its version, so
an approved print also goes stale when the offer changes: reprint after editing.

**Access.** Needs `discounts.enabled` and `read:discount:any` for the proof, the
download and the order, whoever approved the print (a code is a way to a
discount). **Print coupons** also needs the Print shop and the campaign edit
permission.

**Shipping.** Coupon cards ship once Admin maps a vendor SKU per size (A6, 4 × 6
in).

**Results.** Give printed cards a code of their own (the editor suggests it):
the discount's page counts uses per code. Printing a code does not limit it: use
the discount's limits, schedule and end date.
