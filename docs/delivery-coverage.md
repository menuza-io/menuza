# Delivery coverage (address check, quotes, scheduling)

How a customer's delivery address is checked against a location's delivery
zones, and how that check is carried into the order.

## Flow

1. **Search** — the order-details sheet on Sites calls the regional tenant-api
   `GET /delivery/places?slug|host&locationId&q&sessionToken&lng` (debounced,
   one session token per search). The tenant-api calls Google Places
   Autocomplete (biased to the store, restricted to the store's country) and
   returns `{ predictions: [{ placeId, mainText, secondaryText }] }`. Queries
   shorter than 3 characters return an empty list.
2. **Quote** — picking a prediction (or submitting free text) calls
   `POST /delivery/quote` with
   `{ slug|host, locationId, placeId | address, unit?, sessionToken?, locale? }`.
   The tenant-api fetches fresh order context from the App, geocodes the address
   (Place Details or Geocoding API), and evaluates the zones. It always answers
   `200` with one of:
   - `deliverable` —
     `quote: { token, expiresAt, address, zoneId, zoneName, deliveryFee, minimumOrder, eta: { min, max }, pricing, distance }`
     (money in major units). `deliveryFee` is the fee for the optional
     `subtotal` the browser sent (the zone's minimum order when it sent none);
     `pricing` (`{ baseFee, steps, byDistance }`) is what Sites needs to price
     the cart as it changes (see "Fees"); `distance` is
     `{ meters, source: 'driving' | 'straight_line' }` when the store has
     coordinates.
   - `out_of_range` — with the normalized `address` (also used for points in a
     disallowed zone) and `reason` (`out_of_range` or `excluded`, with
     `excludedBy`, the name of the Not allowed zone)
   - `not_found` — the address could not be geocoded
   - `unavailable` — `reason`: `delivery_disabled`, `geocoding_unavailable`,
     `store_location_missing`, or `no_zones`
3. **Order** — checkout sends `delivery.quoteToken` (plus optional `notes` /
   `unit`) and `scheduledFor` to `POST /orders`. The tenant-api verifies the
   token and **re-resolves the zone from the signed coordinates against the
   fresh order context**, so the fee and minimum always reflect the current
   zones. The stored address comes from the signed payload, not client text. An
   invalid or expired token is `422 delivery_quote_expired`.

`POST /orders` may also send `expectedDeliveryFeeMinor`, the delivery fee the
page showed (before a free-delivery discount). The node prices the fee itself
and answers `409 delivery_fee_changed` (with `details.deliveryFeeMinor`) when it
differs, so the guest is told before paying. It is checked only when sent, so a
Sites build that predates fee tables keeps placing orders.

Orders without a token still work for zip-code zones: the postal code is read
from the free-text address using the location's country (Saudi 5-digit
postcodes, Arabic-Indic digits accepted; Canadian A1A 1A1; US ZIP / ZIP+4).

## Data residency

The customer address goes **browser → regional tenant-api → Google** and nowhere
else. Sites SSR never sees it, the App never sees it, and the tenant-api does
not store it until an order is placed (then it lives in the regional
`restaurant_orders` row like any other delivery address). The quote token
travels back to the same browser; it is signed, not encrypted, and only contains
the address the customer just typed.

Google Maps Platform is a third-party processor for both regions. If a region
must not send addresses to Google, leave `GOOGLE_MAPS_API_KEY` unset on that
node: quotes then answer `unavailable/geocoding_unavailable` and
`GET /orders/options` reports `delivery.available: false` unless the location
has zip-code zones.

## Quote token

`dq1.<base64url(payload)>.<base64url(HMAC-SHA256)>`, signed with a key derived
from `AUTH_HMAC_SECRET` and the purpose label `delivery-quote:v1` (Web Crypto,
works on Workers and Node). Payload: `orgId`, `locationId`, `lat`, `lng`,
`formatted`, `line1`, `city`, `state`, `postalCode`, `country`, `unit`,
`drivingMeters` (the road distance, when routing answered; optional), `exp`.
Tokens expire after 2 hours and are bound to one org + location. Code:
`apps/tenant-api/src/lib/delivery-quote-token.ts`.

## How zones are evaluated

`resolveZoneForPoint` in `@repo/geo` (wrapped by `resolveDeliveryZoneForPoint`
in `@repo/common/restaurant-orders`):

- Only `enabled` zones count. Allowed zones must be `in_house`; `disallowed`
  zones of any provider are **exclusions** — a point inside one is excluded even
  if an allowed zone covers it.
- `radius` — great-circle distance from the store's `address.lat/lng`. A missing
  or `0,0` store coordinate makes radius zones unverifiable
  (`store_location_missing` when nothing else matched).
- `polygon` — point-in-polygon (≥3 vertices).
- `zip_code` — the geocoded postal code (normalized; ZIP+4 matches its ZIP).
- Several matches → `deliveryConfig.zonePriority` decides (see "Zone order").

`GET /orders/options` reports `delivery.available: true` only when some enabled,
allowed, in-house zone can actually be checked: zip-code zones always; radius
zones need a geocoder and real store coordinates; polygon zones need a geocoder.

## Zone order (#266)

Zones overlap in real life (a free ring inside a wider paid one). The location's
`deliveryConfig.zonePriority` says which wins:

- `cheapest` (missing means this, so a location nobody reordered is unchanged):
  the lowest fee, then the lowest minimum.
- `order`: the first zone in the location's list that covers the address.

The list is an ordered, draggable list on the location's delivery settings;
dragging a zone switches the location to `order`, and "Use the cheapest zone
instead" switches back. Not allowed zones exclude an address whatever their
place, and disabled zones are skipped, in both modes. Zip-code zones without a
geocoded point follow the same order (`resolveDeliveryCoverage`). The quote and
the order placement call the same resolver, so they always agree. Each zone
shows an overlap note computed for radius and polygon zones (`zoneOverlaps` in
`@repo/geo`, sampled geometry; zip-code zones overlap only by sharing a code).
Copying delivery settings between locations never carries the zone order (the
target keeps its own).

The **Address check** box on the same screen runs the guest quote's own coverage
code from the operator's browser: `POST /operator/orders/delivery-check` on the
regional tenant-api with the orders token (read scope, the member's location
limit). It signs nothing, stores nothing, logs nothing, and answers with the
zone that applies (fee, minimum, and the fee at an order amount if one is typed)
or the reason delivery is unavailable. It checks the zones as last saved.

## Fees: distance, order size and the order they apply in (#244, #421)

A zone has one `deliveryFee`, and optionally a **fee by order size**
(`feeSteps`: from this subtotal, charge this fee) and a **fee by distance**
(`distanceFees`: `mode` `straight_line` or `driving`, `unit`, and `bands`: from
this distance, charge this fee). One shared module, `deliveryFeeCentsFor` in
`@repo/common/delivery-fees`, prices a delivery for tenant-api, Sites, the phone
agent and the customer app. The order, always the same:

1. **Which zone** (above): Not allowed zones exclude, disabled ones are skipped,
   `zonePriority` picks among the matches.
2. **Distance**: with bands, the road distance (the routing adapter, when the
   zone says `driving` and the store has coordinates) else the straight-line
   distance. The band the distance falls in sets the fee (a band starts at its
   `from`, so exactly 5 km is in the 5 km band); the zone's single fee is the
   fallback when the distance cannot be measured. Routing never fails an order:
   an error or no route means the straight-line distance prices it, and nothing
   about the result (an address, a coordinate, a distance) is logged.
3. **Order size**: with a table, the step the subtotal has reached sets the fee.
   With bands too, the table can only lower the distance fee (the lower of the
   two), so a big order is never charged more than its distance.
4. A `free_delivery` discount still wins (the discount engine takes this fee as
   its input).

The **subtotal** is the items subtotal before discounts, tax, tip and fees: the
same base the zone's minimum order is checked against. (The discount engine runs
after pricing and needs the delivery fee as an input, so pricing the fee on the
discounted subtotal would be circular.) Steps need different thresholds and the
first starts at the zone's minimum order; bands need different distances and the
first starts at zero (the App refuses a save otherwise, and the server checks
the same rules). The distance is signed into the quote token (`drivingMeters`),
so placement does not call the routing service again; a changed table or mode
between quote and placement is caught by `expectedDeliveryFeeMinor`.

