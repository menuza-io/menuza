# Google Business Profile import

Menuza connects a restaurant to Google Business Profile through the shared
`@repo/integrations` OAuth flow. The operator can connect during onboarding or
from Settings → Integrations, then select one accessible Google location to
import. The import updates the selected Menuza location’s name, address, phone,
and regular hours. Organization branding stays unchanged. The complete returned
listing, including website, categories, and Google metadata, is retained in the
integration configuration for future use.

## Google Cloud setup

1. Enable the Business Profile Account Management API and Business Profile
   Business Information API for the Google Cloud project. Google may require
   Business Profile API access approval before requests succeed.
2. Configure an OAuth web application with the `business.manage` scope and add
   `{BASE_URL}/api/integrations/oauth/callback` as an authorized redirect URI.
3. Set `GBP_CLIENT_ID` and `GBP_CLIENT_SECRET` in the App environment. The
   existing `INTEGRATIONS_OAUTH_STATE_SECRET` and `INTEGRATION_ENCRYPTION_KEY`
   protect OAuth state and stored tokens.

The Google OAuth client used for operator sign-in can be a separate client; GBP
uses its own credentials and consent flow. Reauthorizing an active connection
preserves the selected location link. A later import refreshes that location
from Google. Menuza does not write changes back to Google.

For offline local development, the standard `npm run dev:app` command sets
`MOCKS=true`, so GBP uses a local callback, sample restaurant listing, and
sample reviews; replies are stored with the local integration record. If you run
without `MOCKS=true`, set both `GBP_CLIENT_ID` and `GBP_CLIENT_SECRET` to values
prefixed with `MOCK_`. Mock credentials are disabled in production.

Google API references:
[accounts.locations.list](https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list),
[locations.get](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/get).
