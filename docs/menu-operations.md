# Menu operations: schedules, auto-popular, AI import, channels and guest photos

This covers five menu-operations features (#149, #97, #73, #220, #148).
Control-plane schema additions live in
`packages/database/drizzle/0069_menu_operations.sql`; regional guest photo
submissions live in
`packages/tenant-db/drizzle/0058_guest_photo_submissions.sql`.

## Scheduled menu changeover (#149)

- **Storage**: `MenuSchedule` (`menuId`, `takeOffMenuId`, `goLiveAt`, `status`).
  One pending schedule per menu.
- **UI**: `MenuScheduleCard` on `menus.$menuId.tsx` and `MenuScheduleBadge` on
  `menus._index.tsx` (uses the organization's location timezone via
  `resolveOrganizationTimezone`).
- **Execution**: `wakeMenuSchedulerAt` starts `MenuScheduleWorkflow`
  (`apps/jobs-cron/src/menu-schedule-workflow.ts`) via
  `POST /workflows/menu-schedule/start`, which sleeps until `goLiveAt` and posts
  to `POST /resources/jobs/menu-schedules` (`requireInternalCommandAuth`). The
  hourly `0 * * * *` cron acts as a fallback sweep.
- **Cutover**: `claimDueMenuSchedule` atomically marks `pending -> done`,
  `runClaimedMenuSchedule` records a `before_schedule` snapshot, makes the menu
  `available` (and `takeOffMenuId` `unavailable` when set), and purges the
  published site KV cache.

## Auto Popular (#97)

- **Flag**: `menu.auto_popular` (off by default).
- **Settings**: `Organization.autoPopularCount` (3–10, default 5 when enabled)
  configured in `items._index.tsx` (`AutoPopularSettings`); per-dish
  `popularMode` (`auto` | `always` | `never`) configured in `item-form.tsx`
  (`PopularModeSelect`) and resolved by `effectiveIsPopularForMode`.
- **Residency & pipeline**: Regional `tenant-api`
  (`POST /api/menu/popular/tick`, driven by the hourly cron fan-out and guarded
  once per day per org in `marketingSettings` key `menu_popular_last_run`)
  computes the 28-day top sellers (minimum 20 sold dishes) and posts **only item
  IDs** (`menuPopularPayloadSchema`: `{ orgId, itemIds, windowDays }`) to App
  `POST /resources/menu/popular` (`requireInternalCommandAuth`). App updates
  only `popularMode = 'auto'` available dishes and purges site cache.

## AI menu import (#73)

- **Flag & kill switch**: `menu.import` (off by default) and
  `MENU_IMPORT_ENABLED` (unset/true = on).
- **Routes**: `menu+/import.tsx` (linked from `organizations+/create.tsx` Step
  4/5 and Menu tabs), `menu+/import.$importId.tsx` (review tree, draft save,
  apply, cancel), and `POST /resources/jobs/menu-import`.
- **Safety & workflow**: URL sources pass `validateMenuImportUrl` (HTTPS-only,
  DNS-resolved public-IP SSRF guard via `@repo/security/ssrf`, hop-by-hop
  redirect re-check, 10 MB / 20s cap). Uploads validate magic bytes and strip
  allergen/calorie spreadsheet columns before extraction. `MenuImportWorkflow`
  (`/workflows/menu-import/start`) triggers `POST /resources/jobs/menu-import`.
- **Apply**: `applyMenuImport` claims `ready -> applying`, takes a
  `before_import` snapshot, matches existing items idempotently by id or exact
  localized name, creates menus/dishes unavailable by default unless
  `publishNow` is checked, and never writes `allergens`, `calorieMin`,
  `calorieMax`, or `imageKeys` (images stay suggestions only).

## Channel availability (#220)

- **Contract**: `MENU_CHANNELS = ['web', 'qr', 'pos', 'app']`
  (`@repo/common/menu-channels`). Base `channels` on menus, categories, and
  items plus narrow-only `OrganizationMenuLocationOverride.channels`.
- **Catalog & ordering**:
  - `GET /resources/sites/menu?channel=...` filters out items, categories, and
    menus hidden on `web`, `qr`, `app`, or `pos` (with per-channel KV cache
    keys).
  - `GET /resources/order-context` retains full catalog + `channels` metadata so
    regional `priceRestaurantOrder` returns `409 item_unavailable` for
    off-channel items on quote and order placement (server-derived channel;
    client channel spoofing ignored).
  - `apps/customer` requests `?channel=app`; `apps/station` requests
    `?channel=pos`; `apps/tenant-api` `pos-service.ts` flags off-POS items with
    `catalog:item_unavailable` (`POS_CONTRACT_VERSION` stays `11`).

## Guest dish photos & moderation (#148)

- **Flag, kill switch & residency**: `menu.guest_photos` (off by default),
  `GUEST_PHOTOS_ENABLED` on `tenant-api`, and **forced off for KSA**
  (`isGuestPhotosEnabledForOrganization` in App and `isOrgGuestPhotosEnabled` in
  `tenant-api`).
- **Guest upload (`tenant-api`)**: `GET /photos/eligibility`,
  `POST /photos/upload` (10 MB multipart body limit, magic-byte validation,
  pure-TS JPEG/PNG/WebP EXIF/XMP/metadata stripping before writing
  `guest-photos/<orgId>/...` to R2; raw HEIC fails closed with
  `422 heic_conversion_unavailable` unless client canvas conversion or
  `HeicConverterAdapter` runs), and `POST /photos` (eligible ordered dish within
  14 days, 3/dish/order & 10/guest/day caps, explicit consent).
- **Operator moderation (`apps/app` + `tenant-api`)**: `menu+/guest-photos.tsx`
  uses short-lived `pho+jwt` tokens from `menu+/photos-token.ts`
  (`update:guest_photo:any`) to call `/operator/photos/*` directly. Approving &
  adding to a dish copies **only** re-verified cleaned bytes
  (`guest-photo-<submissionId>.<ext>`, no guest ID/PII) into App
  `OrganizationMediaAsset` and `OrganizationMenuItem.imageKeys` (cap 5).
- **Retention, erasure & deprovision**: `POST /api/guest-photos/tick` purges
  rejected rows and R2 objects older than 30 days; `person-erasure-service.ts`
  deletes pending/rejected rows + R2 objects and unlinks `customerId`/`orderId`
  on approved/added rows; `POST /api/deprovision` deletes
  `guest-photos/<orgId>/` before destroying the tenant DB.