Sites keeps the quote's `pricing` with the verified address, prices the cart
with `deliveryFeeFromPricing`, and says how far the next cheaper step is ("Add
6.00 more for free delivery") in the cart drawer and at checkout.

## Which store serves an address (#161)

With more than one location, Sites asks `POST /delivery/locations` (same
per-client and per-organization limits as quotes) once the guest enters an
address. The node reads the order context once for every location (the first
25), geocodes the address **once**, and answers a signed quote per store that
delivers there, ranked: delivers, then the lowest fee (at the cart's subtotal),
then the shortest estimate, then the nearest (the brand's list order breaks a
tie). Only stores open for ordering now, or closed but taking scheduled orders,
are offered; a paused store is never offered (pause and busy mode are per
location). With no deliverable store the sheet says "No store delivers here yet"
and offers pickup. `purpose: 'pickup'` returns the open stores by distance from
an address or from the browser's location (`point`, sent only on the guest's
tap, never stored or logged) for "Nearest to you".

## Scheduling

`scheduledFor` (ISO-8601; `null`/absent = ASAP) is validated against the
location's `scheduling` (`scheduledOrdersEnabled`, `advanceOrderDays`), its
online hours / special hours in the location timezone, and must be at least
`prepTime` minutes away (5-minute grace for time spent in checkout). Scheduled
orders can be placed while the store is closed. Failures are
`422 schedule_unavailable`; drops use pickup windows and reject `scheduledFor`.
Stored in `restaurant_orders.scheduled_for` and returned on receipts.

## Store coordinates

Radius zones need real store coordinates. The App geocodes the store address on
location create/save when lat/lng are missing or `0,0`
(`apps/app/app/utils/location/geocoder.server.ts`). For existing rows:

```bash
npm run locations:backfill-coordinates -w app                 # local D1
GOOGLE_MAPS_API_KEY=… npm run locations:backfill-coordinates -w app -- --remote
```

## Configuration

`GOOGLE_MAPS_API_KEY` (optional, sensitive) on each regional tenant-api and on
the App. Enable **Places API (New)** and **Geocoding API**; restrict the key to
those APIs and to the servers' egress IPs. Without a key, development and tests
use deterministic fixtures (`createDevGeocoder` in `@repo/geo`: around the
seeded Chicago store, plus Evanston / Milwaukee / New York / Riyadh / Jeddah);
production without a key has no geocoder.

Driving distance (#421) uses the same key through the Google **Routes API**
(`routes.googleapis.com`, `computeRoutes`); enable it on the key. In development
and test a deterministic router (`createDevRouter`, the straight-line distance
times 1.35) stands in, and without a key in production a zone priced by road
distance uses the straight-line distance. Tests inject `setRouterForTesting`.

Rate limits (production): `/delivery/places` 60/min and `/delivery/quote` and
`/delivery/locations` 20/min per IP, plus hourly per-org caps (3000 searches,
600 quotes or store searches).
