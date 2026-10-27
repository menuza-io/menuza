# Print shop: restaurant vertical

The restaurant print vertical (see
[print-shop-verticals.md](./print-shop-verticals.md)) adds:

- **Products:** table QR cards (shippable) and table tents (folded, print it
  yourself), listed first.
- **QR targets:** a table set (`table`, one card per QR ordering table,
  `['all']` means every live table at proof and approval time), the order-ahead
  menu of a location (`menu`), and table booking (`reservations`).
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
