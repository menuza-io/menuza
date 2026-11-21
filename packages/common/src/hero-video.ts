/**
 * A short hero video made from the restaurant's own photos (#301). Pure: the
 * App stores the request and the result, a renderer adapter makes the clip,
 * and this decides what is allowed and what the clip shows.
 *
 * - 3 to 6 of the restaurant's OWN photos in; a silent, looping clip of 8 to
 *   12 seconds out, sized for the hero, with a poster frame. Pan and zoom
 *   compositing of those stills only: no generated people or food.
 * - Limits keep the page fast: size, bitrate, a number of generations a day.
 * - The live hero never changes until the operator accepts the preview.
 */

export const HERO_VIDEO_STYLES = [
	'slow_pans',
	'quick_cuts',
	'warm_fade',
] as const
export type HeroVideoStyle = (typeof HERO_VIDEO_STYLES)[number]

export function isHeroVideoStyle(value: unknown): value is HeroVideoStyle {
	return (
		typeof value === 'string' &&
		(HERO_VIDEO_STYLES as readonly string[]).includes(value)
	)
}

export const HERO_VIDEO_MIN_PHOTOS = 3
export const HERO_VIDEO_MAX_PHOTOS = 6
export const HERO_VIDEO_MIN_SECONDS = 8
export const HERO_VIDEO_MAX_SECONDS = 12
/** Sized for the hero banner. */
export const HERO_VIDEO_SIZE = { width: 1280, height: 720 } as const
/** The page stays fast: a clip is held to this size and bitrate. */
export const HERO_VIDEO_MAX_BYTES = 6 * 1024 * 1024
export const HERO_VIDEO_MAX_BITRATE_KBPS = 2000
export const HERO_VIDEO_POSTER_MAX_BYTES = 600 * 1024
/** Generations an organization may start in 24 hours (a failed one counts). */
export const HERO_VIDEO_MAX_PER_DAY = 5
/** A queued or rendering job older than this is picked up again. */
export const HERO_VIDEO_STALE_MS = 10 * 60 * 1000

export const HERO_VIDEO_STATUSES = [
	'queued',
	'rendering',
	'ready',
	'failed',
	'accepted',
	'discarded',
] as const
export type HeroVideoStatus = (typeof HERO_VIDEO_STATUSES)[number]

export type HeroVideoError =
	| 'hero_video_disabled'
	| 'renderer_not_configured'
	| 'invalid_style'
	| 'not_enough_photos'
	| 'too_many_photos'
	| 'invalid_photos'
	| 'asset_not_ready'
	| 'daily_limit'
	| 'already_running'
	| 'not_found'
	| 'not_ready'
	| 'renderer_failed'
	| 'output_too_large'

/** The length of the clip: within 8 to 12 seconds for every style and photo count. */
export function heroVideoDuration(style: HeroVideoStyle, photoCount: number) {
	const n = Math.max(
		HERO_VIDEO_MIN_PHOTOS,
		Math.min(HERO_VIDEO_MAX_PHOTOS, photoCount),
	)
	const raw =
		style === 'quick_cuts' ? 8 : style === 'warm_fade' ? n * 2.5 : n * 3
	return Math.max(
		HERO_VIDEO_MIN_SECONDS,
		Math.min(HERO_VIDEO_MAX_SECONDS, Math.round(raw)),
	)
}

/** A camera position inside a photo: centre (0 to 1) and zoom (1 = the whole frame). */
export type CameraFrame = { x: number; y: number; zoom: number }

export type Shot = {
	index: number
	/** Which of the chosen photos, by position. */
	photo: number
	startS: number
	durationS: number
	from: CameraFrame
	to: CameraFrame
	/** How this shot starts after the one before it. */
	transition: 'none' | 'crossfade' | 'fade'
	transitionS: number
	/** A warm tint over the shot (the warm fade style). */
	warm: boolean
}

export type Storyboard = {
	style: HeroVideoStyle
	durationS: number
	size: typeof HERO_VIDEO_SIZE
	shots: Shot[]
	/** The end blends into the start, so the loop has no jump. */
	loopCrossfadeS: number
	silent: true
	/** Where the poster frame is taken: the first shot, at its start. */
	posterShot: 0
}

const round = (value: number) => Math.round(value * 1000) / 1000

/** The visible window (1 / zoom wide) never leaves the photo. */
function keepInside(frame: CameraFrame): CameraFrame {
	const half = 0.5 / frame.zoom
	const clamp = (value: number) => Math.min(Math.max(value, half), 1 - half)
	return {
		x: round(clamp(frame.x)),
		y: round(clamp(frame.y)),
		zoom: frame.zoom,
	}
}

/**
 * The plan of the clip. Deterministic (no randomness): the same photos and
 * style always give the same plan. A photo is only ever panned and zoomed
 * inside its own frame; nothing is added to it.
 */
