# Dish photos: focal point, quality, bulk upload, phone capture, A/B tests and restyle

Six features share one media library, one studio pipeline, one `parentAssetId`
version link, one score and one photo-test type. Business media only: library
photos, scores, restyle runs and photo tests live in the control plane. Guest
PII never enters this module; the only regional data is photo-test counts.

Flags (default off): `media.photo_quality`, `media.restyle`, `menu.photo_tests`.
Kill switches: `MEDIA_RESTYLE_ENABLED` (App), `DISH_PHOTO_TESTS_ENABLED`
(tenant-api). Migrations: control plane `0072_dish_photos`, tenant
`0060_dish_photo_tests`. Deploy order: App (migration, routes, jobs), then
jobs-cron, then tenant-api, then Sites and Station, then the operator mobile
app.

## Shared pieces

| Piece                                                         | Where                                          |
| ------------------------------------------------------------- | ---------------------------------------------- |
| Focal point math, crop URLs                                   | `packages/common/src/image-focal.ts`           |
| Quality vocabulary, thresholds, model-output parsing          | `packages/common/src/photo-quality.ts`         |
| Bulk matching, limits                                         | `packages/common/src/dish-photo-match.ts`      |
| A/B rules (assignment, crawlers, winner)                      | `packages/common/src/photo-test.ts`            |
| Restyle rules (use/draft checks, budget)                      | `packages/common/src/media-restyle.ts`         |
| The one way a dish's main photo changes outside the dish form | `apps/app/app/utils/menu/dish-photo.server.ts` |

`replaceDishMainPhoto` / `replaceDishMainPhotosBatch` are used by bulk apply,
the phone app, keeping an A/B winner and restyle Use new / Switch back. They
compare-and-set the dish's photo fields inside one `db.batch`, refuse with
`photo_changed` when the dish photo is no longer what the caller reviewed, keep
the old photo in the library as the new photo's original (`parentAssetId`, #147)
and purge the site cache.

## Focal point (#394)

`OrganizationMediaAsset.focalX/focalY` (0..1 from the top left; null is the
centre, so existing photos keep centre crops). Set in Media, photo details,
"Crop focus" (`intent=set-focal`; saving bumps `updatedAt`, which is part of
every photo URL, and purges the site cache, so nothing is uploaded again).

Every channel reads the point from the public menu payload (`imageFocal`,
`imageFocals`, per option and variant `imageFocal`) and applies
`object-position`: Sites (cards, popular rows, modal, dish page, highlights,
drops), Station (`--focal`), and the library's own `/resources/images`
(`fit=cover` crops pass `gravity` to Cloudflare Images; the Node dev path does
not crop by gravity). Delivery platforms receive a pre-cropped URL
(`applyFocalCrops` in the POS projection). The customer app renders no dish
photos today, so there is nothing to crop there.

## Photo quality (#145)

Flag `media.photo_quality`. Every ready library image from the library, the
studio or the phone is scored 0-100 with issues `too_dark`, `blurry`,
`dish_cut_off`, `low_resolution`, `not_food` in the background:
`PhotoQualityWorkflow` (jobs-cron) calls `POST /resources/jobs/photo-quality`
(internal token) in paced batches of 10; each batch claims its images
(`qualityClaimedAt`) so two workflow instances never pay for the same photo, and
the hourly sweep re-drives it for organizations with the flag on, oldest waiting
image first. The upload, replace and phone routes wake the workflow, so a new
upload is scored within minutes.

- A short side under 800 px is `low_resolution` without any model, and such a
  photo is not sent to the model.
- A model answer that does not parse leaves the photo unscored (no penalty) and
  is retried once (`qualityAttempts`).
- 200 model analyses per organization per day (`checkRateLimit`); at the limit
  the job answers `limited: true` and the sweep resumes the next day.
- Guest-submitted photos (`source = 'guest-photo'`, or a `guest-photo-` file
  name) are never read.
- Replacing or editing an image resets its score and focal point.
- The model is behind an adapter (`utils/media/photo-quality.server.ts`);
  `MOCKS=true` or `PHOTO_QUALITY_MOCK=true` (local `BASE_URL` only) answers from
  a deterministic emulator.
- Media library shows the score badge and the "Needs a better photo" filter.
  Menu health has `weak_photo` (a deduction check, so existing grades do not
  move) next to `no_photo`; "Fix in photo studio" opens
  `/:org/media?studio=<assetId>&issues=too_dark,blurry` with the studio's "Extra
  direction" filled in.

## Bulk dish photos (#316)

Media, "Add dish photos in bulk" (`/:org/media/dish-photos`). Drop images or a
zip (read in the browser). Up to 100 photos, 10 MB each, 400 MB in all. Each
photo uploads through the library's own upload (same magic-byte validation), one
request per file with retries, pauses while offline and a local record of what
finished, so a dropped connection resumes. `propose` matches by file name and,
through a mockable vision adapter, by what is in the picture; it writes nothing
to any dish. The operator confirms, swaps or skips each pair; a dish that
already has a photo is "Replace?" and off by default (and refused whole if sent
without it). `apply` changes all confirmed dishes with one `db.batch` and one
cache purge. Photos that are not food, too small or duplicates are flagged
before the review. Unmatched photos stay in the library.

