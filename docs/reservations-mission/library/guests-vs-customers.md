# Guests vs Customers: decision document

Status: recommendation, read-only investigation. Nothing in `apps/`, `packages/`
or the other docs was changed. All claims below were checked in code on branch
`pr/reservations`; items I could not verify are marked **(unverified)**.

Product-owner concern: "guests in reservations look like customer information;
we should just have customers, but reduce confusion for restaurant owners
without overburdening them with screens."

## 0. Summary

Recommendation: **Option A, in a staged form.** Keep both tables. Make
**Customers the only people screen** in the sidebar. Reservation data (visits,
no-shows, next booking, allergy flag, VIP/tags, notes) becomes a **"Dining"
section on the customer profile**, and the list gets reservation columns and
quick filters (VIP, Allergy, Lapsed, Upcoming). `/reservations/guests*` redirect
into Customers. People who booked but never signed in appear in the same list as
**"Guest, no sign-in"**. The link between `rsv_guests` and `customers` stays a
verified-phone link only; nothing is auto-created in `customers` for guests.

Two things must land before the Guests screen is removed, because today they are
real gaps rather than cosmetics:

1. **One erase flow.** Erasing a guest today leaves the `customers` row, its
   subscriptions and orders untouched, and there is no App flow that erases a
   customer at all (see 1.4).
2. **One consent source.** Reservation marketing consent is recorded in two
   places and one of them is never read (see 1.3).

Do not do Option B (physical merge) now.

---

## 1. FACTS

### 1.1 Field-by-field comparison

| Aspect             | `customers` (regional, `packages/tenant-db/src/schema.ts` line 24)                                                                                                                                                                                                                       | `rsv_guests` (line 3902)                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity key       | `id`; `phone` UNIQUE nullable; `stripe_customer_id` UNIQUE                                                                                                                                                                                                                               | `id` (`gst_<uuid>`); `phone_e164` and `email_norm` indexed, **not unique**; `customer_id` unique partial index (one guest per customer)                                                                                                                                                              |
| Name               | `name` NOT NULL (single field)                                                                                                                                                                                                                                                           | `first_name` NOT NULL, `last_name` default `''`                                                                                                                                                                                                                                                      |
| Contact            | `email`, `phone`                                                                                                                                                                                                                                                                         | `phone_e164`, `email_norm`, `locale`                                                                                                                                                                                                                                                                 |
| Verification       | `phone_verified` bool (phone OTP via tenant-api `/auth/*`); OTP code/hash and refresh tokens live on the row and in `customer_refresh_tokens`                                                                                                                                            | none of its own. Derived: `customerLinked = customer_id !== null` (opaque boolean sent to UI)                                                                                                                                                                                                        |
| Marketing consent  | `customer_subscriptions` rows per (customer, topic `drops`/`reservations`, channel `sms`/`email`) with `subscribed_at`, `unsubscribed_at`, `source` (includes `reservation_booking`)                                                                                                     | `marketing_email_consent_at`, `marketing_sms_consent_at`, `consent_source`, `consent_text_version` on the guest row, plus `marketing_customer_id` pointing at the customer row journeys actually run for                                                                                             |
| Counters           | none. Orders point at it (`restaurant_orders.customer_id`, `shop_orders.customer_id`, `voice_calls.customer_id`, `marketing_messages.customer_id`, `journey_runs`) but nothing is denormalized                                                                                           | `visits`, `covers`, `no_shows`, `late_cancels`, `cancels`, `first_visit_at`, `last_visit_at`; healed by `reconcileGuestCounters` (finished/no_show/cancelled reservations only)                                                                                                                      |
| Tags               | none                                                                                                                                                                                                                                                                                     | `rsv_tags` + `rsv_guest_tags`; categories, `sensitive` flag, derived system tags (frequent no-show etc.)                                                                                                                                                                                             |
| Notes              | none                                                                                                                                                                                                                                                                                     | `rsv_guest_notes` (pinned, soft-delete, author)                                                                                                                                                                                                                                                      |
| Allergy            | none                                                                                                                                                                                                                                                                                     | `allergy_notes` text; serializer exposes `hasAllergy` and dietary-category tag codes to everyone, and raw text only when `canReadSensitive`                                                                                                                                                          |
| Source / channels  | implicit (signed in on Sites/native); `customer_subscriptions.source`                                                                                                                                                                                                                    | per-reservation `channel`; no source column on the guest                                                                                                                                                                                                                                             |
| Erasure            | `POST /internal/reservations/erase-customer` only **unlinks** guest/reservation ids (`unlinkErasedCustomer`). It does not erase the customer. **No caller of this route exists in `apps/app`** (only tenant-api route, tests, README and docs). Customers screen has no delete or erase. | `eraseGuestProfile`: deletes notes/tags, anonymizes row (`Erased guest`, null phone/email/allergy, nulls `customer_id` and `marketing_customer_id`), cancels future bookings (notifies first), scrubs reservation text, events, payments card metadata, waitlist, notify requests, redacts audit log |
| Merge              | none (phone unique blocks duplicates; no merge UI)                                                                                                                                                                                                                                       | `mergeGuests`: sums counters, unions tags, moves reservations/notes, survivor keeps phone/email/allergy/consent (`keep ?? merged`), `rsv_guest_merges` ledger, optimistic `version`                                                                                                                  |
| Edit               | Customers screen sheet edits name, email, phone (PATCH `/operator/customers/:id`)                                                                                                                                                                                                        | Guest profile edits first/last name, phone, email, allergy; tags; notes                                                                                                                                                                                                                              |
| Region / PII plane | regional tenant DB, browser-direct                                                                                                                                                                                                                                                       | same regional tenant DB, browser-direct, token scope `guests`                                                                                                                                                                                                                                        |

