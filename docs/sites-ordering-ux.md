# Sites ordering UX: menu and drops

Design and implementation spec for the customer-facing ordering surfaces in
`apps/sites`: the menu page, the drops listing, the drop detail page, and the
checkout/success pages they share.

Read `apps/sites/DESIGN.md` and `apps/sites/PRODUCT.md` first. This document
adds the product decisions and the component architecture; it does not change
the data-residency rules (no PII in Sites SSR, tokens in `localStorage`).

## 1. Goals

- A menu page a real restaurant would put its name on: clean, dense, scannable,
  fast, and faithful to the organization's published theme.
- A drops experience that is clearer than Hotplate's about the three things a
  customer actually asks: _when can I order_, _when and where do I pick up_, and
  _how many can I get_.
- Every ordering constraint the operator configures is visible and enforced in
  the browser: order window, pickup windows per location, pickup time slots,
  order lead time, item and category inventory, per-order limits.
- One ordering engine (cart, item customization, drawer) shared by the menu and
  drops so behaviour, accessibility and translations never diverge.

## 2. What the competitors do, and where we go further

**Owner.com** (menu): segmented Pickup/Delivery control, location picker with
"opens Thu 11 AM", a "Most ordered" row, categories as headings with list rows
(name, description, price with a `+` suffix for "from" pricing, thumbnail on the
right), deep-linkable items (`?item=`), sticky "Start order".

**Hotplate** (drops): two-column drop page with a sticky info card (cover with
title overlay, "Pickup on Fri, Oct 9", "Baxter Village + 3 more"), sticky
category tabs, image-top item cards, image-first item modal, a cart bar with a
hold countdown, and a 3-step checkout (Info, Time, Pay) where the pickup time is
only chosen after the phone number.

Where we go further:

| Area          | Competitor                                                | Ours                                                                                                                             |
| ------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Pickup time   | Hotplate hides slots until checkout step 2                | Location, date and slot are chosen on the drop page before checkout; unavailable slots (past lead time) are hidden and explained |
| Limits        | Hotplate shows "Only N left" only inside the modal        | Cards show "Only N left", "Limit N per order", and "Sold out"; steppers stop at the cap with the reason inline                   |
| Order window  | Not surfaced while browsing                               | Header shows "Orders close Fri 9:15 AM" with a live countdown under 24h; the page flips state automatically at open/close        |
| Hold timer    | Starts the moment an item is added (anxiety, unexplained) | Starts at checkout, explained in words, with a calm expiry path back to the drop                                                 |
| Reminders     | Hotplate requires SMS sign-up                             | "Add to calendar" (.ics) for the open time and for the pickup slot; no account, no PII to us                                     |
| Menu scanning | Owner has headings and rows                               | Rows plus sticky category navigation with scroll-spy, in-menu search, and a "Popular" row from `isPopular`                       |
| Item modal    | Native `<select>`s / alerts                               | Pill selectors for variations, inline validation that scrolls to the first unmet required group, no `alert()`                    |
| Theming       | Fixed brand                                               | Everything uses the organization's theme roles (no raw palette colors)                                                           |

## 3. Design principles for these pages

1. **Words first.** Every state (open, closed, live, upcoming, ended, sold out,
   limited) is said in text. Color and dots only reinforce.
2. **Semantic roles only.** `bg-background`, `text-foreground`, `bg-primary`,
   `text-muted-foreground`, `border-border`, `text-destructive`. No
   `emerald-500`, `amber-500`, `red-500`, `purple-500`. Urgency is weight and
   wording, not color.
3. **No emoji as UI.** Replace 📍 🥡 🚗 🌱 🔥 with small inline SVG icons or
   plain text labels.
4. **Dense but calm.** Item rows at 15px/14px, 2-line clamps, 96px thumbnails,
   generous section spacing, thin dividers, one shadow level at most.
5. **Nothing hardcoded in English.** All interface strings come from Lingui
   `msg` and are passed to client scripts through a JSON label block.
6. **RTL and narrow screens are first-class.** Use logical properties (`ms-`,
   `me-`, `start-0`, `end-0`), test at 360px.
7. **Keyboard and screen reader.** Modal and drawer trap focus, close on Escape,
   return focus; category nav is a real `<nav>`; status chips carry the text;
   buttons have accessible names; `aria-live` for cart count and totals.

## 4. Information architecture

### 4.1 `/menu`

