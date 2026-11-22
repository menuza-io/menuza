import {
	generateObject,
	type GenerateObjectFileMediaType,
} from '@repo/ai/server'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	combinePhotoQuality,
	hasLowResolution,
	parsePhotoQualityModelOutput,
	PHOTO_QUALITY_BATCH_SIZE,
	PHOTO_QUALITY_DAILY_LIMIT,
	PHOTO_QUALITY_ISSUE_KEYS,
	PHOTO_QUALITY_MAX_ATTEMPTS,
	type PhotoQualityIssue,
} from '@repo/common/photo-quality'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	isNull,
	lt,
	OrganizationMediaAsset,
	sql,
} from '@repo/database'
import { isLocalUrl } from '@repo/security/local-host'
import { detectRasterImage } from '@repo/storage'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { checkRateLimit } from '#app/utils/rate-limit.server.ts'
import { isMediaFlagOn, MEDIA_FLAG_KEYS } from './media-flags.ts'
import { readStoredMediaImage } from './photo-studio.server.ts'

/**
 * Photo quality scores (#145). A background job gives each library image a
 * 0 to 100 score and plain issues from a fixed list. Advisory only: nothing
 * here blocks saving or publishing. Business media in the control plane; a
 * guest's photo (`source = 'guest-photo'`) is never read.
 *
 * - Resolution under 800 px on the short side is an issue on its own, found
 *   from the stored dimensions (or the file header) without any model, and
 *   such a photo is not sent to the model.
 * - A model answer that does not parse is no answer: the photo stays unscored
 *   (no penalty) and is tried once more.
 * - 200 model analyses per organization per day; a backfill of old images is
 *   paced by the batch size and the workflow's pauses.
 */

/** Sources a person put in the library on purpose. */
export const PHOTO_QUALITY_SOURCES = [
	'library',
	'ai-studio',
	'phone',
	'restyle',
] as const

export type PhotoQualityAnalyzer = {
	name: 'model' | 'mock'
	/** `null` when no usable answer came back. */
	analyze(image: {
		data: Uint8Array
		mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
	}): Promise<{ score: number; issues: PhotoQualityIssue[] } | null>
}

const ModelResultSchema = z.object({
	score: z.number().min(0).max(100),
	issues: z.array(z.enum(PHOTO_QUALITY_ISSUE_KEYS)).max(5),
})

const SYSTEM_PROMPT = [
	'You judge photos of restaurant dishes for an online menu.',
	'Give a score from 0 to 100 for how well the photo would sell the dish: good light, sharp focus, the whole dish in frame, appetizing.',
	'List only the problems that really apply, from this fixed list: too_dark (underexposed), blurry (out of focus or motion blur), dish_cut_off (the dish is cropped at the edge of the frame), low_resolution (visibly pixelated), not_food (the picture is not a dish or drink).',
	'Answer with JSON only.',
].join(' ')

export function isPhotoQualityMock(): boolean {
	const flag = ['1', 'true', 'on', 'yes']
	return (
		(flag.includes(readLiveEnv('PHOTO_QUALITY_MOCK').toLowerCase()) ||
			flag.includes(readLiveEnv('MOCKS').toLowerCase())) &&
		isLocalUrl(readLiveEnv('BASE_URL'))
	)
}

/**
 * A deterministic emulator: no model, no network. The score follows the file
 * size so tests and local runs see a spread; `mode` forces an outcome.
 */
export function createMockPhotoQualityAnalyzer(
	mode: { fail?: boolean; score?: number; issues?: PhotoQualityIssue[] } = {},
): PhotoQualityAnalyzer & { calls: number } {
	const analyzer = {
		name: 'mock' as const,
		calls: 0,
		async analyze(image: { data: Uint8Array }) {
			analyzer.calls += 1
			if (mode.fail) return null
			if (typeof mode.score === 'number') {
				return { score: mode.score, issues: mode.issues ?? [] }
			}
			return {
				score: 40 + (image.data.byteLength % 60),
				issues: mode.issues ?? [],
			}
		},
	}
	return analyzer
}

function createModelPhotoQualityAnalyzer(): PhotoQualityAnalyzer {
	return {
		name: 'model',
		async analyze(image) {
			try {
				const result = await generateObject({
					schema: ModelResultSchema,
					system: SYSTEM_PROMPT,
					prompt: 'Score this dish photo.',
					files: [
						{
							data: image.data,
							mediaType: image.mediaType as GenerateObjectFileMediaType,
						},
					],
					abortSignal: AbortSignal.timeout(60_000),
				})
				// The model's own answer is parsed again, strictly: anything that is
				// not a score and known issue keys is no answer.
				return parsePhotoQualityModelOutput(result)
			} catch (error) {
				console.error('Photo quality analysis failed:', error)
				return null
			}
		},
	}
}