The two tables are in the same regional SQLite per org, so joins are cheap and
no cross-region concern exists. Both are served browser-direct; the US App never
sees either (ADR 045, ADR 048 hold unchanged under every option here).

### 1.2 Where each is created, read and linked

`customers`

- Created: `routes/auth.ts` on OTP send/verify (phone sign-in from Sites or
  native); `rsv-marketing-consent.ts` creates an **unverified** row when a guest
  ticks marketing on a booking form and no customer owns the phone.
- Read: `/operator/customers` (list, **first 100 only, no paging, filtering runs
  client-side in `customers.tsx`**), `journey-service.ts` (journey runs and
  message delivery), `report-records.ts` (customer reports; it already matches
  orders to customers **by phone** via `customerIdsByPhone` when `customer_id`
  is null: precedent for phone matching), marketing campaign audience
  (`operator.ts` loads `db.select().from(customers)`), `subscriptions.ts`
  (customer self-service drops opt-in), voice calls.
- Linked from: orders (`customer_id` only when a customer token is presented;
  guest checkout stores `contact_phone`), `rsv_guests.customer_id` /
  `marketing_customer_id`, `rsv_reservations.customer_id`.

`rsv_guests`

- Created: `resolvePublicGuest` (public booking and waitlist; requires a valid
  phone), `resolveOrCreateGuestForBooking` (operator book, phone orders by
  hosts; may have **no phone or email** and defaults to `Walk-in Guest`),
  `createGuestProfile` (operator).
- Matching: by `customer_id` first, then exact `phone_e164`, then (operator path
  only) `email_norm`. Public path never rewrites contact fields of a matched
  profile (hardening) and links `customer_id` only when the customer's
  **verified** phone equals the guest phone and the customer owns no other
  guest. The operator path (`resolveOrCreateGuestForBooking`) **never sets
  `customer_id`**.
- Read: guestbook list/profile/search (`routes/operator-reservations-guests.ts`,
  grants `read/update:reservation_guest:any`), booking sheet search, detail
  sheet, day feed, reports, reservation journeys
  (`restaurant/reservations-journeys.ts`).
