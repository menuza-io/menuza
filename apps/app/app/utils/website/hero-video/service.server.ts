import {
	buildStoryboard,
	checkStoryboard,
	HERO_VIDEO_MAX_BYTES,
	HERO_VIDEO_MAX_PER_DAY,
	HERO_VIDEO_MAX_PHOTOS,
	HERO_VIDEO_MIN_PHOTO_WIDTH,
	HERO_VIDEO_MIN_PHOTOS,
	HERO_VIDEO_SIZE,
	HERO_VIDEO_STALE_MS,
	heroVideoDuration,
	isHeroPhotoMime,
	isHeroVideoStyle,
	pickHeroPhotos,
	type HeroVideoError,
	type HeroVideoStyle,
	type PhotoCandidate,
} from '@repo/common/hero-video'
import {
	and,
	desc,
	db,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	or,
	sql,
	HeroVideoGeneration,
	Notification,
	Organization,
	OrganizationMediaAsset,
	OrganizationMediaTag,
	OrganizationMenuItem,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { ENV } from 'varlock/env'
import {
	getSignedGetRequestInfoAsync,
	deleteOrganizationStorageObject,
	getPresignedMediaUrl,
	uploadHeroVideoObject,
} from '#app/utils/storage.server.ts'
import { WEBSITE_ALERT_TYPES } from '../website-alerts.ts'
import { isWebsiteFlagOn } from '../website-flags.ts'
import {
	getHeroVideoRenderer,
	type HeroVideoRenderer,
	type RendererStill,
} from './renderer.server.ts'

/**
 * "Make a video from my photos" (#301), on the hero section.
 *
 * The operator picks 3 to 6 of the restaurant's own photos (or lets Menuza
 * choose, preferring the Featured tag) and a style. A background job (the
 * `HeroVideoWorkflow` in jobs-cron, plus its hourly sweep: no extra cron slot)
 * hands them to the renderer, stores the silent clip and its poster as media
 * assets in `draft` status, and tells the person who asked. Nothing on the
 * website changes until they accept the preview: accepting is what puts the
 * clip in the hero section. Drafts are private to the organization's members;
 * an accepted clip is a public, ready asset.
 */

export const HERO_VIDEO_FLAG = 'website.hero_video'
const MAX_ATTEMPTS = 3

export function heroVideoEnabled(organizationId: string) {
	return isWebsiteFlagOn(organizationId, HERO_VIDEO_FLAG)
}

export type HeroVideoDeps = {
	renderer?: HeroVideoRenderer | null
	now?: () => number
	wake?: (generationId: string) => Promise<boolean>
	/** Reads a stored photo's bytes. */
	readPhoto?: (asset: {
		objectKey: string
		organizationId: string
	}) => Promise<Uint8Array>
	/** A short-lived link the renderer reads a photo through. */
	presign?: (asset: {
		objectKey: string
		organizationId: string
	}) => Promise<string>
	store?: typeof uploadHeroVideoObject
	remove?: typeof deleteOrganizationStorageObject
}

/**
 * Asks jobs-cron to run `HeroVideoWorkflow`. The payload carries only the
 * generation id. Best effort: the hourly sweep re-drives a job that never
 * started.
 */
export async function wakeHeroVideoWorkflow(
	generationId: string,
): Promise<boolean> {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) return false
	try {
		const response = await fetch(
			`${workerUrl.replace(/\/$/u, '')}/workflows/hero-video/start`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ generationId }),
				signal: AbortSignal.timeout(5_000),
			},
		)
		return response.ok
	} catch {
		return false
	}
}

type Photo = {
	id: string
	objectKey: string
	organizationId: string
	mimeType: string
	width: number | null
	height: number | null
	status: string
	storageScope: string
	archivedAt: Date | null
}

async function loadPhotos(organizationId: string, ids: string[]) {
	if (ids.length === 0) return []
	const rows = await db
		.select({
			id: OrganizationMediaAsset.id,
			objectKey: OrganizationMediaAsset.objectKey,
			organizationId: OrganizationMediaAsset.organizationId,
			mimeType: OrganizationMediaAsset.mimeType,
			width: OrganizationMediaAsset.width,
			height: OrganizationMediaAsset.height,
			status: OrganizationMediaAsset.status,
			storageScope: OrganizationMediaAsset.storageScope,
			archivedAt: OrganizationMediaAsset.archivedAt,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				inArray(OrganizationMediaAsset.id, ids),
			),
		)
	const byId = new Map(rows.map((row) => [row.id, row as Photo]))
	return ids.map((id) => byId.get(id)).filter((p): p is Photo => Boolean(p))
}

