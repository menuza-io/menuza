import { createId } from '@paralleldrive/cuid2'
import {
	nextBudgetReset,
	restyleBudgetLeft,
	restyleDraftIsExpired,
	RESTYLE_BATCH_SIZE,
	RESTYLE_DRAFT_TTL_DAYS,
	RESTYLE_MAX_ATTEMPTS,
} from '@repo/common/media-restyle'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	isNull,
	lte,
	or,
	sql,
	MediaRestyleRun,
	MediaRestyleRunItem,
	OrganizationMediaAsset,
	OrganizationMenuItem,
} from '@repo/database'
import { detectRasterImage } from '@repo/storage'
import { readDishPhotoStates } from '#app/utils/menu/dish-photo.server.ts'
import {
	deleteOrganizationStorageObject,
	uploadOrganizationMediaFileOnly,
} from '#app/utils/storage.server.ts'
import {
	PHOTO_STUDIO_MAX_INPUT_BYTES,
	PhotoStudioInputError,
	readStoredMediaImage,
} from '../photo-studio.server.ts'
import { aspectRatioFor } from '../photo-studio.ts'
import { isTransientRestyleError } from './adapter.server.ts'
import {
	deleteDraftAsset,
	refreshRunCounters,
	restyledToday,
	uniqueRunIds,
} from './drafts.server.ts'
import {
	parseRunStyle,
	restyleAdapter,
	restyleKilled,
	restyleWake,
	type RestyleDeps,
} from './service.server.ts'

/** A claim nobody finished is taken over after this long. */
export const RESTYLE_CLAIM_STALE_MS = 10 * 60 * 1000
/** A running or pending run that made no move for this long is woken again. */
export const RESTYLE_RUN_IDLE_MS = 15 * 60 * 1000
const SWEEP_LIMIT = 20
const PRUNE_LIMIT = 100

export type RestyleProcessOutcome = {
	done: boolean
	paused: boolean
	resumeAt: Date | null
	/** Dishes that reached a final state in this call (drafted, failed, skipped). */
	processed: number
	/** Nothing moved and only passing problems were seen: the job should be retried. */
	retry?: true
}

const NOTHING = {
	done: false,
	paused: false,
	resumeAt: null,
	processed: 0,
} as const

function dishLabel(raw: string | undefined) {
	if (!raw) return 'dish'
	try {
		const parsed = JSON.parse(raw) as unknown
		if (parsed && typeof parsed === 'object') {
			const first = Object.values(parsed as Record<string, unknown>).find(
				(value) => typeof value === 'string' && value.trim(),
			)
			if (typeof first === 'string') return first
		}
	} catch {
		// plain text
	}
	return raw
}

async function defaultReadSource(asset: {
	objectKey: string
	storageScope: string
	organizationId: string
}) {
	return readStoredMediaImage(asset)
}

/**
 * Restyles the next dishes of a run (one job call, one small batch). It never
 * touches a live dish photo: each result is stored as a DRAFT library asset
 * (`source: 'restyle'`, linked to the original) and the run item points at it.
 *
 * - Claims pending items with a compare and set on `attempts`, so two callers
 *   never restyle the same dish; a claim nobody finished is taken over after
 *   10 minutes.
 * - Counts photos restyled today (UTC) across the organization's runs; at the
 *   daily budget the run pauses until the next UTC midnight.
 * - A passing problem (model busy, photo unreadable) puts the dish back for a
 *   retry while attempts are left; one that will not change fails it with a
 *   short machine reason.
 */