- Both phone normalizers are the same function (`normalizeGuestPhone`, re-
  exported by `lib/phone.ts` for auth), so E.164 equality is a sound match key.
  Caveat (pre-existing): a 10-digit input becomes `+1...`, so a Saudi local
  `05xxxxxxxx` typed without a country code is mis-normalized on both sides. It
  still matches consistently, but the stored number is wrong.

Journeys: `emitReservationJourney` is eligible only for (a) a guest linked to a
**verified** customer, or (b) a guest whose `marketing_customer_id` has an
active `reservations` subscription. The idempotency ledger is
`rsv_journey_emissions` (reservation id + event type).

### 1.3 Owner-visible confusion, verified from code

1. **Same person in both lists.** A diner books on the website without signing
   in: one `rsv_guests` row, no customer (unless they ticked marketing, then
   also an unverified customer). Later they sign in with the same phone: a
   `customers` row exists, but nothing links it until their next **signed-in**
   booking. Hosts who book by phone never link at all. Result: the same human
   appears under Customers and under Guests.
2. **Different names and phones.** The booking-form name stays on the guest; the
   OTP profile name lives on the customer; the hardened public path never syncs
   them. A phone edited on one side does not change the other.
3. **Counters that do not add up.** Guest `visits`/`no_shows` count finished and
   no-show _reservations_ only; `customers` has no counter and orders are not
   visits. An owner comparing "Guests: 12 visits" with an order history sees
   unrelated numbers under similar words.
4. **Marketing consent in two places.** Source of truth for journeys and
   campaigns is `customer_subscriptions`.
   `rsv_guests.marketing_email_consent_at` / `marketing_sms_consent_at` are
   **written** by public booking and **copied** on merge but **never read** by
   any send, report or UI path (grep of `apps/` and `packages/`).
   `marketing_sms_consent_at` is never written. They are a stale shadow store.
5. **Consent audience is wider than the consent.** Campaign audience in
   `operator.ts` is `select * from customers` (SMS narrowed to verified phones),
   not filtered by an active `customer_subscriptions` row **(unverified: other
   segmentation code may filter; I only read the campaign dispatch function)**.
   Because booking consent creates unverified customer rows, those people sit in
   the same audience pool as sign-in customers. Check this before the unified
   list displays a consent column, so the UI does not imply a guarantee the
   audience query does not give.
6. **Erasure of one but not the other.** Erasing a guest nulls the links but
   leaves the customer row (name, phone, email), its subscriptions, refresh
   tokens, payment-method rows and order contact data. Erasing a customer is not
   possible from the App at all; the internal unlink route has no caller. An
   owner handling a deletion request must find the person on two screens and
   still cannot finish the job.
7. **Merge side effect.** When both guests being merged are linked to different
   customers, the merged guest's `customer_id` is nulled and that customer
   silently becomes unrelated to the survivor.
8. **Vocabulary.** Sidebar has top-level **Customers** and, under Reservations,
   **Guests**. Detail sheet shows a "Linked customer" badge next to "Open guest
   profile" (guest id, not customer). Guest screens say "guest"; Customers says
   "Verified/Unverified". Reservations docs call it "guestbook CRM".
9. **Walk-in noise.** Operator bookings without contact create a new
   `Walk-in Guest` row per booking (`resolveOrCreateGuestForBooking` cannot
   match without phone/email). They clutter any people list.
10. **Customers list scale.** It loads the first 100 customers and filters in
    the browser; a restaurant with more customers sees a truncated list. A
    unified list cannot reuse this as is.

### 1.4 Safety rules that constrain the design

- Allergy: raw `allergy_notes`, sensitive tags and notes require the guest grant
  (sensitive grants cap token TTL at 5 minutes). Host-facing surfaces get
  `hasAllergy` and dietary tag codes only. Must remain true in the unified
  profile and list.
- No PII to the US App; all people data is fetched browser-direct with
  short-lived operator tokens. A unified endpoint lives in tenant-api; the App
  loader only mints a token.