export function buildStoryboard(input: {
	style: HeroVideoStyle
	photoCount: number
}): Storyboard {
	const n = Math.max(
		HERO_VIDEO_MIN_PHOTOS,
		Math.min(HERO_VIDEO_MAX_PHOTOS, input.photoCount),
	)
	const durationS = heroVideoDuration(input.style, n)
	// Quick cuts cycle through the photos until the clip is full.
	const shotCount = input.style === 'quick_cuts' ? n * 2 : n
	const each = durationS / shotCount
	const shots: Shot[] = []
	for (let i = 0; i < shotCount; i++) {
		const forward = i % 2 === 0
		const drift = (i % 3) - 1 // -1, 0, 1: which way the camera drifts
		let from: CameraFrame
		let to: CameraFrame
		if (input.style === 'quick_cuts') {
			from = { x: 0.5, y: 0.5, zoom: 1 }
			to = { x: 0.5 + 0.02 * drift, y: 0.5, zoom: 1.06 }
		} else if (input.style === 'warm_fade') {
			from = { x: 0.5, y: 0.5, zoom: forward ? 1 : 1.08 }
			to = { x: 0.5, y: 0.5, zoom: forward ? 1.08 : 1 }
		} else {
			const near: CameraFrame = { x: 0.5, y: 0.5, zoom: 1 }
			const far: CameraFrame = { x: 0.5 + 0.06 * drift, y: 0.5, zoom: 1.15 }
			from = forward ? near : far
			to = forward ? far : near
		}
		from = keepInside(from)
		to = keepInside(to)
		shots.push({
			index: i,
			photo: i % n,
			startS: round(i * each),
			durationS: round(each),
			from,
			to,
			transition:
				i === 0 || input.style === 'quick_cuts'
					? 'none'
					: input.style === 'warm_fade'
						? 'fade'
						: 'crossfade',
			transitionS:
				i === 0 || input.style === 'quick_cuts'
					? 0
					: round(Math.min(each / 2, input.style === 'warm_fade' ? 1.2 : 0.8)),
			warm: input.style === 'warm_fade',
		})
	}
	return {
		style: input.style,
		durationS,
		size: HERO_VIDEO_SIZE,
		shots,
		loopCrossfadeS:
			input.style === 'quick_cuts' ? 0 : round(Math.min(each / 2, 0.8)),
		silent: true,
		posterShot: 0,
	}
}

export type StoryboardError = 'duration' | 'photos' | 'timing' | 'size'

/** A plan a renderer may be asked to make. */
export function checkStoryboard(plan: Storyboard): StoryboardError | null {
	if (
		plan.durationS < HERO_VIDEO_MIN_SECONDS ||
		plan.durationS > HERO_VIDEO_MAX_SECONDS
	) {
		return 'duration'
	}
	const photos = new Set(plan.shots.map((shot) => shot.photo))
	if (
		photos.size < HERO_VIDEO_MIN_PHOTOS ||
		photos.size > HERO_VIDEO_MAX_PHOTOS
	) {
		return 'photos'
	}
	const total = plan.shots.reduce((sum, shot) => sum + shot.durationS, 0)
	if (Math.abs(total - plan.durationS) > 0.05) return 'timing'
	if (
		plan.size.width !== HERO_VIDEO_SIZE.width ||
		plan.size.height !== HERO_VIDEO_SIZE.height
	) {
		return 'size'
	}
	return null
}

export type PhotoCandidate = {
	id: string
	tags: readonly string[]
	width: number | null
	height: number | null
	/** A dish uses this photo (a dish photo). */
	usedByDish: boolean
	createdAt: number
}

const ROOM_TAGS = new Set([
	'room',
	'rooms',
	'interior',
	'dining',
	'dining room',
	'ambience',
	'ambiance',
])

/**
 * Menuza's own pick of 3 to 6 photos when the operator does not choose: the
 * ones tagged Featured first (#147), then room and dish photos, wide and large
 * ones before small, recent before old. Returns fewer than 3 when the library
 * has too few, so the caller can say so.
 */
export function pickHeroPhotos(
	candidates: readonly PhotoCandidate[],
	count = HERO_VIDEO_MAX_PHOTOS,
): string[] {
	const wanted = Math.max(
		HERO_VIDEO_MIN_PHOTOS,
		Math.min(HERO_VIDEO_MAX_PHOTOS, count),
	)
	const score = (photo: PhotoCandidate) => {
		let value = 0
		if (photo.tags.includes('featured')) value += 100
		if (photo.tags.some((tag) => ROOM_TAGS.has(tag))) value += 30
		if (photo.usedByDish) value += 20
		if (photo.width && photo.height) {
			if (photo.width >= photo.height) value += 10
			if (photo.width >= 1280) value += 10
		}
		return value
	}
	return [...candidates]
		.sort(
			(a, b) =>
				score(b) - score(a) ||
				b.createdAt - a.createdAt ||
				a.id.localeCompare(b.id),
		)
		.slice(0, wanted)
		.map((photo) => photo.id)
}

/** Photos below this are not offered: a hero clip would look soft. */
export const HERO_VIDEO_MIN_PHOTO_WIDTH = 640

export const HERO_PHOTO_MIME_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
] as const

export function isHeroPhotoMime(mime: string) {
	return (HERO_PHOTO_MIME_TYPES as readonly string[]).includes(mime)
}
