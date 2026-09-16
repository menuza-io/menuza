---
name: project-storage-media
description:
  Guide S3-compatible storage, organization media, signed URLs, image/video/font
  delivery, and storage migrations in this project.
---

# Project storage and media

## When to use this skill

Use this skill when changing uploads, media-library records, object keys,
presigned URLs, images, videos, fonts, site assets, custom organization S3
storage, or storage migration workflows.

## Storage architecture

`@repo/storage` wraps S3-compatible storage and exports typed clients plus
purpose-specific helpers such as `uploadProfileImage`,
`uploadOrganizationMediaImage`, `uploadNoteVideo`, `uploadVideoThumbnail`,
`uploadWebsiteAsset`, and `uploadSiteFont`.

The default bucket is platform-managed. An organization may configure its own
S3-compatible backend; credentials are encrypted using the existing
`SSO_ENCRYPTION_KEY` path and must not be sent to the browser. Track whether an
object is platform- or organization-scoped and resolve the owner before signing
or deleting it.

## Object and database lifecycle

- Generate safe, high-entropy keys through the existing upload helpers; do not
  use raw user filenames or path traversal input as storage keys.
- Persist an object reference only after the upload succeeds, and keep the DB
  record plus owning organization/user relationship in the same mutation flow.
- Before deleting an object, check all known references: media assets, page
  section config, note uploads/images, organization images/site icon/fonts, and
  any domain-specific reference. Delete the storage object only when it is no
  longer referenced.
- For GDPR/user deletion, remove both control-plane references and owned objects
  through the established deletion utility. Do not leave orphaned private
  objects or delete another organization’s object because a key was supplied by
  the client.

## Signed delivery

App resource routes sign access to stored objects after validating the request
and object scope:

- `/resources/images` handles raster images and videos, including object-key
  validation and range streaming for video.
- `/resources/videos/source` streams source video for poster/clip processing.
- `/resources/fonts` allows only site-font key patterns.
- Sites uses App-backed resource URLs for public media and may proxy video
  delivery for the public site; this is media delivery, not tenant PII auth.

Presigned GET/PUT/DELETE URLs are short-lived and generated server-side. Never
accept an arbitrary storage URL, bucket, or signed header from the browser.
Reject `..`, low-entropy keys, invalid characters, wrong scope, and ownership
mismatches before signing.

## Images and video

Use the existing raster detection/validation and image upload helpers rather
than duplicating MIME checks. Keep responsive image dimensions/fit behavior
consistent with the image resource route and site media utilities.

Video posters and clips use Cloudflare Media Transformations when
`MEDIA_TRANSFORM_BASE_URL` is configured. The source fallback is
`/resources/videos/source`; poster generation is not a background job. Preserve
range headers and cache behavior when changing video proxy/resource routes.

## Custom-storage migration

The App migration action creates a migration record and starts `jobs-cron`’s
`StorageMigrationWorkflow` through an authenticated internal request. The
workflow repeatedly calls App batch/progress/complete endpoints with
`INTERNAL_COMMAND_TOKEN`, uses stable Workflow step names, and reports
per-object failures.

Do not perform an unbounded object copy inside a request. Make each batch
idempotent, resumable, and safe to retry; do not mark a migration complete while
objects remain or silently turn failed copies into success. The workflow moves
media, not customer PII.

## References

- [Image storage](../../image-storage.md)
- [Image optimization](../../image-optimization.md)
- [Organization S3 storage](../../organization-s3-storage.md)
- [Storage package](../../../packages/storage/README.md)
- [Storage migration workflow](../project-jobs-observability/SKILL.md)