```
[Site header]
[Menu header]          H1 "Menu" · status "Open until 10:00 PM" / "Closed · opens Thu 11:00 AM"
                       location button (if >1): "Downtown Flagship ▾" → LocationPicker
                       segmented Pickup / Delivery with estimates ("~15 min", "25–45 min")
                       search field "Search the menu"
[Sticky CategoryNav]   horizontal chips (all sizes); on lg+ also a left vertical rail
[Popular]              horizontal scroll of image cards, only if ≥3 items have isPopular
[Drops teaser]         PublicDrops variant="menu" (live + upcoming only, max 3, "All drops →")
[Categories]           H2 + optional description; MenuItemRow list (1 col, 2 cols on xl)
                       Subcategories as H3 groups inside; sub-subcategories as H4 groups.
                       No "Subcategory" badges, no arrows.
[CartTray]             fixed bottom bar, appears when count > 0
[CartDrawer]           slide-over, ltr right / rtl left
[ItemModal]            bottom sheet < sm, centered dialog ≥ sm
```

Closed state: browsing and adding still work; the drawer's checkout button is
disabled with the reason ("We're closed right now. Orders reopen Thu 11:00 AM").

Deep links: opening an item sets `?item=<id>` with `history.replaceState`;
loading the page with `?item=` opens the modal after hydration. Closing removes
the param.

### 4.2 `/drops`

Index of all discoverable drops.

```
H1 "Drops" + one-line explainer ("Limited menus you pre-order for a pickup window.")
Section "Ordering now"   DropCard (live)
Section "Coming up"      DropCard (scheduled) with "Opens Fri 9:00 AM" and "Add to calendar"
Section "Past drops"     compact cards, muted, "Ended Oct 5"
Empty: "No drops right now. Check the menu." → /menu
```

### 4.3 `PublicDrops` (home + menu teaser)

Live and upcoming only, max 3, sorted live first then by open time. Card shows
cover, status chip, title, "Pickup Fri, Oct 9 · 4 locations", one-line
description, CTA "Order now" / "View drop". Footer link "All drops →" when the
org has more than 3 or any past drops.

### 4.4 `/drop/[slug]`

Desktop (lg+): two columns. Left 320px sticky column: DropSummaryCard. Right:
sticky CategoryNav + content. Mobile: summary first, then sticky nav, then
content.

```
Back link "← All drops"
DropSummaryCard
  cover (aspect 4/3), StatusChip
  H1 title, description (3-line clamp + "Read more" toggle)
  Facts list:
    Order window   "Orders close Fri, Oct 9 · 9:15 AM"  (+ countdown "in 3h 12m" when < 24h)
                   upcoming: "Orders open Thu, Oct 8 · 6:00 PM" (+ countdown) + "Add to calendar"
    Pickup         "Fri, Oct 9 · 9:30 AM – 12:00 PM" or "3 dates" when multiple
    Where          "Baxter Village + 3 more" → toggles LocationList (name, address, map link, phone, windows)
  PickupPicker (live only)
    step 1 location chips (hidden when 1)
    step 2 date chips (hidden when 1)
    step 3 time slot chips; disabled + "no longer available" when past lead time
    selected summary line; persisted in sessionStorage per drop
Content
  live: categories with DropItemCard grid (2 / 3 / 4 cols)
  upcoming + showMenuPreview: same grid, cards read-only, header "Preview · ordering opens Fri 6:00 PM"
  upcoming + !showMenuPreview: countdown block only
  ended: "This drop has ended" + other live/upcoming drops + "View menu"
CartTray / CartDrawer / ItemModal (shared)
  drawer header shows pickup summary with "Change" → scrolls to PickupPicker
  checkout disabled until a slot is chosen ("Choose a pickup time to continue")
```

### 4.5 `/menu/checkout` and `/menu/success`

Checkout detects `?drop=<slug>`:

- Loads the drop cart (`menuza_drop_cart_<orgId>_<dropId>`) instead of the menu
  cart; renders the pickup summary (location, date, time) and a "Change" link
  back to the drop; hides the Pickup/Delivery choice (drops are pickup only);
  tax rate comes from the pickup location.
- Shows a hold banner: "Your items are held for N minutes while you check out"
  with a countdown; on expiry, show a calm notice and link back to the drop.
- On place order, stores `menuza_recent_order` with
  `drop: { title, slug, pickup: { locationName, address, date, time } }`.

Success shows pickup details for drop orders and an "Add to calendar" button for
the pickup slot. Menu orders keep the current receipt.

Known gap (unchanged by this work): order placement is client-side only. There
is no backend POST yet; see PRODUCT.md "Open item".

## 5. Constraint rules

