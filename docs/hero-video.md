# Hero video from the restaurant's photos (#301)

Website, hero section: **Make a video from my photos**. The operator picks 3 to
6 of the restaurant's own photos (or lets Menuza choose, preferring the Featured
tag) and a style (slow pans, quick cuts, warm fade). A background job makes a
silent, looping clip of 8 to 12 seconds, sized 1280x720, with a poster frame.
The operator is told when it is ready, watches the preview, and only then
accepts it. **The hero section is not touched until they accept.**

Flag: `website.hero_video` (default off). Kill switch for the renderer: leave
`HERO_VIDEO_RENDERER_URL` empty.

## Flow

1. `POST /:org/website/hero-video` `intent=start` checks the flag, the style,
   that every photo is this organization's own ready, unarchived image
   (`invalid_photos`, `asset_not_ready`), 3 to 6 photos, at most
   `HERO_VIDEO_MAX_PER_DAY` (5) requests in 24 hours (`daily_limit`) and one at
   a time (`already_running`). It stores a `HeroVideoGeneration` row (`queued`)
   and asks jobs-cron to start `HeroVideoWorkflow` (no cron slot used).
2. The Workflow calls `POST /resources/jobs/hero-video` with the request id. The
   App claims the request (one caller wins), re-checks the photos, builds the
   storyboard (`@repo/common/hero-video`, pan and zoom inside each photo only),
   and hands the photos to the renderer adapter.
3. The clip and its poster are stored as media assets with `status = 'draft'`,
   `source = 'hero-video'`, and `parentAssetId` = the first photo (so the
   library shows them as versions of an original, labelled as made by Menuza). A
   draft is private to the organization's members and cannot be attached
   anywhere. The requester gets a `hero-video-ready` (or `hero-video-failed`)
   notification.
4. `intent=accept` makes both assets `ready` (public) and writes `assetType`,
   `videoSrc`, `videoPoster`, autoplay, loop and muted into the hero section of
   the page draft, in one batch. Publishing the page then makes it live.
   `intent=discard` deletes the draft assets and files.

The hourly `0 * * * *` sweep (`POST /resources/jobs/hero-video` with an empty
body) re-drives a request that was never woken or whose render went quiet for 10
minutes, and fails one that used its 3 attempts.

## Reduced motion

A hero with a `videoPoster` is rendered without a video `src` and without
`autoplay`. `apps/sites/src/lib/hero-video-client.ts` gives the video its source
only when `prefers-reduced-motion` is not `reduce`, and removes it again if the
setting changes. A guest who prefers reduced motion (and a page without script)
sees the poster still and downloads no video. A hero video without a poster
keeps its source and is paused for such a guest.

## Limits

| Limit       | Value                                           |
| ----------- | ----------------------------------------------- |
| Photos in   | 3 to 6, JPEG, PNG or WebP, at least 640 px wide |
| Clip        | 8 to 12 seconds, silent, loops, 1280x720        |
| Clip file   | at most 6 MB (about 2 Mbps for 12 s)            |
| Poster file | at most 600 KB                                  |
| Requests    | 5 per organization per 24 hours, one at a time  |

## Renderer adapter

`apps/app/app/utils/website/hero-video/renderer.server.ts`. The renderer only
ever sees the plan and short-lived read links to the restaurant's own photos;
there is no generative model in the path, so nothing that is not the
restaurant's appears in the clip.

- **`http`** (deployments): `HERO_VIDEO_RENDERER_URL` and
  `HERO_VIDEO_RENDERER_TOKEN` (a secret that differs from every other token).
  The App `POST`s JSON with `Authorization: Bearer <token>`:

  ```json
  {
  	"plan": {
  		"style": "slow_pans",
  		"durationS": 12,
  		"size": { "width": 1280, "height": 720 },
  		"loopCrossfadeS": 0.8,
  		"silent": true,
  		"posterShot": 0,
  		"shots": [
  			{
  				"index": 0,
  				"photo": 0,
  				"startS": 0,
  				"durationS": 3,
  				"from": { "x": 0.5, "y": 0.5, "zoom": 1 },
  				"to": { "x": 0.5, "y": 0.5, "zoom": 1.15 },
  				"transition": "none",
  				"transitionS": 0,
  				"warm": false
  			}
  		]
  	},
  	"stills": [
  		{
  			"url": "https://...",
  			"mimeType": "image/jpeg",
  			"width": 1600,
  			"height": 900
  		}
  	]
  }
  ```

  and expects JSON back:
  `{ "video": "<base64 mp4>", "poster": "<base64 jpeg>", "videoMimeType": "video/mp4", "posterMimeType": "image/jpeg" }`.
  The App re-checks the size limits and refuses anything larger. A service can
  render each shot with ffmpeg's `zoompan` (or `crop` + `scale` over time), join
  the shots with `xfade` for `crossfade` / `fade`, blend the last
  `loopCrossfadeS` seconds into the first for the loop, encode H.264 at
  `-b:v 1800k -maxrate 2000k -an -movflags +faststart`, and take the poster from
  the first frame.

- **`mock`**: `HERO_VIDEO_MOCK=true` (ignored unless `BASE_URL` is local) and
  every test. Returns a fixture clip and uses the first photo as the poster.

## Deploy order

App (migration `0070`, hero video routes and editor), then jobs-cron
(`HeroVideoWorkflow`, `hero-video` binding in `wrangler.jsonc`), then Sites
(poster and reduced-motion hero). Set `HERO_VIDEO_RENDERER_URL` and
`HERO_VIDEO_RENDERER_TOKEN` before turning the flag on for an organization.
