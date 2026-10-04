# Multi-Platform Review Integrations

Menuza unifies customer review monitoring and responses across 6 major
platforms:

- **Google Business Profile (GBP)**
- **Yelp**
- **TripAdvisor**
- **Deliveroo**
- **Just Eat**
- **OpenTable**

Operators can connect each platform per location from **Settings →
Integrations**, link their venue listing, and view and respond to incoming
reviews with optional AI-powered draft assistance directly in **Mailbox →
Reviews**.

---

## Supported Platforms & Developer Documentation

| Platform                    | Authentication / Connection   | Reviews Ingestion                                                            | Responses / Replies                                                                     | Developer Portal                                                          |
| :-------------------------- | :---------------------------- | :--------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| **Google Business Profile** | OAuth 2.0 (`business.manage`) | Google My Business v4 Reviews API (`accounts/{acc}/locations/{loc}/reviews`) | Direct via API (`PUT .../reviews/{id}/reply`)                                           | [Google Business Profile API](https://developers.google.com/my-business)  |
| **Yelp**                    | OAuth 2.0 / API Key           | Yelp Fusion API v3 (`/v3/businesses/{id}/reviews`)                           | Yelp Partner API (`/v3/businesses/{id}/reviews/{id}/responses`) with local fallback     | [Yelp Fusion & Partner API](https://docs.developer.yelp.com)              |
| **TripAdvisor**             | OAuth 2.0 / Content API Key   | TripAdvisor Content API (`/location/{id}/reviews`)                           | TripAdvisor Management Center (`/Owners`), deep-linked & tracked in Menuza              | [TripAdvisor Content API](https://developer-tripadvisor.com/content-api/) |
| **Deliveroo**               | Partner OAuth 2.0 / Webhook   | Deliveroo Partner Platform API (`/restaurants/{id}/reviews`)                 | Deliveroo Hub (`hub.deliveroo.net`), deep-linked & tracked in Menuza                    | [Deliveroo Developer Portal](https://developer.deliveroo.com)             |
| **Just Eat**                | JET Connect OAuth 2.0         | Just Eat Restaurant API (`/restaurants/{id}/reviews`)                        | Just Eat Partner Hub (`partner.just-eat.co.uk`), deep-linked & tracked in Menuza        | [JET Connect Portal](https://developer.just-eat.com)                      |
| **OpenTable**               | OAuth 2.0 / GuestCenter       | OpenTable Partner API (`/v2/restaurant/{rid}/reviews`)                       | OpenTable for Restaurants (`restaurant.opentable.com`), deep-linked & tracked in Menuza | [OpenTable Developer](https://platform.opentable.com)                     |

---

## Architecture & Integration Flow

### 1. Location-Scoped Connections (`@repo/integrations`)

- Each review provider is location-scoped (`isLocationScopedIntegration` returns
  `true` for all 6 review providers).
- Providers implement `OAuthProvider` and are registered in
  `@repo/integrations`:
  - `GoogleBusinessProfileProvider`
  - `YelpProvider`
  - `TripAdvisorProvider`
  - `DeliverooProvider`
  - `JustEatProvider`
  - `OpenTableProvider`
- The `IntegrationTable` record is tied to `organizationLocationId`, and
  `config` stores the provider's listing identifier, URLs, and mock review
  replies.

### 2. Unified Reviews Service (`@repo/integrations/providers/unified-reviews.ts`)

- Normalizes review structures into a shared `UnifiedReview` schema:
  - `id`: Unique review ID
  - `platform`:
    `'google-business-profile' | 'yelp' | 'tripadvisor' | 'deliveroo' | 'just-eat' | 'opentable'`
  - `locationId`: Linked Menuza location ID
  - `locationName`: Linked location title
  - `reviewer`: Name and avatar
  - `rating`: Star rating (`ONE` through `FIVE`)
  - `comment`: Customer review text
  - `createTime`: ISO 8601 creation timestamp
  - `reviewReply`: Operator reply comment and timestamp
  - `externalUrl`: Direct link to original review or partner management portal
- `listUnifiedReviews(organizationId, pageTokens, providerFilter)` queries all
  connected review providers in parallel and sorts results chronologically.
- `replyToUnifiedReview(...)` dispatches the reply to the appropriate service
  handler.

### 3. Settings UI (`apps/app/app/components/settings/cards/organization/review-integrations-card.tsx`)

- Operators view all 6 review providers grouped with official SVG branding.
- Displays connection status per location, connection button, listing dropdown,
  and "Import Listing" action.
- Disconnecting clears or deactivates the integration for that location while
  preserving existing local records.

### 4. Mailbox Reviews Tab (`apps/app/app/components/mailbox/reviews-tab.tsx`)

- Multi-platform filter chips (`All`, `Google`, `Yelp`, `TripAdvisor`,
  `Deliveroo`, `Just Eat`, `OpenTable`) with counts and platform icons.
- Rating filter (`All ratings`, `5 stars`, `4 stars`, etc.).
- Location selector dropdown when multiple locations exist.
- Expandable review details with:
  - Reviewer information, rating badge, date, and original text.
  - "Generate reply with AI" button (calls tenant-api `POST /reviews/draft`).
  - Reply textarea with "Post reply" action.
  - Direct link to the external platform listing or partner hub for
    deep-linking.

### 5. AI Reply Assistant (`apps/tenant-api/src/lib/mailbox-ai.ts`)

- Generates professional, polite, and brand-aligned review replies using the
  tenant AI model.
- Automatically tailors tone based on star rating (enthusiastic appreciation for
  positive reviews; empathetic, resolution-oriented tone for critical reviews).
- Platform-aware context injection.

---

## Offline Local Development & Mocking

All 6 review integrations support 100% offline development:

- **Global Mock Mode**: When `MOCKS=true` is set (default in `npm run dev:app`),
  all review providers operate with built-in mock listings, mock customer
  reviews, and local simulated replies without network calls.
- **Per-Provider Mock Credentials**: In development, if any platform's
  credentials (`*_CLIENT_ID` and `*_CLIENT_SECRET`) start with `MOCK_`, that
  platform switches into mock mode.
- Mock replies are persisted in the `IntegrationTable.config.mockReviewReplies`
  JSON field, so test replies persist across page reloads.

### Environment Variables

Configure platform credentials in `.env` or `packages/integrations/.env`:

```env
# Google Business Profile
GBP_CLIENT_ID=your_gbp_client_id
GBP_CLIENT_SECRET=your_gbp_client_secret

# Yelp
YELP_CLIENT_ID=your_yelp_client_id
YELP_CLIENT_SECRET=your_yelp_client_secret

# TripAdvisor
TRIPADVISOR_CLIENT_ID=your_tripadvisor_client_id
TRIPADVISOR_CLIENT_SECRET=your_tripadvisor_client_secret

# Deliveroo
DELIVEROO_CLIENT_ID=your_deliveroo_client_id
DELIVEROO_CLIENT_SECRET=your_deliveroo_client_secret

# Just Eat
JUST_EAT_CLIENT_ID=your_just_eat_client_id
JUST_EAT_CLIENT_SECRET=your_just_eat_client_secret

# OpenTable
OPENTABLE_CLIENT_ID=your_opentable_client_id
OPENTABLE_CLIENT_SECRET=your_opentable_client_secret
```