export async function processRestyleRun(
	runId: string,
	deps: RestyleDeps = {},
): Promise<RestyleProcessOutcome> {
	const nowMs = deps.now?.() ?? Date.now()
	const now = new Date(nowMs)
	const [run] = await db
		.select()
		.from(MediaRestyleRun)
		.where(eq(MediaRestyleRun.id, runId))
		.limit(1)
	if (!run) return { ...NOTHING, done: true }
	if (run.status === 'cancelled' || run.status === 'ready') {
		return { ...NOTHING, done: true }
	}
	// The kill switch stops new model calls at once; drafts stay reviewable.
	if (restyleKilled(deps)) return { ...NOTHING, paused: true }
	const adapter = restyleAdapter(deps)
	if (!adapter) return { ...NOTHING, paused: true }
	if (
		run.status === 'paused' &&
		run.resumeAt &&
		run.resumeAt.getTime() > nowMs
	) {
		return { ...NOTHING, paused: true, resumeAt: run.resumeAt }
	}
	const style = parseRunStyle(run.style)

	// A dish whose claims keep going stale is out of attempts: fail it.
	const stale = new Date(nowMs - RESTYLE_CLAIM_STALE_MS)
	await db
		.update(MediaRestyleRunItem)
		.set({ status: 'failed', error: 'attempts_exhausted' })
		.where(
			and(
				eq(MediaRestyleRunItem.runId, run.id),
				eq(MediaRestyleRunItem.status, 'pending'),
				sql`${MediaRestyleRunItem.attempts} >= ${RESTYLE_MAX_ATTEMPTS}`,
				lte(MediaRestyleRunItem.updatedAt, stale),
			),
		)

	const left = restyleBudgetLeft(await restyledToday(run.organizationId, now))
	if (left <= 0) {
		const state = await refreshRunCounters(run.id, now)
		return {
			done: state?.status === 'ready',
			paused: state?.status === 'paused',
			resumeAt: state?.resumeAt ?? nextBudgetReset(now),
			processed: 0,
		}
	}

	await db
		.update(MediaRestyleRun)
		.set({ status: 'running', resumeAt: null })
		.where(
			and(
				eq(MediaRestyleRun.id, run.id),
				inArray(MediaRestyleRun.status, ['pending', 'paused']),
			),
		)

	const candidates = await db
		.select()
		.from(MediaRestyleRunItem)
		.where(
			and(
				eq(MediaRestyleRunItem.runId, run.id),
				eq(MediaRestyleRunItem.status, 'pending'),
				sql`${MediaRestyleRunItem.attempts} < ${RESTYLE_MAX_ATTEMPTS}`,
				or(
					eq(MediaRestyleRunItem.attempts, 0),
					lte(MediaRestyleRunItem.updatedAt, stale),
				),
			),
		)
		.orderBy(asc(MediaRestyleRunItem.createdAt), asc(MediaRestyleRunItem.id))
		.limit(Math.min(RESTYLE_BATCH_SIZE, left))

	const claimed: Array<typeof MediaRestyleRunItem.$inferSelect> = []
	for (const candidate of candidates) {
		const [won] = await db
			.update(MediaRestyleRunItem)
			.set({
				attempts: sql`${MediaRestyleRunItem.attempts} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(MediaRestyleRunItem.id, candidate.id),
					eq(MediaRestyleRunItem.status, 'pending'),
					eq(MediaRestyleRunItem.attempts, candidate.attempts),
				),
			)
			.returning()
		if (won) claimed.push(won)
	}
	if (claimed.length === 0) {
		const state = await refreshRunCounters(run.id, now)
		return {
			done: state?.status === 'ready',
			paused: state?.status === 'paused',
			resumeAt: state?.resumeAt ?? null,
			processed: 0,
		}
	}

	const assets = new Map<
		string,
		{
			id: string
			objectKey: string
			storageScope: string
			organizationId: string
			width: number | null
			height: number | null
		}
	>()
	const sourceIds = claimed
		.map((item) => item.sourceAssetId)
		.filter((id): id is string => Boolean(id))
	if (sourceIds.length > 0) {
		const rows = await db
			.select({
				id: OrganizationMediaAsset.id,
				objectKey: OrganizationMediaAsset.objectKey,
				storageScope: OrganizationMediaAsset.storageScope,
				organizationId: OrganizationMediaAsset.organizationId,
				width: OrganizationMediaAsset.width,
				height: OrganizationMediaAsset.height,
			})
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, run.organizationId),
					inArray(OrganizationMediaAsset.id, sourceIds),
				),
			)
		for (const row of rows) assets.set(row.id, row)
	}
	const states = await readDishPhotoStates(
		run.organizationId,
		claimed.map((item) => item.itemId),
	)
	const names = new Map<string, string>()
	const nameRows = await db
		.select({
			id: OrganizationMenuItem.id,
			displayName: OrganizationMenuItem.displayName,
		})
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.organizationId, run.organizationId),
				inArray(
					OrganizationMenuItem.id,
					claimed.map((item) => item.itemId),
				),
			),
		)
	for (const row of nameRows) names.set(row.id, dishLabel(row.displayName))

	const readSource = deps.readSource ?? defaultReadSource
	const store = deps.store ?? uploadOrganizationMediaFileOnly
	const remove = deps.remove ?? deleteOrganizationStorageObject
	let processed = 0
	let passing = 0

	const finish = async (
		item: (typeof claimed)[number],
		values: Partial<typeof MediaRestyleRunItem.$inferInsert>,
	) => {
		await db
			.update(MediaRestyleRunItem)
			.set(values)
			.where(
				and(
					eq(MediaRestyleRunItem.id, item.id),
					eq(MediaRestyleRunItem.status, 'pending'),
				),
			)
		processed++
	}
	// A problem that may pass: back to the queue while attempts are left.
	const retryOrFail = async (item: (typeof claimed)[number], error: string) => {
		if (item.attempts >= RESTYLE_MAX_ATTEMPTS) {
			await finish(item, { status: 'failed', error })
			return
		}
		passing++
		await db
			.update(MediaRestyleRunItem)
			.set({ updatedAt: new Date(nowMs - RESTYLE_CLAIM_STALE_MS) })
			.where(
				and(
					eq(MediaRestyleRunItem.id, item.id),
					eq(MediaRestyleRunItem.status, 'pending'),
				),
			)
	}

	for (const item of claimed) {
		try {
			const source = item.sourceAssetId ? assets.get(item.sourceAssetId) : null
			if (!style || !item.sourceAssetKey || !source) {
				await finish(item, { status: 'failed', error: 'source_missing' })
				continue
			}
			// The dish changed its photo since the run started: the draft could
			// never be used, so no model call is spent on it.
			const state = states.get(item.itemId)
			if (!state || state.mainKey !== item.sourceAssetKey) {
				await finish(item, { status: 'skipped', skipReason: 'photo_changed' })
				continue
			}
			let photo
			try {
				photo = await readSource(source)
			} catch (error) {
				if (error instanceof PhotoStudioInputError) {
					await finish(item, { status: 'failed', error: 'unsupported_image' })
				} else {
					await retryOrFail(item, 'source_unreadable')
				}
				continue
			}
			const result = await adapter.restyle({
				organizationId: run.organizationId,
				userId: run.createdById ?? '',
				photo,
				style,
				aspectRatio: aspectRatioFor(source.width, source.height),
			})
			if (!result.ok) {
				if (isTransientRestyleError(result.error)) {
					await retryOrFail(item, result.error)
				} else {
					await finish(item, {
						status: 'failed',
						error: result.error,
						processedAt: now,
					})
				}
				continue
			}
			const buffer = result.bytes.buffer.slice(
				result.bytes.byteOffset,
				result.bytes.byteOffset + result.bytes.byteLength,
			) as ArrayBuffer
			const detected =
				buffer.byteLength <= PHOTO_STUDIO_MAX_INPUT_BYTES
					? detectRasterImage(buffer)
					: null
			if (!detected) {
				await retryOrFail(item, 'invalid_output')
				continue
			}
			const file = new File(
				[buffer],
				`${dishLabel(names.get(item.itemId))} (restyled).${detected.extension}`,
				{ type: detected.mimeType },
			)
			const uploaded = await store(run.organizationId, file)
			const draftAssetId = createId()
			try {
				const results = (await db.batch([
					db.insert(OrganizationMediaAsset).values({
						id: draftAssetId,
						organizationId: run.organizationId,
						objectKey: uploaded.key,
						storageScope: 'organization',
						mimeType: detected.mimeType,
						fileName: file.name,
						fileSize: buffer.byteLength,
						width: uploaded.width ?? detected.width,
						height: uploaded.height ?? detected.height,
						source: 'restyle',
						status: 'draft',
						parentAssetId: source.id,
						createdById: run.createdById,
					}),
					db
						.update(MediaRestyleRunItem)
						.set({
							status: 'drafted',
							draftAssetId,
							draftObjectKey: uploaded.key,
							error: null,
							processedAt: now,
						})
						.where(
							and(
								eq(MediaRestyleRunItem.id, item.id),
								eq(MediaRestyleRunItem.status, 'pending'),
							),
						)
						.returning({ id: MediaRestyleRunItem.id }),
				] as never)) as unknown as [unknown, Array<{ id: string }>]
				if (!results[1] || results[1].length === 0) {
					// Another caller finished this dish first: nothing half-stored stays.
					await db
						.delete(OrganizationMediaAsset)
						.where(eq(OrganizationMediaAsset.id, draftAssetId))
					await remove(uploaded.key, run.organizationId).catch(() => {})
				} else {
					processed++
				}
			} catch (error) {
				await remove(uploaded.key, run.organizationId).catch(() => {})
				throw error
			}
		} catch (error) {
			console.error('Menu restyle item failed:', error)
			await retryOrFail(item, 'restyle_failed').catch(() => {})
		}
	}

	const state = await refreshRunCounters(run.id, now)
	const outcome: RestyleProcessOutcome = {
		done: state?.status === 'ready' || state?.status === 'cancelled',
		paused: state?.status === 'paused',
		resumeAt: state?.resumeAt ?? null,
		processed,
	}
	if (processed === 0 && passing > 0) outcome.retry = true
	return outcome
}

/**
 * Throws away drafts nobody chose within 30 days: the library row and the
 * stored file (only if nothing else uses it). A live photo, a used draft or a
 * draft that is no longer a `draft` is never touched.
 */
export async function pruneRestyleDrafts(
	deps: Pick<RestyleDeps, 'now' | 'remove'> = {},
) {
	const nowMs = deps.now?.() ?? Date.now()
	const now = new Date(nowMs)
	const cutoff = new Date(nowMs - RESTYLE_DRAFT_TTL_DAYS * 86_400_000)
	const rows = await db
		.select({
			id: MediaRestyleRunItem.id,
			runId: MediaRestyleRunItem.runId,
			organizationId: MediaRestyleRunItem.organizationId,
			assetId: OrganizationMediaAsset.id,
			assetCreatedAt: OrganizationMediaAsset.createdAt,
		})
		.from(MediaRestyleRunItem)
		.innerJoin(
			OrganizationMediaAsset,
			eq(MediaRestyleRunItem.draftAssetId, OrganizationMediaAsset.id),
		)
		.where(
			and(
				eq(MediaRestyleRunItem.status, 'drafted'),
				isNull(MediaRestyleRunItem.decision),
				eq(OrganizationMediaAsset.status, 'draft'),
				lte(OrganizationMediaAsset.createdAt, cutoff),
			),
		)
		.limit(PRUNE_LIMIT)
	let pruned = 0
	for (const row of rows) {
		if (!restyleDraftIsExpired(row.assetCreatedAt, now)) continue
		const [claimed] = await db
			.update(MediaRestyleRunItem)
			.set({
				status: 'failed',
				error: 'draft_expired',
				draftAssetId: null,
				draftObjectKey: null,
			})
			.where(
				and(
					eq(MediaRestyleRunItem.id, row.id),
					eq(MediaRestyleRunItem.status, 'drafted'),
					isNull(MediaRestyleRunItem.decision),
				),
			)
			.returning({ id: MediaRestyleRunItem.id })
		if (!claimed) continue
		await deleteDraftAsset(
			{ organizationId: row.organizationId, assetId: row.assetId },
			deps,
		)
		pruned++
	}
	for (const runId of uniqueRunIds(rows)) {
		await refreshRunCounters(runId, now)
	}
	return pruned
}

/**
 * The hourly sweep (no cron slot of its own): goes on with paused runs whose
 * budget day came, wakes runs that went quiet, and prunes old drafts.
 */
export async function sweepRestyleRuns(deps: RestyleDeps = {}) {
	const nowMs = deps.now?.() ?? Date.now()
	const now = new Date(nowMs)
	let swept = 0
	if (!restyleKilled(deps)) {
		const wake = restyleWake(deps)
		const resumable = await db
			.select({ id: MediaRestyleRun.id })
			.from(MediaRestyleRun)
			.where(
				and(
					eq(MediaRestyleRun.status, 'paused'),
					lte(MediaRestyleRun.resumeAt, now),
				),
			)
			.limit(SWEEP_LIMIT)
		for (const run of resumable) {
			const [resumed] = await db
				.update(MediaRestyleRun)
				.set({ status: 'running', resumeAt: null })
				.where(
					and(
						eq(MediaRestyleRun.id, run.id),
						eq(MediaRestyleRun.status, 'paused'),
					),
				)
				.returning({ id: MediaRestyleRun.id })
			if (!resumed) continue
			await wake(run.id).catch(() => false)
			swept++
		}
		const quiet = await db
			.select({ id: MediaRestyleRun.id })
			.from(MediaRestyleRun)
			.where(
				and(
					inArray(MediaRestyleRun.status, ['pending', 'running']),
					lte(MediaRestyleRun.updatedAt, new Date(nowMs - RESTYLE_RUN_IDLE_MS)),
				),
			)
			.limit(SWEEP_LIMIT)
		for (const run of quiet) {
			await wake(run.id).catch(() => false)
			swept++
		}
	}
	const pruned = await pruneRestyleDrafts(deps)
	return { swept, pruned }
}