/** Ready, image, not archived photos of the organization the automatic pick may use. */
async function autoPick(organizationId: string): Promise<string[]> {
	const assets = await db
		.select({
			id: OrganizationMediaAsset.id,
			objectKey: OrganizationMediaAsset.objectKey,
			mimeType: OrganizationMediaAsset.mimeType,
			width: OrganizationMediaAsset.width,
			height: OrganizationMediaAsset.height,
			createdAt: OrganizationMediaAsset.createdAt,
			source: OrganizationMediaAsset.source,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				eq(OrganizationMediaAsset.status, 'ready'),
				isNull(OrganizationMediaAsset.archivedAt),
			),
		)
		.orderBy(desc(OrganizationMediaAsset.createdAt))
		.limit(300)
	const photos = assets.filter(
		(asset) =>
			isHeroPhotoMime(asset.mimeType) &&
			// A generated clip's poster is not a source photo.
			asset.source !== 'hero-video' &&
			(asset.width === null || asset.width >= HERO_VIDEO_MIN_PHOTO_WIDTH),
	)
	if (photos.length === 0) return []
	const tagRows = await db
		.select({
			assetId: OrganizationMediaTag.assetId,
			tag: OrganizationMediaTag.tag,
		})
		.from(OrganizationMediaTag)
		.where(eq(OrganizationMediaTag.organizationId, organizationId))
	const tags = new Map<string, string[]>()
	for (const row of tagRows) {
		tags.set(row.assetId, [...(tags.get(row.assetId) ?? []), row.tag])
	}
	const dishes = await db
		.select({
			imageKey: OrganizationMenuItem.imageKey,
			imageKeys: OrganizationMenuItem.imageKeys,
		})
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.organizationId, organizationId))
		.limit(1000)
	const dishRefs = dishes
		.map((dish) => `${dish.imageKey ?? ''} ${dish.imageKeys}`)
		.join(' ')
	const candidates: PhotoCandidate[] = photos.map((asset) => ({
		id: asset.id,
		tags: tags.get(asset.id) ?? [],
		width: asset.width,
		height: asset.height,
		usedByDish:
			dishRefs.includes(asset.id) || dishRefs.includes(asset.objectKey),
		createdAt: asset.createdAt.getTime(),
	}))
	return pickHeroPhotos(candidates)
}

export type StartInput = {
	organizationId: string
	userId: string
	style: unknown
	/** The photos the operator chose; omit with `auto` to let Menuza choose. */
	photoAssetIds?: string[]
	auto?: boolean
	/** The page whose hero this is for; the notification opens it. */
	pageId?: string | null
}

export async function startHeroVideo(
	input: StartInput,
	deps: HeroVideoDeps = {},
): Promise<
	{ ok: true; generationId: string } | { ok: false; error: HeroVideoError }