| Constraint            | Source                                      | Where enforced                                                                                            | Customer wording                                         |
| --------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Order window          | `drop.ordersOpenAt`, `ordersCloseAt`        | SSR picks state; client timers flip state at the boundary (reload)                                        | "Orders open …", "Orders close …", "This drop has ended" |
| Pickup locations      | `pickupWindows[].location`                  | PickupPicker step 1                                                                                       | "Choose a location"                                      |
| Pickup dates          | `pickupWindows[].date` (location tz)        | PickupPicker step 2                                                                                       | "Choose a day"                                           |
| Pickup slots          | `generatePickupSlots(start, end, interval)` | PickupPicker step 3                                                                                       | "Choose a time"                                          |
| Lead time             | `orderLeadTimeMinutes`                      | slot is disabled when `slotStart − lead ≤ now` in the window's location timezone                          | "No longer available"                                    |
| Slot capacity         | `maxOrdersPerSlot`                          | not enforceable without a backend; not shown                                                              | —                                                        |
| Item inventory        | `inventoryOverrides[item].inventory`        | card tag, modal stepper cap, cart stepper cap; `0` = sold out                                             | "Only 3 left", "Sold out"                                |
| Category inventory    | `inventoryOverrides[category].inventory`    | sums quantities of items in that category; cap applies across them                                        | "Only 5 left in Loaves"                                  |
| Per-order limit       | `maxPerOrder` (item or category)            | stepper cap = min(limit − already in cart, remaining inventory)                                           | "Limit 2 per order"                                      |
| Show inventory        | `drop.showInventoryRemaining`               | when false, hide counts but keep "Sold out" and caps                                                      | —                                                        |
| Location hours (menu) | `isLocationOpenForOrdering`                 | status chip; drawer checkout disabled when closed                                                         | "Closed · opens Thu 11:00 AM"                            |
| Variant availability  | `variants[].availabilityStatus`             | pill disabled with "Sold out"; combination message                                                        | "This combination is sold out"                           |
| Modifier min/max      | `minSelections`, `maxSelections`            | group header "Required · choose 1" / "Optional · up to 3"; checkboxes disable at max; inline error on add | "Choose at least 1 option"                               |

Date and time formatting: always `Intl.DateTimeFormat(locale, { timeZone })`
with the pickup location's timezone. Never `toLocaleDateString()` without a
timezone.

Money: USD and CAD render as `$12.00` using en-US digits in every locale (the
Arabic audit asserts `$18.00` and forbids `US$`/`CA$`). Other currencies use
`Intl.NumberFormat(locale, { style: 'currency', currency })`.

## 6. Component and module inventory

All under `apps/sites/src`.

### Client modules (`lib/ordering/`)

- `types.ts`: `OrderingItem`, `OrderingCategory`, `ModifierGroup`,
  `ModifierOption`, `CartItem`, `CartLine`, `Constraints`, `PickupSelection`,
  `OrderingLabels`.
- `money.ts`: `formatMoney(amount, currency, locale)`.
- `catalog.ts`: `indexCatalog(categories)` → maps by item id and item → category
  ids; `isItemSoldOut`, `itemPriceLabel`, `itemHasChoices`.
- `cart-store.ts`: `createCartStore({ key })` with `load`, `save`, `add`,
  `setQuantity`, `remove`, `clear`, `lines`, `count`, `subtotal`, `subscribe`.
  Keys: `menuza_cart_<orgId>` (menu, unchanged) and
  `menuza_drop_cart_<orgId>_<dropId>` (drops). Mode key `menuza_mode_<orgId>`
  unchanged.
- `constraints.ts`: `remainingFor(itemId, cart, constraints)` →
  `{ max, reason }` combining inventory, category inventory and per-order
  limits.
- `item-modal.ts`:
  `createItemModal({ root, labels, formatMoney, constraints, onAdd })` with
  `open(itemId)`, `close()`. Renders variation pills, modifier groups (single,
  multiple, quantity, pizza halves, nested groups), special instructions (hidden
  when the menu disables them), quantity stepper with cap, inline validation.
  Focus trap, Escape, focus return, `?item=` sync.
- `cart-ui.ts`: `mountCartUi({ store, labels, formatMoney, totals, gate })`
  renders tray + drawer, steppers, totals; `gate()` returns
  `{ allowed, reason }` for the checkout button.
- `pickup.ts`: `buildPickupOptions(windows, now)` → locations → dates → slots
  with `available` flags; `formatWindow`, `formatSlot`; `loadSelection`,
  `saveSelection` (sessionStorage `menuza_drop_pickup_<dropId>`).
- `countdown.ts`: `startCountdown(target, onTick, onDone)`; `formatRemaining`.
- `calendar.ts`:
  `buildIcsDataUrl({ title, start, end, location, description, url })`.