## Operator phone capture (#222)

Mobile "Menu photos" lists dishes without a photo (best sellers first, then menu
order) and lets the operator photograph, retake or pick one, or open any dish by
search to replace its photo. The phone re-encodes to JPEG (long edge 2000 px, no
EXIF/GPS), queues the upload persistently and retries with backoff ("Waiting to
upload"); the queue is cleared on sign-out.

App routes (`apps/app/app/routes/api+/menu.photos.ts`, bearer token):
`GET /api/menu/photos`, `POST /api/menu/photos`. Permission is
`update:menu:any`, org-wide like the web dish form (location scope does not
apply to menu edits there). The server strips metadata again, checks the real
bytes, is idempotent per `clientId`, keeps the old photo as a version, and
leaves out dishes a connected POS would overwrite. The weekly "top sellers have
no photo" nudge waits for operator push (#106).

## Photo A/B tests (#192)

Flag `menu.photo_tests`. Item page, "Try another photo": photo B comes from the
library; photo A is the dish's main photo at the start. At most 20 dishes in
test per organization, one per dish (`MenuItemPhotoTest`).

- The public menu carries `photoTest { id, imageUrlB, imageFocalB }` only on the
  `web` and `qr` channels. The customer app, delivery menus, order context,
  print and GBP always get photo A. Menu HTML and payload are cached identically
  for everyone, so Sites swaps photo B in the browser.
- A visitor's variant is a hash of a random id kept only in their browser
  (`localStorage['menuza:photo-client']`, never sent) and the test id: stable
  for the whole test. Crawlers, Do Not Track and clients without storage get A.
- Views and adds to cart are counted per day, test, dish and photo in the region
  (`dish_photo_daily`, numbers only) through `POST /forms/dish-photo-events`
  (batched, always 204, rate limited; an event counts only with the beacon `key`
  the App signs into the menu payload for that organization, test and dish, so
  invented test ids count nothing; one row stops counting at 20 000 a day, so a
  replayed key cannot run away; 20 requests a minute per address; capped at 2000
  distinct rows per organization per day). Orders are not counted there: the
  order body carries `photoTests` entries with the same signed key (sent only
  when set, unsigned entries are dropped) and the region stores ids in
  `dish_photo_order_lines`; results count only orders that are counted sales and
  not fully refunded (`POST /operator/photo-tests/results`, scope
  `photo_tests`).
- The win measure is orders per view. A winner is named only after 200 views of
  each photo and 7 days ("Not enough data yet" before). Keep A / Keep B (or
  stop) ends the test; keeping B makes it the dish's main photo through
  `replaceDishMainPhoto`. The losing photo is never deleted. Changing the dish
  photo some other way ends a running test.

## Menu restyle (#146)

Flag `media.restyle`, kill switch `MEDIA_RESTYLE_ENABLED`. Media, "Restyle menu"
(`/:org/media/restyle`): pick a studio style, optionally limit to categories,
start a run. `MediaRestyleWorkflow` calls `POST /resources/jobs/media-restyle`
in small batches; each dish's main photo gets a draft (`source = 'restyle'`,
`status = 'draft'`, `parentAssetId` = the original). Live photos do not change
until Use new.

- Only the plate, backdrop and light may change (`RESTYLE_FOOD_RULE` in every
  prompt). The model sits behind an adapter that reuses the single-photo studio
  generator (`MOCKS=true` / `MEDIA_RESTYLE_MOCK=true` for a local emulator).
- One run at a time per organization (`restyle_in_progress`, enforced by a
  partial unique index on active runs); a dish the model could not do right now
  is retried after two minutes, not at once; dishes whose photo a connected POS
  owns are skipped; at most 200 photos per run; 150 photos per organization per
  UTC day, then the run pauses and resumes the next day. Dishes without a photo
  are skipped and listed.
- Use new is refused with `photo_changed` if the dish's main photo is no longer
  the one the draft was made from, and with `draft_changed` if the draft
  changed. Switch back restores the original in one click. Use all applies the
  rest.
- Drafts not chosen within 30 days are deleted by the hourly sweep.

## Tests

`packages/common/src/{image-focal,photo-quality,photo-test,dish-photo-match,media-restyle}.test.ts`,
`apps/app/app/utils/menu/{photo-tests,public-menu-photos,menu-health.photo-quality,pos-projection-focal}*.test.ts`,
`apps/app/app/utils/media/{photo-quality,bulk/*,restyle/*}*.test.ts`,
`apps/app/app/routes/api+/menu.photos.test.ts`,
`apps/app/app/routes/_app+/$orgSlug_+/{media.photos,media_.dish-photos,media_.restyle}*.test.ts`,
`apps/tenant-api/src/routes/dish-photo-tests.test.ts`,
`apps/sites/src/lib/{photo-test-client,ordering/dish-photo,ordering/photo-test-order}.test.ts`,
`apps/jobs-cron/src/{photo-quality,media-restyle}-workflow.test.ts`,
`apps/mobile/lib/photo-queue/__tests__`.