> {
	const now = deps.now?.() ?? Date.now()
	if (!(await heroVideoEnabled(input.organizationId))) {
		return { ok: false, error: 'hero_video_disabled' }
	}
	const renderer =
		deps.renderer === undefined ? getHeroVideoRenderer() : deps.renderer
	if (!renderer) return { ok: false, error: 'renderer_not_configured' }
	if (!isHeroVideoStyle(input.style))
		return { ok: false, error: 'invalid_style' }
	const style: HeroVideoStyle = input.style

	let ids: string[]
	if (input.auto) {
		ids = await autoPick(input.organizationId)
		if (ids.length < HERO_VIDEO_MIN_PHOTOS) {
			return { ok: false, error: 'not_enough_photos' }
		}
	} else {
		ids = [...new Set(input.photoAssetIds ?? [])]
		if (ids.length < HERO_VIDEO_MIN_PHOTOS) {
			return { ok: false, error: 'not_enough_photos' }
		}
		if (ids.length > HERO_VIDEO_MAX_PHOTOS) {
			return { ok: false, error: 'too_many_photos' }
		}
		// Only this organization's own media: a foreign or unknown id refuses it.
		const photos = await loadPhotos(input.organizationId, ids)
		if (photos.length !== ids.length)
			return { ok: false, error: 'invalid_photos' }
		if (photos.some((photo) => !isHeroPhotoMime(photo.mimeType))) {
			return { ok: false, error: 'invalid_photos' }
		}
		if (photos.some((photo) => photo.archivedAt !== null)) {
			return { ok: false, error: 'invalid_photos' }
		}
		if (photos.some((photo) => photo.status !== 'ready')) {
			return { ok: false, error: 'asset_not_ready' }
		}
	}

	const since = new Date(now - 24 * 60 * 60 * 1000)
	const recent = await db
		.select({
			id: HeroVideoGeneration.id,
			status: HeroVideoGeneration.status,
			updatedAt: HeroVideoGeneration.updatedAt,
		})
		.from(HeroVideoGeneration)
		.where(
			and(
				eq(HeroVideoGeneration.organizationId, input.organizationId),
				gte(HeroVideoGeneration.createdAt, since),
			),
		)
	if (recent.length >= HERO_VIDEO_MAX_PER_DAY) {
		return { ok: false, error: 'daily_limit' }
	}
	if (
		recent.some(
			(row) =>
				(row.status === 'queued' || row.status === 'rendering') &&
				now - row.updatedAt.getTime() < HERO_VIDEO_STALE_MS * 3,
		)
	) {
		return { ok: false, error: 'already_running' }
	}

	const [created] = await db
		.insert(HeroVideoGeneration)
		.values({
			organizationId: input.organizationId,
			requestedById: input.userId,
			style,
			photoAssetIds: JSON.stringify(ids),
			selection: input.auto ? 'auto' : 'picked',
			durationSeconds: heroVideoDuration(style, ids.length),
			status: 'queued',
			createdAt: new Date(now),
			// Where to take the person when it is ready.
			pageId: input.pageId ?? null,
		})
		.returning({ id: HeroVideoGeneration.id })
	await (deps.wake ?? wakeHeroVideoWorkflow)(created!.id).catch(() => false)
	return { ok: true, generationId: created!.id }
}

async function defaultReadPhoto(asset: {
	objectKey: string
	organizationId: string
}) {
	const { url, headers } = await getSignedGetRequestInfoAsync(
		asset.objectKey,
		asset.organizationId,
	)
	const response = await fetch(url, { headers })
	if (!response.ok) throw new Error('photo_unreadable')
	return new Uint8Array(await response.arrayBuffer())
}

async function tell(
	generation: {
		id: string
		organizationId: string
		requestedById: string | null
		pageId: string | null
	},
	type: (typeof WEBSITE_ALERT_TYPES)[keyof typeof WEBSITE_ALERT_TYPES],
) {
	if (!generation.requestedById) return
	const [org] = await db
		.select({ slug: Organization.slug })
		.from(Organization)
		.where(eq(Organization.id, generation.organizationId))
		.limit(1)
	if (!org) return
	const pageId = generation.pageId
	await db
		.insert(Notification)
		.values({
			userId: generation.requestedById,
			organizationId: generation.organizationId,
			type,
			entityId: generation.id,
			payload: JSON.stringify({ orgSlug: org.slug, pageId }),
		})
		.onConflictDoNothing()
}

export type ProcessOutcome =
	| { ok: true; status: 'ready' }
	| {
			ok: false
			status?: string
			error: HeroVideoError | 'skipped' | 'not_found'
	  }

/**
 * Renders one request: claims it, hands the chosen photos to the renderer,
 * stores the clip and poster as DRAFT media assets (private, not attachable)
 * linked to the first photo as their original, and tells the requester. Any
 * failure leaves the website untouched and marks the request failed.
 */