/** The analyzer to use, or null when no model is set up. */
export function getPhotoQualityAnalyzer(): PhotoQualityAnalyzer | null {
	if (isPhotoQualityMock()) return createMockPhotoQualityAnalyzer()
	if (!readLiveEnv('GOOGLE_GENERATIVE_AI_API_KEY')) return null
	return createModelPhotoQualityAnalyzer()
}

export async function isPhotoQualityEnabled(organizationId: string) {
	return isMediaFlagOn(
		await getFeatureFlag(MEDIA_FLAG_KEYS.photoQuality, { organizationId }),
	)
}

/** Asks jobs-cron to run `PhotoQualityWorkflow`. Best effort: the hourly sweep re-drives. */
export async function wakePhotoQualityWorkflow(
	organizationId: string,
): Promise<boolean> {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) return false
	try {
		const response = await fetch(
			`${workerUrl.replace(/\/$/u, '')}/workflows/photo-quality/start`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ organizationId }),
				signal: AbortSignal.timeout(5_000),
			},
		)
		return response.ok
	} catch {
		return false
	}
}

/** A replaced or edited image is a different picture: score and crop start over. */
export const RESET_PHOTO_QUALITY = {
	qualityScore: null,
	qualityIssues: null,
	qualityAttempts: 0,
	analyzedAt: null,
} as const

const PENDING = (organizationId: string) =>
	and(
		eq(OrganizationMediaAsset.organizationId, organizationId),
		isNull(OrganizationMediaAsset.analyzedAt),
		lt(OrganizationMediaAsset.qualityAttempts, PHOTO_QUALITY_MAX_ATTEMPTS),
		isNull(OrganizationMediaAsset.archivedAt),
		eq(OrganizationMediaAsset.status, 'ready'),
		inArray(OrganizationMediaAsset.source, [...PHOTO_QUALITY_SOURCES]),
		sql`substr(${OrganizationMediaAsset.mimeType}, 1, 6) = 'image/'`,
		// A guest's photo is never analyzed here, whatever its source says.
		sql`substr(coalesce(${OrganizationMediaAsset.fileName}, ''), 1, 12) <> 'guest-photo-'`,
	)

export type PhotoQualityDeps = {
	analyzer?: PhotoQualityAnalyzer | null
	readImage?: typeof readStoredMediaImage
	now?: () => Date
	/** Spends one of the organization's daily analyses; false when used up. */
	spend?: (organizationId: string) => Promise<boolean>
	flagOn?: (organizationId: string) => Promise<boolean>
}

async function spendAnalysis(organizationId: string) {
	const limit = await checkRateLimit(
		{ type: 'org', value: organizationId },
		{
			scope: 'photo-quality',
			maxRequests: PHOTO_QUALITY_DAILY_LIMIT,
			windowMs: 24 * 60 * 60 * 1000,
		},
	)
	return limit.allowed
}

export type PhotoQualityBatch = {
	processed: number
	remaining: number
	limited: boolean
}

/**
 * Analyzes up to `PHOTO_QUALITY_BATCH_SIZE` pending images of one
 * organization. Safe to call twice at once: a photo is only ever written with
 * the facts it was read with.
 */