- `scroll-spy.ts`: `mountScrollSpy({ nav, sections })`.

### Astro components (`components/ordering/`)

- `ItemModal.astro`: markup shell. Must keep ids `item-modal-backdrop`,
  `item-modal-dialog`, `modal-item-name`, `modal-add-btn`,
  `modal-special-instructions`; hidden via the `hidden` class.
- `CartTray.astro` + `CartDrawer.astro`: keep ids `cart-tray`, `open-cart-btn`,
  `cart-badge-count`, `cart-tray-total`, `cart-drawer-backdrop`, `cart-drawer`
  (hidden via `translate-x-full`; use `rtl:-translate-x-full` for RTL),
  `close-cart-btn`, `cart-items-container`, `drawer-subtotal`, `drawer-tax`,
  `drawer-delivery-row`, `drawer-delivery-fee`, `drawer-total`,
  `drawer-checkout-btn`.
- `CategoryNav.astro`: `<nav aria-label>` of chips; props
  `items: {id, label}[]`, `rail?: boolean`.
- `MenuItemRow.astro`: `.js-item-card` with `data-item-id`, `data-sold-out`.
- `DropItemCard.astro`: same data attributes plus `data-remaining`.
- `DietaryBadges.astro`, `StatusChip.astro`, `LocationPicker.astro`,
  `LocationList.astro`, `PickupPicker.astro`, `DropSummaryCard.astro`,
  `DropCard.astro`, `OrderingLabels.astro` (emits
  `<script id="ordering-labels" type="application/json">`).

### Pages

- `pages/menu.astro` (rewrite), `pages/drops.astro` (new),
  `pages/drop/[slug].astro` (rewrite), `pages/menu/checkout.astro` and
  `pages/menu/success.astro` (drop mode), `components/PublicDrops.astro`
  (redesign, `variant`, `limit`).

### App API changes (`apps/app/app/routes/resources+/`)

- `sites.drops.ts`: add `ordersOpenAt`, `ordersCloseAt`, `pickupDates`,
  `pickupLocationNames`, `pickupTimezone`; resolve `coverImageKey` through the
  media map like `sites.drop.ts`; keep `status` as the display status. Update
  `sites.drops.test.ts`.
- `sites.drop.ts`: item payload gains `isVegetarian`, `isGlutenFree`,
  `isAlcohol`, `allergens`, `calorieMin`, `calorieMax`, `isPopular`,
  `availabilityStatus`; options gain `priceWhole/Left/Right`, `isDefault`,
  `availabilityStatus`, `nestedModifierGroups` (same shape the menu endpoint
  already serializes; reuse its serializer where practical). Include
  `drop.menu.specialInstructions`.

## 7. Compatibility contract (do not break)

`apps/app/tests/e2e/customer-site-arabic.test.ts` drives `/ar/menu` through
checkout. Keep:

- Element ids and classes listed in section 6.
- Message ids (source strings) that already exist in `src/locales/*.po` and are
  asserted in Arabic: `Menu & Ordering`, `Customize Item`,
  `Special Instructions`, `Quantity`, `Add to Order`, `View Order`,
  `Your Order`, `Subtotal`, `Proceed to Checkout`, `Checkout`, `Back to Menu`,
  `1. Fulfillment Mode`, `2. Contact Information`, `Add a Tip for the Team`,
  `Order Summary`, `Place Order`, `Order Confirmed`,
  `Thank you for your order!`, `Order Number`, `Estimated Time`, `Receipt`,
  `Order More Food`, `Return to Homepage`.
- `#menu-data` JSON with `currency`.
- `#location-select` as a `<select>` (the audit selects an option by value). The
  LocationPicker may wrap it visually but the select must exist and navigate on
  change.
- `#cust-name`, `#cust-phone`, `#cust-email`, `#place-order-btn`, and the
  `/menu/success` redirect.

## 8. Translations

New strings are added with `msg` and extracted with
`npm run lingui:extract -w sites`. Every new msgid gets a translation in `ar`,
`es`, `fr`, `de`, `zh` (no empty `msgstr` for ordering surfaces). Arabic is the
KSA launch locale; review it with care.

## 9. Validation

- `npm run lint -w sites`, `npm run typecheck -w sites`, `npm run test -w sites`
- `npm run test -w app -- sites.drops` for the API change
- Visual pass at 360, 768, 1280 in light and dark, `en` and `ar`, for `/menu`,
  `/drops`, `/drop/[slug]` in upcoming/live/ended, checkout and success.