export async function processHeroVideo(
	generationId: string,
	deps: HeroVideoDeps = {},
): Promise<ProcessOutcome> {
	const now = deps.now?.() ?? Date.now()
	const stale = new Date(now - HERO_VIDEO_STALE_MS)
	// One caller wins the job; a rendering one that went quiet is taken over.
	const [claimed] = await db
		.update(HeroVideoGeneration)
		.set({
			status: 'rendering',
			startedAt: new Date(now),
			attempts: sql`${HeroVideoGeneration.attempts} + 1`,
		})
		.where(
			and(
				eq(HeroVideoGeneration.id, generationId),
				lt(HeroVideoGeneration.attempts, MAX_ATTEMPTS),
				or(
					eq(HeroVideoGeneration.status, 'queued'),
					and(
						eq(HeroVideoGeneration.status, 'rendering'),
						lt(HeroVideoGeneration.startedAt, stale),
					),
				),
			),
		)
		.returning()
	if (!claimed) {
		const [row] = await db
			.select({ status: HeroVideoGeneration.status })
			.from(HeroVideoGeneration)
			.where(eq(HeroVideoGeneration.id, generationId))
			.limit(1)
		return row
			? { ok: false, status: row.status, error: 'skipped' }
			: { ok: false, error: 'not_found' }
	}
	const fail = async (error: HeroVideoError) => {
		await db
			.update(HeroVideoGeneration)
			.set({ status: 'failed', error, completedAt: new Date(now) })
			.where(eq(HeroVideoGeneration.id, generationId))
		await tell({ ...claimed }, WEBSITE_ALERT_TYPES.heroVideoFailed)
		return { ok: false as const, status: 'failed', error }
	}

	const renderer =
		deps.renderer === undefined ? getHeroVideoRenderer() : deps.renderer
	if (!renderer) return fail('renderer_not_configured')
	let ids: string[]
	try {
		ids = JSON.parse(claimed.photoAssetIds) as string[]
	} catch {
		return fail('invalid_photos')
	}
	// Re-check at render time: only this organization's ready photos, still there.
	const photos = await loadPhotos(claimed.organizationId, ids)
	if (
		photos.length !== ids.length ||
		photos.length < HERO_VIDEO_MIN_PHOTOS ||
		photos.some((p) => !isHeroPhotoMime(p.mimeType) || p.status !== 'ready')
	) {
		return fail('invalid_photos')
	}
	const style = claimed.style
	if (!isHeroVideoStyle(style)) return fail('invalid_style')
	const plan = buildStoryboard({ style, photoCount: photos.length })
	if (checkStoryboard(plan)) return fail('renderer_failed')

	let stills: RendererStill[]
	try {
		stills = await Promise.all(
			photos.map(async (photo) => ({
				url: await (deps.presign ?? defaultPresign)(photo),
				mimeType: photo.mimeType,
				width: photo.width,
				height: photo.height,
				bytes: await (deps.readPhoto ?? defaultReadPhoto)(photo),
			})),
		)
	} catch {
		return fail('invalid_photos')
	}
	const rendered = await renderer.render({ plan, stills })
	if (!rendered.ok) return fail(rendered.error)

	const store = deps.store ?? uploadHeroVideoObject
	const remove = deps.remove ?? deleteOrganizationStorageObject
	let videoKey: string | null = null
	let posterKey: string | null = null
	try {
		videoKey = await store({
			organizationId: claimed.organizationId,
			bytes: rendered.video,
			mimeType: rendered.videoMimeType,
			extension: rendered.videoMimeType === 'video/webm' ? 'webm' : 'mp4',
		})
		posterKey = await store({
			organizationId: claimed.organizationId,
			bytes: rendered.poster,
			mimeType: rendered.posterMimeType,
			extension:
				rendered.posterMimeType === 'image/png'
					? 'png'
					: rendered.posterMimeType === 'image/webp'
						? 'webp'
						: 'jpg',
			suffix: '-poster',
		})
		const original = photos[0]!
		const [video] = await db
			.insert(OrganizationMediaAsset)
			.values({
				organizationId: claimed.organizationId,
				objectKey: videoKey,
				mimeType: rendered.videoMimeType,
				fileName: `Hero video (${style}).mp4`,
				fileSize: rendered.video.byteLength,
				width: HERO_VIDEO_SIZE.width,
				height: HERO_VIDEO_SIZE.height,
				// Labelled in the library as made by Menuza, linked to its first photo.
				source: 'hero-video',
				status: 'draft',
				parentAssetId: original.id,
				createdById: claimed.requestedById,
			})
			.returning({ id: OrganizationMediaAsset.id })
		const [poster] = await db
			.insert(OrganizationMediaAsset)
			.values({
				organizationId: claimed.organizationId,
				objectKey: posterKey,
				mimeType: rendered.posterMimeType,
				fileName: 'Hero video poster',
				fileSize: rendered.poster.byteLength,
				width: HERO_VIDEO_SIZE.width,
				height: HERO_VIDEO_SIZE.height,
				source: 'hero-video',
				status: 'draft',
				parentAssetId: original.id,
				createdById: claimed.requestedById,
			})
			.returning({ id: OrganizationMediaAsset.id })
		await db
			.update(HeroVideoGeneration)
			.set({
				status: 'ready',
				videoAssetId: video!.id,
				posterAssetId: poster!.id,
				completedAt: new Date(now),
			})
			.where(eq(HeroVideoGeneration.id, generationId))
		await tell({ ...claimed }, WEBSITE_ALERT_TYPES.heroVideoReady)
		return { ok: true, status: 'ready' }
	} catch {
		// Nothing half-stored stays behind.
		for (const key of [videoKey, posterKey]) {
			if (key) await remove(key, claimed.organizationId).catch(() => {})
		}
		return fail('renderer_failed')
	}
}