export async function processPhotoQualityForOrganization(
	organizationId: string,
	deps: PhotoQualityDeps = {},
): Promise<PhotoQualityBatch> {
	const now = deps.now ?? (() => new Date())
	const flagOn = deps.flagOn ?? isPhotoQualityEnabled
	if (!(await flagOn(organizationId))) {
		return { processed: 0, remaining: 0, limited: false }
	}
	const analyzer =
		deps.analyzer === undefined ? getPhotoQualityAnalyzer() : deps.analyzer
	const readImage = deps.readImage ?? readStoredMediaImage
	const spend = deps.spend ?? spendAnalysis

	const rows = await db
		.select({
			id: OrganizationMediaAsset.id,
			objectKey: OrganizationMediaAsset.objectKey,
			storageScope: OrganizationMediaAsset.storageScope,
			organizationId: OrganizationMediaAsset.organizationId,
			width: OrganizationMediaAsset.width,
			height: OrganizationMediaAsset.height,
			attempts: OrganizationMediaAsset.qualityAttempts,
		})
		.from(OrganizationMediaAsset)
		.where(PENDING(organizationId))
		.orderBy(asc(OrganizationMediaAsset.createdAt))
		.limit(PHOTO_QUALITY_BATCH_SIZE)

	let processed = 0
	let limited = false
	for (const row of rows) {
		let width = row.width
		let height = row.height
		let model: Awaited<ReturnType<PhotoQualityAnalyzer['analyze']>> = null
		let failed = false

		const small = hasLowResolution(width, height)
		let image: Awaited<ReturnType<typeof readStoredMediaImage>> | null = null
		if (!small || width === null || height === null) {
			try {
				image = await readImage(row)
				if (width === null || height === null) {
					const bytes = image.data
					const detected = detectRasterImage(
						bytes.buffer.slice(
							bytes.byteOffset,
							bytes.byteOffset + bytes.byteLength,
						) as ArrayBuffer,
					)
					if (detected) {
						width = detected.width
						height = detected.height
					}
				}
			} catch (error) {
				// A format the model cannot read (GIF, AVIF) or a file we cannot load:
				// the dimensions still say whether it is small, but there is no score.
				console.error('Photo quality could not read an image:', {
					assetId: row.id,
					error: error instanceof Error ? error.message : 'unknown',
				})
				failed = true
			}
		}

		const isSmall = hasLowResolution(width, height)
		// Without a model only the resolution can be judged: a photo that is not
		// small stays waiting (a key added later scores it) instead of being
		// closed as "analyzed" with no score.
		if (!analyzer && !isSmall) continue
		// A small photo is flagged without the model; spend a daily analysis only
		// on a photo the model will actually see.
		if (image && analyzer && !isSmall) {
			if (!(await spend(organizationId))) {
				limited = true
				break
			}
			model = await analyzer.analyze({
				data: image.data,
				mediaType: image.mediaType as 'image/jpeg' | 'image/png' | 'image/webp',
			})
			if (!model) failed = true
		}

		const result = combinePhotoQuality({ width, height, model })
		const attempts = row.attempts + (failed ? 1 : 0)
		// A failed model call leaves the photo unscored and is retried once; a
		// photo that cannot be scored at all ends the same way after that.
		const finished = !failed || attempts >= PHOTO_QUALITY_MAX_ATTEMPTS
		await db
			.update(OrganizationMediaAsset)
			.set({
				width,
				height,
				qualityScore: result.score,
				qualityIssues: JSON.stringify(result.issues),
				qualityAttempts: attempts,
				analyzedAt: finished ? now() : null,
			})
			.where(
				and(
					eq(OrganizationMediaAsset.id, row.id),
					eq(OrganizationMediaAsset.organizationId, organizationId),
					isNull(OrganizationMediaAsset.analyzedAt),
					// The file is the one we read: a replace in between starts over.
					eq(OrganizationMediaAsset.objectKey, row.objectKey),
				),
			)
		processed += 1
	}

	const [remaining] = await db
		.select({ n: sql<number>`count(*)` })
		.from(OrganizationMediaAsset)
		.where(PENDING(organizationId))
	return {
		processed,
		remaining: Number(remaining?.n ?? 0),
		limited,
	}
}

/**
 * The hourly sweep: organizations with the flag on and images waiting. Bounded
 * work per call; the next hour continues.
 */
export async function sweepPhotoQuality(
	deps: PhotoQualityDeps & {
		wake?: (organizationId: string) => Promise<boolean>
	} = {},
) {
	const rows = await db
		.selectDistinct({ organizationId: OrganizationMediaAsset.organizationId })
		.from(OrganizationMediaAsset)
		.where(
			and(
				isNull(OrganizationMediaAsset.analyzedAt),
				lt(OrganizationMediaAsset.qualityAttempts, PHOTO_QUALITY_MAX_ATTEMPTS),
				isNull(OrganizationMediaAsset.archivedAt),
				eq(OrganizationMediaAsset.status, 'ready'),
				inArray(OrganizationMediaAsset.source, [...PHOTO_QUALITY_SOURCES]),
				sql`substr(${OrganizationMediaAsset.mimeType}, 1, 6) = 'image/'`,
			),
		)
		.limit(100)
	const flagOn = deps.flagOn ?? isPhotoQualityEnabled
	const wake = deps.wake ?? wakePhotoQualityWorkflow
	let woken = 0
	for (const { organizationId } of rows.slice(0, 25)) {
		if (!(await flagOn(organizationId))) continue
		// The workflow does the paced work; when it cannot be reached, do one
		// batch here so the sweep alone still makes progress.
		if (await wake(organizationId)) woken += 1
		else await processPhotoQualityForOrganization(organizationId, deps)
	}
	return { organizations: rows.length, woken }
}