- Customers screen permission today is `READ_SETTINGS_ANY` (App loader) plus an
  operator token; reservations use `read:reservation_guest:any` with scope
  `guests` tokens. Customer PII must not become readable by someone who only has
  reservation grants beyond what hosts already see on guests.
- Customer region switch deletes the tenant DB; no cross-region PII migration.

---

## 2. OPTIONS

### A. One owner-facing list (Customers), two tables underneath (recommended)

- Customers is the only people screen. Reservation data appears as columns,
  filters and a Dining section. Guests screen removed (redirects).
- A stable link between `rsv_guests` and `customers`: verified phone only
  (persisted `customer_id`), plus `marketing_customer_id` for consenting
  unverified. Unlinked guests show as "Guest, no sign-in".
- Pros: fewest screens (one); one place to see a person, set marketing and
  erase; keeps the reservation engine and its tests, ledgers and optimistic
  versions untouched; zero schema merge risk; incremental rollout.
- Cons: a union query with pagination and sort across two tables; an identity
  display rule for unlinked duplicates; erasure orchestration across several
  tables; permissions mapping (two token kinds).
- Effort: medium-large (about 4 to 6 small PRs; backend ~40%, UI ~45%,
  tests/docs ~15%). Risk: medium, mostly in erasure and permissions, both
  isolated to their own steps.

### B. Physically merge into `customers`

- Add visits/no-shows/tags/notes/allergy to `customers`, repoint ~12 foreign
  keys (`rsv_reservations.guest_id`, waitlist, notify requests, merges ledger,
  audit log entity ids), migrate data.
- Pros: one table, simplest mental model in code.
- Cons: customers have login/token semantics and `phone UNIQUE`; reservation
  guests may have no phone, shared phones, or none at all, and walk-ins are not
  accounts. Would make a booking create a login-capable identity, breaks the
  hardening ("typing a phone number must not touch someone else's profile"),
  re-opens the guest erase transaction, triggers, ledgers and every reservations
  test. Cannot be rolled back easily.
- Effort: very large. Risk: high. **Not recommended.**

### C. Keep separate screens, add cross-links and a "same person" badge

- Pros: smallest change; no permissions work.
- Cons: owner still has two lists, two erase flows, two consent views; does not
  answer the product-owner concern. Cross-link accuracy still needs the link
  rules from A, so most of A's backend cost is paid without the benefit.
- Effort: small-medium. Risk: low. Use only as a stopgap (step 1 of the A plan
  already delivers most of it).

### D. Leave as is

- Pros: no work. Cons: the confusion and the erasure/consent gaps stay; the
  erasure gap is a compliance exposure regardless of UI. **Not recommended** (at
  minimum the erasure gap must be closed).

### Recommendation: A

Justification for restaurant owners:

- **Fewest screens:** the sidebar gets no extra entry; Reservations loses one
  item (Guests) and Customers gains a Dining section only when reservations are
  enabled.
- **Guest relations tasks live in one list:** "allergic tonight" (Allergy filter
  plus Upcoming), "VIPs" (tag filter), "lapsed" (existing 90-day rule), "no-show
  risk" (derived tag) are quick filters, not another page.
- **One place for marketing consent:** the profile shows
  `customer_subscriptions` state (topic and channel), the only source journeys
  read.
- **One erase flow:** one "Erase this person" action that does everything.
- Safety rules are preserved because the Dining section is rendered from the
  same serializers (`serializeGuestRow`, grants and sensitive gating) and the
  endpoint remains browser-direct in tenant-api.

---

## 3. CONCRETE PLAN (Option A)

Vocabulary: owner-facing word is **Customer** everywhere. "Guest" stays only for
(a) the reservation's party ("2 guests"), (b) the status label "Guest, no
sign-in". Internal code names (`rsv_guests`, `/operator/reservations/guests`)
stay; they are the facet API for booking-sheet search and the detail sheet.

### 3.1 Data model

No new person table. Person identity in the API:

- `personKey` = `c_<customerId>` if the person has a customer row linked to a
  guest or no guest at all, else `g_<guestId>`. A customer with a linked guest
  is **one row** keyed by the customer; the guest facet is attached.
- Link rules (persisted, never inferred at read time):
  1. `rsv_guests.customer_id` is set **only** when the customer is
     `phone_verified` and `customer.phone == guest.phone_e164` and no other live
     guest owns that customer (current rule, now applied in more places).
  2. `rsv_guests.marketing_customer_id` is set only by the consent recorder
     (current rule) for an unverified customer created/matched with consent.
  3. Link opportunities: (a) public booking while signed in (exists), (b)
     **new:** when a customer's phone is verified in `/auth/verify`, link the
     live guest with the same phone if the customer has none (best-effort, same
     helper, same guards, never throws into sign-in), (c) **new:** operator
     booking path calls the same helper when a verified customer with that phone
     exists, (d) backfill (3.7).
  4. **Never** link on unverified phone equality alone: anyone can type a phone
     number. Unverified phone matches are shown only as an operator suggestion
     in the profile ("A customer record uses this phone: Link"), an explicit
     audited action; v2, optional.
- Guests with no phone: stay guest-only (`g_`), no matching by name. With email
  only (operator path): matched by email as today; never linked to a customer
  (email is unverified).
- Walk-ins with no contact: keep creating one anonymous guest per booking (a
  shared "Walk-in" row would pool allergy/no-show data across strangers). Flag
  them `anonymous` in the API
  (`phone IS NULL AND email IS NULL AND no tags AND no notes AND no allergy`),
  hide by default behind "Include walk-ins without contact" in the list.
- Index: add `idx_rsv_guests_marketing_customer` on `marketing_customer_id`
  (join key for the union and erase). One additive migration.
- Consent: `customer_subscriptions` is the **single source**. Stop writing
  `rsv_guests.marketing_*_consent_at`; keep columns one release (consent
  evidence for already stored rows), drop later. The booking record still stores
  consent text version where it already does.

### 3.2 tenant-api changes

New routes under the operator router (browser-direct, same Origin/org binding):

- `GET /operator/people` query: `q`, `filter`
  (`vip|allergy|lapsed|upcoming| no_show_risk|signed_in|no_sign_in|subscribed`),
  `tagId`, `sort` (`recent|name|last_visit|next_booking|joined`), `cursor`,
  `limit` (max 50), `includeAnonymous`. Implementation: one SQL `UNION ALL` of
  (customers LEFT JOIN live `rsv_guests` on `customer_id` or
  `marketing_customer_id`) and (live guests with both links null), wrapped in a
  subquery with computed sort keys and keyset cursor, mirroring `listGuests`.
  Returns `{ people, nextCursor, total }`. Replaces the 100-row, client-side
  filtering of the current Customers list.
- `GET /operator/people/:personKey` returns identity (customer facet), Dining
  facet (existing `getGuestProfile`: reservations, notes, pinned notes, tags),
  consent facet (`customer_subscriptions` for the linked/marketing customer),
  and stats:
  `dining {visits, covers, noShows, lateCancels, lastVisitAt, nextBookingAt}`
  and `orders {count, lastOrderAt}` as separate labelled groups. Counters are
  never summed into one "visits" number.
- `PATCH /operator/people/:personKey` edits contact: updates the customer row if
  the person is a customer (current rules), and the guest row if guest-only;
  where both exist, **customer owns contact** and the guest row is updated to
  the same phone/email in the same transaction only when linked by `customer_id`
  (verified). Name edits write both (guest first/last split).
- `POST /operator/people/:personKey/erase` (see 3.5) and
  `POST /operator/people/merge` (guest facet only, see 3.6).
- Existing `/operator/reservations/guests*` stay (booking sheet search, detail
  sheet, API tests). `/operator/customers*` stays as the customers-only data
  path for orgs without reservations until cutover completes, then becomes an
  alias.
- Org flag: facet `dining` only if `reservations.enabled`.