async function defaultPresign(asset: {
	objectKey: string
	organizationId: string
}) {
	return getPresignedMediaUrl(asset.objectKey, asset.organizationId)
}

/**
 * The hourly sweep: re-drives a request that was never woken, or whose render
 * went quiet. Bounded; a request that reached its attempts is failed.
 */
export async function sweepHeroVideos(deps: HeroVideoDeps = {}) {
	const now = deps.now?.() ?? Date.now()
	const stale = new Date(now - HERO_VIDEO_STALE_MS)
	const rows = await db
		.select({
			id: HeroVideoGeneration.id,
			status: HeroVideoGeneration.status,
			attempts: HeroVideoGeneration.attempts,
			organizationId: HeroVideoGeneration.organizationId,
			requestedById: HeroVideoGeneration.requestedById,
			pageId: HeroVideoGeneration.pageId,
		})
		.from(HeroVideoGeneration)
		.where(
			and(
				or(
					eq(HeroVideoGeneration.status, 'queued'),
					eq(HeroVideoGeneration.status, 'rendering'),
				),
				lt(HeroVideoGeneration.updatedAt, stale),
			),
		)
		.limit(20)
	let driven = 0
	let failed = 0
	for (const row of rows) {
		if (row.attempts >= MAX_ATTEMPTS) {
			await db
				.update(HeroVideoGeneration)
				.set({
					status: 'failed',
					error: 'renderer_failed',
					completedAt: new Date(now),
				})
				.where(eq(HeroVideoGeneration.id, row.id))
			await tell(row, WEBSITE_ALERT_TYPES.heroVideoFailed)
			failed++
			continue
		}
		const outcome = await processHeroVideo(row.id, deps).catch(() => null)
		if (outcome) driven++
	}
	return { found: rows.length, driven, failed }
}

export type AcceptResult =
	| { ok: true; videoSrc: string; videoPoster: string }
	| { ok: false; error: 'not_found' | 'not_ready' }

/**
 * The operator accepts the preview: the clip and its poster become ready
 * (public) assets and the hero section of the page draft starts using them.
 * Until this runs, no section and no live page has changed.
 */
