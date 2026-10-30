# Marketing: Social media

Operators write a post once and send it to the organization's Facebook Pages and
Instagram professional accounts: now, at a scheduled time, or later from a
draft. A month calendar shows what went out, where, and what is coming.

Find it at Marketing, Social media (`/:org/marketing/social`).

## Access

| Who                                        | Can                                                     |
| ------------------------------------------ | ------------------------------------------------------- |
| Members with `read:campaign:any`           | See the calendar, posts and connected accounts          |
| Members with `update:campaign:any`         | Connect and disconnect accounts; write, schedule, send  |
| `META_APP_ID` / `META_APP_SECRET` (App)    | The Meta app. Empty: accounts cannot be connected       |
| `SOCIAL_MOCK=true` (local only)            | A Meta emulator: sample accounts, nothing really posted |
| `INTEGRATION_ENCRYPTION_KEY` (already set) | Encrypts the stored Page tokens                         |

`SOCIAL_MOCK` is ignored unless `BASE_URL` is a local host (`localhost`,
`127.0.0.1`, `*.test`, `*.localhost`). Under the emulator a post whose text
contains `#fail` is refused, to try the failure and retry path. Playwright sets
it.

## Setting up the Meta app

1. In [Meta for Developers](https://developers.facebook.com/apps/), create a
   **Business** app and add **Facebook Login for Business** (or Facebook Login)
   and the **Instagram Graph API** (Instagram API with Facebook Login).
2. Valid OAuth redirect URI: `<BASE_URL>/resources/social/meta/callback` (one
   per environment).
3. Permissions requested: `pages_show_list`, `pages_read_engagement`,
   `pages_manage_posts`, `business_management` (Facebook) and `instagram_basic`,
   `instagram_content_publish` (Instagram). They need Meta's App Review
   (Advanced Access) before customers outside the app's own business can
   connect.
4. Turn on **Require App Secret** in the app's advanced settings: every call
   sends `appsecret_proof`.
5. Set `META_APP_ID` and `META_APP_SECRET` on the App (the secret is sensitive).

## Connecting accounts

Accounts belong to the organization, not to the member who connected them.
**Connect Facebook** or **Connect Instagram** (Marketing, Social media,
Accounts) sends the member to Facebook, where they pick the Pages to allow. The
App exchanges the code for a long-lived user token, reads the Pages
(`/me/accounts`) and keeps one row per Page, or per Instagram account linked to
a Page, in `SocialAccount`. The user token is not stored; Page tokens obtained
from it do not expire. Connecting again refreshes the same rows.

Instagram accounts must be professional (business or creator) and linked to a
Facebook Page. If none is found, the page explains what to change.

The hand-off uses a signed, HttpOnly cookie (state, platform, member,
organization; ten minutes; callback path only). The callback accepts it once,
for the same signed-in member, who must still have the campaign write
permission.

When Meta refuses a Page token (password change, permission removed), the
account is marked **Reconnect needed**, posts to it fail with a message saying
so, and Meta is not called again until it is connected again.

## Posts and publishing

```text
Compose   text, images from the media library (up to 10), accounts, time
            ├─ Save draft      SocialPost draft (a date is optional)
            ├─ Schedule        SocialPost scheduled ─▶ jobs-cron SocialPostWorkflow
            │                    sleeps until the time ─▶ POST /resources/jobs/social-publish
            └─ Publish now     scheduled for now, sent before the page reloads
Publish   claim the post (scheduled ─▶ publishing, one caller only)
            ─▶ each SocialPostTarget: claim (pending ─▶ publishing) ─▶ Meta
            ─▶ published | failed per account ─▶ post published | partial | failed
```

- Rules checked in the composer and again on the server: Facebook takes text,
  images or both; Instagram needs at least one image, a caption of at most 2,200
  characters and 30 hashtags. Several images become a Facebook multi-photo post
  and an Instagram carousel.
- Images are sent to Meta as signed links to the media library (one hour),
  converted to JPEG, since Instagram takes no other image format.
- The workflow's wake-up is idempotent: it publishes every post that is due, and
  a post that was rescheduled, deleted or already sent is simply not due.
  Nothing is cancelled. The hourly jobs-cron trigger runs the same sweep, so a
  wake-up that failed to start delays a post by an hour at most. Without
  `JOBS_CRON_WORKER_URL` (local development) only Publish now and the sweep
  publish.
- A target interrupted mid-send (the post stayed `publishing` for 15 minutes) is
  marked failed with a note to check the platform first; it is never sent again
  automatically, since Meta may already show it.
- **Retry failed accounts** sends only the failed targets again. **Copy to new
  draft** starts a new post from a sent one. Deleting a post removes it from the
  calendar only; what is on Facebook or Instagram stays there.
- Drafts and scheduled posts can be edited until they start publishing.

The calendar places a post on the day it went out, or the day it is scheduled,
in the member's time zone. Drafts without a date are listed below it.

## Data

Control-plane tables (migration `0022_social_posts`): `SocialAccount`,
`SocialPost`, `SocialPostTarget`. Posts are the organization's own marketing
content, not customer data. A target copies the platform and account name, so
history stays readable after an account is disconnected.

## Testing

- Unit: `apps/app/app/utils/social/*.test.ts` (publishing, races, retries,
  reconnects, interrupted sends, composer rules, time zones) and
  `apps/jobs-cron/src/index.test.ts` (workflow start).
- Locally: set `SOCIAL_MOCK=true` in `apps/app/.env`, then Marketing, Social
  media, Accounts, Connect.