### 3.3 Permissions mapping

Today: Customers = App `READ_SETTINGS_ANY` + operator token; Guests =
`read/update:reservation_guest:any` via scope `guests` tokens (5 minute TTL for
sensitive).

Proposal (field-level gating by token claims in the endpoint, no new permission
in v1):

- Customer facet (orders, subscriptions, joined, phone verified): requires the
  Customers access that exists now (`READ_SETTINGS_ANY` token claim).
- Dining facet (counters, next booking, tags, VIP, allergy flag, pinned notes):
  requires `read:reservation_guest:any`.
- Sensitive (allergy text, sensitive tags, notes bodies, dietary text on
  bookings): requires the same sensitive guest grant and short TTL as today.
- Someone with **only** the guest grant (host, guest_relations) sees only people
  who have a guest record, with the contact fields they already see on Guests
  today and no orders/subscriptions. Someone with only Customers access sees no
  Dining facet and no walk-in rows.
- Sidebar Customers entry shows when either access exists; App route loader
  mints whichever tokens the user qualifies for (two scopes, browser merges
  claims by calling one endpoint with the stronger token; if the endpoint must
  know both, mint one token carrying both claim sets: the minting route already
  derives `scope` from grants).
- Follow-up (not v1): dedicated `read:customer:any` so Customers stops riding on
  `READ_SETTINGS_ANY`.
- Add the endpoint to the security gate test pattern used for staffing
  (`staffing-security.test.ts`): missing, forged, grantless token, cross-org and
  grant-matrix cases.

### 3.4 Marketing consent: single source