export async function acceptHeroVideo(input: {
	organizationId: string
	userId: string
	generationId: string
	sectionId: string
}): Promise<AcceptResult> {
	const [generation] = await db
		.select()
		.from(HeroVideoGeneration)
		.where(
			and(
				eq(HeroVideoGeneration.id, input.generationId),
				eq(HeroVideoGeneration.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!generation) return { ok: false, error: 'not_found' }
	if (generation.status !== 'ready') return { ok: false, error: 'not_ready' }
	const [section] = await db
		.select({
			id: WebsitePageSection.id,
			type: WebsitePageSection.type,
			config: WebsitePageSection.config,
			pageId: WebsitePageSection.pageId,
		})
		.from(WebsitePageSection)
		.innerJoin(WebsitePage, eq(WebsitePageSection.pageId, WebsitePage.id))
		.where(
			and(
				eq(WebsitePageSection.id, input.sectionId),
				eq(WebsitePage.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!section || section.type !== 'hero')
		return { ok: false, error: 'not_found' }
	const assets = await db
		.select({
			id: OrganizationMediaAsset.id,
			objectKey: OrganizationMediaAsset.objectKey,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, input.organizationId),
				inArray(
					OrganizationMediaAsset.id,
					[generation.videoAssetId, generation.posterAssetId].filter(
						(id): id is string => Boolean(id),
					),
				),
			),
		)
	const video = assets.find((a) => a.id === generation.videoAssetId)
	const poster = assets.find((a) => a.id === generation.posterAssetId)
	if (!video || !poster) return { ok: false, error: 'not_ready' }

	const videoSrc = `/resources/videos/source?objectKey=${encodeURIComponent(video.objectKey)}`
	const videoPoster = `/resources/images?objectKey=${encodeURIComponent(poster.objectKey)}`
	let config: Record<string, unknown> = {}
	try {
		config = JSON.parse(section.config) as Record<string, unknown>
	} catch {
		config = {}
	}
	const next = {
		...config,
		assetType: 'video',
		videoSrc,
		videoPoster,
		// A generated clip is silent, loops and plays on its own.
		videoAutoPlay: true,
		videoLoop: true,
		videoMuted: true,
		videoControls: false,
	}
	const acceptedAt = new Date()
	await db.batch([
		db
			.update(OrganizationMediaAsset)
			.set({ status: 'ready' })
			.where(inArray(OrganizationMediaAsset.id, [video.id, poster.id])),
		db
			.update(HeroVideoGeneration)
			.set({ status: 'accepted', acceptedAt, acceptedById: input.userId })
			.where(eq(HeroVideoGeneration.id, generation.id)),
		db
			.update(WebsitePageSection)
			.set({ config: JSON.stringify(next) })
			.where(eq(WebsitePageSection.id, section.id)),
		db
			.update(WebsitePage)
			.set({ generatedBy: null })
			.where(eq(WebsitePage.id, section.pageId)),
	] as never)
	return { ok: true, videoSrc, videoPoster }
}

/** The operator throws the preview away: its draft files go too. */
export async function discardHeroVideo(
	input: { organizationId: string; generationId: string },
	deps: Pick<HeroVideoDeps, 'remove'> = {},
) {
	const [generation] = await db
		.select()
		.from(HeroVideoGeneration)
		.where(
			and(
				eq(HeroVideoGeneration.id, input.generationId),
				eq(HeroVideoGeneration.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!generation) return { ok: false as const, error: 'not_found' as const }
	if (generation.status === 'accepted' || generation.status === 'rendering') {
		return { ok: false as const, error: 'not_ready' as const }
	}
	const remove = deps.remove ?? deleteOrganizationStorageObject
	const ids = [generation.videoAssetId, generation.posterAssetId].filter(
		(id): id is string => Boolean(id),
	)
	if (ids.length) {
		const assets = await db
			.select({
				id: OrganizationMediaAsset.id,
				objectKey: OrganizationMediaAsset.objectKey,
			})
			.from(OrganizationMediaAsset)
			.where(
				and(
					inArray(OrganizationMediaAsset.id, ids),
					// Only drafts: an accepted asset is in use.
					eq(OrganizationMediaAsset.status, 'draft'),
				),
			)
		await db.delete(OrganizationMediaAsset).where(
			inArray(
				OrganizationMediaAsset.id,
				assets.map((a) => a.id),
			),
		)
		for (const asset of assets) {
			await remove(asset.objectKey, input.organizationId).catch(() => {})
		}
	}
	await db
		.update(HeroVideoGeneration)
		.set({ status: 'discarded', videoAssetId: null, posterAssetId: null })
		.where(eq(HeroVideoGeneration.id, generation.id))
	return { ok: true as const }
}

/** The recent requests of an organization, with preview links, and today's use. */
export async function listHeroVideos(organizationId: string, now = Date.now()) {
	const rows = await db
		.select()
		.from(HeroVideoGeneration)
		.where(eq(HeroVideoGeneration.organizationId, organizationId))
		.orderBy(desc(HeroVideoGeneration.createdAt))
		.limit(10)
	const ids = rows.flatMap((row) =>
		[row.videoAssetId, row.posterAssetId].filter((id): id is string =>
			Boolean(id),
		),
	)
	const assets = ids.length
		? await db
				.select({
					id: OrganizationMediaAsset.id,
					objectKey: OrganizationMediaAsset.objectKey,
				})
				.from(OrganizationMediaAsset)
				.where(inArray(OrganizationMediaAsset.id, ids))
		: []
	const keyOf = new Map(assets.map((asset) => [asset.id, asset.objectKey]))
	const since = now - 24 * 60 * 60 * 1000
	return {
		limit: HERO_VIDEO_MAX_PER_DAY,
		usedToday: rows.filter((row) => row.createdAt.getTime() >= since).length,
		maxBytes: HERO_VIDEO_MAX_BYTES,
		generations: rows.map((row) => {
			const videoKey = row.videoAssetId ? keyOf.get(row.videoAssetId) : null
			const posterKey = row.posterAssetId ? keyOf.get(row.posterAssetId) : null
			return {
				id: row.id,
				style: row.style,
				status: row.status,
				durationSeconds: row.durationSeconds,
				createdAt: row.createdAt.toISOString(),
				error:
					row.status === 'failed' ? (row.error ?? 'renderer_failed') : null,
				videoUrl: videoKey
					? `/resources/videos/source?objectKey=${encodeURIComponent(videoKey)}`
					: null,
				posterUrl: posterKey
					? `/resources/images?objectKey=${encodeURIComponent(posterKey)}`
					: null,
			}
		}),
	}
}
