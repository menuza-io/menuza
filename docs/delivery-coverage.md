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
     `quote: { token, expiresAt, address, zoneId, zoneName, deliveryFee, minimumOrder, eta: { min, max } }`
     (money in major units)
   - `out_of_range` — with the normalized `address` (also used for points in a
     disallowed zone)
   - `not_found` — the address could not be geocoded
   - `unavailable` — `reason`: `delivery_disabled`, `geocoding_unavailable`,
     `store_location_missing`, or `no_zones`
3. **Order** — checkout sends `delivery.quoteToken` (plus optional `notes` /
   `unit`) and `scheduledFor` to `POST /orders`. The tenant-api verifies the
   token and **re-resolves the zone from the signed coordinates against the
   fresh order context**, so the fee and minimum always reflect the current
   zones. The stored address comes from the signed payload, not client text. An
   invalid or expired token is `422 delivery_quote_expired`.

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
`formatted`, `line1`, `city`, `state`, `postalCode`, `country`, `unit`, `exp`.
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
- Several matches → the cheapest zone (fee, then minimum) wins.

`GET /orders/options` reports `delivery.available: true` only when some enabled,
allowed, in-house zone can actually be checked: zip-code zones always; radius
zones need a geocoder and real store coordinates; polygon zones need a geocoder.

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

Rate limits (production): `/delivery/places` 60/min and `/delivery/quote` 20/min
per IP, plus hourly per-org caps (3000 searches, 600 quotes).
