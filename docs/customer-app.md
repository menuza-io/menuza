# Branded customer app: management, links, orders, invites and push

One restaurant, one branded app (`apps/customer`), managed from Admin and App.
This page is the operator and developer guide for five features that ship
together: #156 (management), #195 (links), #112 (orders), #196 (invites) and
#105 (push). Everything is behind flags that default to off.

## Deploy order

1. **App and Admin**: control-plane migration `0068_customer_app`, the app
   registry, the internal config and summary endpoints, flags and permission.
2. **tenant-api** (every node): tenant migration `0057_customer_push`, the
   `/customer/orders*` and `/push/*` routes, senders that build links through
   the registry.
3. **Sites**: `.well-known` association files, `/get-app`, invite banner and
   blocks, order history and "Order again".
4. **Customer app**: a new build per restaurant. An old build keeps working; it
   simply has no order screen, push or link handling.

New strict keys are sent only when set, so an older node ignores them.

## 1. Managing each restaurant's app (#156)

- **One registry**: `CustomerApp` (+ credentials, builds, store health, account
  snapshot) in the control plane. `tenants/<slug>.json` files are generated from
  it (`npm run tenant -w customer -- --tenant <slug> --registry`); committed
  files stay until every app is migrated, and a generated file wins.
- **Admin, Customer apps**: create an app from the organization's published
  site, start a build, bulk release (each app on its own, failed apps retried
  alone), see store version and rating per store, record the account facts.
  Permission `update:customer_app:any`.
- **Credentials are write-only**: encrypted with `INTEGRATION_ENCRYPTION_KEY`,
  never selected by a loader. Only `checkStoredCredential` decrypts and answers
  a yes or no. tenant-api learns readiness booleans only
  (`/resources/customer-app/summary`, internal token).
- **Adapters**: builds, store health, account checks, APNs/FCM and Expo go
  through mockable adapters (`MOCKS=true` locally, injected in tests). No test
  calls a third party.
- **Expiring developer account**: the daily jobs-cron slot raises an attention
  item with renewal steps (App bell and Admin).
- Flags: `customer_app.enabled` (master), `.push`.

## 2. Links (#195)

- **One registry**: `@repo/common/links` builds and resolves every guest link
  (`buildLink`, `buildLinkTemplate`, `resolveLink`). No sender builds a guest
  URL by hand (`links.senders.test.ts` fails if one does).
- Capability tokens (order link, reservation token) ride in the **URL fragment**
  only.
- `apple-app-site-association` and `assetlinks.json` come from the site's own
  app binding. A white-label build claims only its own host.
- A link the app does not own, an unknown type or a newer version falls back to
  the website. The app resolves with the same code (`lib/links/app-links.ts`,
  `app/+native-intent.tsx`).

## 3. Orders and order again (#112)

- `GET /customer/orders`, `/customer/orders/:id`, `/customer/orders/:id/reorder`
  on tenant-api, for the signed-in guest only. Another customer's id
  answers 404.
- **Reorder** returns catalog ids only. The cart is rebuilt in the client with
  the existing `repriceHandoffCart`/`restoreCart`; a missing item, variant or
  option drops the whole line and is reported. The app has no cart, so it hands
  the ids to the website in the URL fragment (`#reorderlines=`).

## 4. Inviting website guests (#196)

- Banner (phones): after the first order or on the second visit, never on cart
  or checkout, never inside the app's own web view, dismissed for 30 days. Rules
  run in the browser from local state.
- Order confirmation, receipt email, footer, page block and a printable QR code
  (Print shop, "Get the app").
- Every placement shows only the stores that are **live**. A tap goes through
  the site's own `/get-app?p=<placement>` redirect and is counted per placement
  and day (`POST /resources/sites/app-tap`, rate limited, no visitor data).
- App, Marketing, Customer app: switches, banner text and tap counts.

## 5. Push (#105)

- **Devices, preferences, send log** are regional (tenant-db `0057`), included
  in person erasure. A push token is sealed (AES-256-GCM) and looked up by HMAC.
  At most 10 devices per guest.
- **Flags**: `customer_app.push` (service pushes) and `marketing.push` (offers
  and broadcasts). The app also needs its APNs key and FCM service account
  uploaded in Admin.
- **Kill switches**: `PUSH_ENABLED=false` on a node stops registration and
  sending. The **KSA node sends nothing until legal approves** and
  `PUSH_KSA_APPROVED=true` is set there.
- **Service pushes**: order accepted, ready, cancelled; booking confirmed,
  reminder, waitlist ready; reward available and points earned. One push per
  event and device (unique `(kind, ref, device)`). A tap opens the screen the
  payload's registry link names.
- **Marketing push**: opt-in is the `push` subscription (source `profile` or
  `app_prompt`), off until the guest chooses it. Broadcasts have a Push channel;
  automations have a "Send push" step. A push is logged in `marketing_messages`,
  so the frequency cap (#99) counts it. Quiet hours (#75) are not applied yet
  (that issue is open).
- **No personal data in a payload.** The payload schema is strict: a title, a
  body, a kind, a link from the registry and a message id. No names, phones,
  emails, addresses or capability tokens; marketing pushes allow no merge tags.
  Tested over the real payloads (`push.test.ts`, `push-marketing.test.ts`).

## Tests and gates

- `apps/tenant-api/src/routes/push.test.ts`, `push-marketing.test.ts`,
  `customer-orders.test.ts`
- `apps/app/app/utils/customer-apps/*.test.ts`, `customer-apps.routes.test.ts`,
  `utils/print/restaurant/app-target.test.ts`,
  `utils/marketing/campaign-push.server.test.ts`
- `packages/common/src/links*.test.ts`, `push.test.ts`,
  `customer-orders.test.ts`
- `apps/customer`: Jest (`lib/push`, `components/profile/notifications-section`,
  `components/shell/push-lifecycle`, orders and links)