- Profile "Messaging" section reads `customer_subscriptions` for the person's
  `customer_id` or `marketing_customer_id`: per topic/channel, on/off, date,
  source ("booking form", "profile"). Operator can turn a subscription off
  (writes `unsubscribed_at`); operators cannot turn one on (consent is the
  customer's).
- No consent UI on `rsv_guests`. `recordReservationMarketingConsent` stays the
  only writer for booking consent.
- Before shipping the column: confirm the broadcast audience filters by active
  subscription per topic, or fix it (flagged in 1.3 item 5). This is a
  prerequisite for showing a consent state truthfully.

### 3.5 Erasure: single flow

One action, "Erase this person", on the unified profile. In one tenant write
transaction (`withSetupWrite`), per person:

1. Existing `eraseGuestProfile` logic for all linked and merged guest ids
   (notify future bookings first, anonymize, cancel, redact).
2. For each linked customer id (`customer_id` and `marketing_customer_id`):
   delete `customer_subscriptions`, `customer_refresh_tokens`, payment-method
   rows; anonymize the `customers` row (name `Erased customer`, null phone,
   email, stripe id, OTP and refresh fields, `phone_verified=false`); scrub
   order contact fields (`restaurant_orders` / `shop_orders` contact
   name/phone/email) and voice call rows (reuse the existing voice
   erase-by-phone/customer logic in `voice.ts`).
3. Replace the unused unlink route's role: `erase-customer` becomes the
   orchestrator internally (keep route name for compat). Needs a security review
   and its own tests (see 3.9). Until this ships, the unified profile must not
   offer an Erase button that does half the job: ship it before the Guests
   screen is removed (step order below). Region switch behaviour is unchanged
   (tenant DB is wiped).

### 3.6 Merge

- Guest facet merge only (the existing `mergeGuests`, with `expectedVersion`).
  Entry point is the person profile "Merge a duplicate" (picks another person
  with a guest facet). Customers are never merged in v1 (verified accounts,
  unique phone).
- Fix item 1.3-7: block the merge with a clear message when both guests are
  linked to **different** customers, instead of unlinking silently.
- Merged guest ids resolve to the survivor (`mergedIntoId`) for deep links.

### 3.7 Migration and backfill (idempotent)

1. Additive migration: `idx_rsv_guests_marketing_customer`. No data change.
2. Backfill job (tick task or one-off internal route
   `POST /internal/reservations/link-customers`, safe to rerun): for each live
   guest with `customer_id IS NULL` and a phone, find a customer with
   `phone = guest.phone_e164 AND phone_verified = 1` that no other live guest
   owns; `UPDATE ... SET customer_id` guarded by `customer_id IS NULL` in the
   WHERE clause; count and log ids only (no PII). Also sets
   `rsv_reservations.customer_id` for that guest's reservations where null. Ties
   (two guests, one phone): link the one with the latest `last_visit_at`; skip
   and count the rest.
3. Do not create `customers` rows for guests, do not backfill from unverified
   phone equality.
4. Consent columns on `rsv_guests`: no migration; stop writing, drop later.
5. Re-run the counter reconcile only if the guest counter code changes (it does
   not here).

### 3.8 UI changes (App, `apps/app`)

- Sidebar: one **Customers** entry. Remove **Guests** from Reservations nav
  (`app-sidebar.tsx` line ~501 and the `reservationsNav.guests` mapping at line
  ~758, `RESERVATIONS_SECTION_REQUIREMENTS.guests`). Reservations host sub-nav
  tests update accordingly.
- Customers list (`customers.tsx`): server paging and filtering through
  `GET /operator/people`; columns: Name, Contact (phone/email), Status ("Signed
  in" or "Guest, no sign-in"), Dining (`N visits`, last visit), Next booking,
  Flags (VIP, allergy icon with codes only, no-show risk, subscribed), Joined.
  Reservation columns hidden when `reservations.enabled` is off. Quick filters
  reuse `isVipGuest`, `isLapsedGuest` (90 days) and the allergy rule, now
  server-side: VIP, Allergy, Lapsed, Upcoming, No-show risk. Footer toggle
  "Include walk-ins without contact".
- Customer profile page `customers/:personKey` (replaces the edit-only sheet,
  which stays as quick edit): **sections, not tabs**: Contact (edit), Dining
  (counters, next booking, history, tags, pinned and full notes per grant,
  allergy shown as codes unless sensitive grant), Messaging (subscriptions),
  Orders summary (later), Data (Merge, Export, Erase). The current
  `guest-profile-screen`, `guest-notes-panel`, `guest-tag-badge`,
  `guest-merge-dialog` are re-parented as the Dining section.
- Reservation detail sheet: "Open guest profile" becomes "Open customer profile"
  linking to `/customers/<personKey>`; the "Linked customer" badge is replaced
  by the same Status label as the list.
- Redirects: `/:org/reservations/guests` to `/:org/customers` (`?filter=`
  preserved), `/:org/reservations/guests/:id` to `/:org/customers/g_<id>`
  (server resolves to `c_...` when linked or to the survivor when merged).
- Lingui: new strings in en and ar; remove unused Guests strings; run
  `node scripts/check-lingui.mjs`. Design-system rules (`@repo/ui`, theme
  tokens) unchanged.

### 3.9 Test plan

tenant-api (Vitest): link helper (verified, unverified, taken customer, two
guests one phone, idempotent rerun); `/auth/verify` linking never breaks
sign-in; `GET /operator/people` (union, pagination stability, sort keys, each
filter, anonymous hidden, merged/erased excluded, 1,000+ rows); grant matrix and
cross-org/cross-scope (security gate in the style of
`staffing-security.test.ts`); no allergy text, sensitive tags or notes without
the sensitive grant; erase orchestration (guest + customer + subscriptions +
orders contact + voice, partial failure rolls back, idempotent second erase,
journeys no longer emit); merge blocked for two different customers; consent
audience filter test.

App (Vitest/Testing Library): list screen filters/columns, profile Dining
section (gated by grants), redirects, sidebar entries, detail sheet link, Arabic
RTL render.

E2E (Playwright, ask the user first on a developer machine): book as guest, sign
in with the same phone later, expect one row after backfill/verify link; host
with only guest grant; erase from profile; deep link from the detail sheet.
Update `reservations-host-stand` and guestbook specs.

### 3.10 Rollout, in small safe steps

1. **Link integrity (backend only).** Helper, `/auth/verify` link, operator
   booking link, backfill route, index migration. No UI change.
2. **Consent truth.** Stop writing `rsv_guests.marketing_*`; verify/fix the
   broadcast audience subscription filter. No UI change.
3. **People endpoints** (`GET`, `GET :key`, `PATCH`) with grant tests. Unused by
   UI yet.
4. **Erase orchestration** (`POST .../erase`) with security review. Merge block
   fix. Still unused by UI.
5. **Customers UI cutover**: list and profile behind `reservations.enabled`
   check; Dining section; Guests nav item still present, now pointing to the
   same profile through redirects (both entries land in one place).
6. **Remove Guests from sidebar**, rename strings, redirects final, detail sheet
   link, e2e and docs updates.
7. **Cleanup** one release later: drop unused `rsv_guests` consent columns,
   remove old guest list screen and route files, retire client-side customers
   filtering.

Each step is independently shippable and reversible (steps 1 to 4 add code only;
5 and 6 are UI behind existing flags).

### 3.11 Existing guestbook tests, e2e, docs, routes

- Keep: `rsv-guest-counters.test.ts`, `rsv-guest-erase.test.ts` (extend),
  `reservations-guestbook-reports.test.ts` (API stays; add people cases),
  `routes/operator-reservations-guests.ts` and `rsv-guestbook-service.ts` (facet
  API used by booking sheet and detail sheet).
- Move/adapt: `guest-list-screen.test.tsx` becomes people list tests;
  `guest-profile-screen.test.tsx` becomes Dining section tests;
  `detail-sheet.guest-crm.test.tsx`, `host-subnav.test.tsx`,
  `reservations-chrome.test.tsx` update for removed nav item and link target.
- Route files `reservations+/guests.tsx`, `guests.$guestId.tsx` become
  redirect-only loaders, then deleted in step 7.
- Docs: `docs/reservations.md` (route table row for Guests, "guestbook CRM"
  wording, erase/merge sections), `docs/tenant-data-residency.md` (endpoints
  table, add `/operator/people`; note on erasure), `apps/app/PRODUCT.md`
  (Customers bullet), `apps/tenant-api/README.md` (internal erase-customer
  note). Add an ADR (next number after 048) "Customers is the single people
  screen; reservation guests are a facet" referencing ADR 045 and 048; mission
  docs `docs/reservations-mission/` get a pointer.

### 3.12 What we do NOT do

- No physical merge of `rsv_guests` into `customers` (Option B).
- No auto-creating `customers` rows for guests or walk-ins; no changes to the
  `customers` login/OTP semantics.
- No linking on unverified phone, name or email equality; no read-time fuzzy
  identity.
- No Sites BFF, no App-proxied people data, no cookies for customer tokens; the
  US App never handles people PII.
- No cross-region PII migration; region switch still wipes the tenant DB.
- No customer-to-customer merge in v1.
- No summing guest visits, orders and no-shows into one "visits" number.
- No new permission names in v1 (dedicated `read:customer:any` is a follow-up).
- No exposing allergy text, sensitive tags or notes outside the sensitive guest
  grant; hosts keep codes/flags only.
- No new top-level screen, no tabs, no extra settings page for this.
- No changes to the reservation engine, public booking hardening, outbox or
  journey ledger (`rsv_journey_emissions`).
- No removal of the `/operator/reservations/guests*` API (booking sheet and
  detail sheet depend on it).

## 4. Open questions for the product owner

1. Hide walk-ins without contact by default? (recommended: yes)
2. Is "Guest, no sign-in" the right owner-facing label, or "No account"?
3. Should operators be allowed to link a customer record by phone suggestion
   (explicit, audited), or never?
4. Retention: should anonymous walk-in guest rows be purged after N days?
5. Saudi numbers: confirm the `+1` fallback for 10-digit input is acceptable or
   should be region-aware (affects matching quality for KSA).
