import { createId } from '@paralleldrive/cuid2'
import { type ImageInput } from '@repo/ai/server'
import {
	parseRestyleCategoryIds,
	restyleBudgetLeft,
	restyleDraftExpiry,
	RESTYLE_ACTIVE_STATUSES,
	RESTYLE_DAILY_BUDGET,
	RESTYLE_MAX_PHOTOS_PER_RUN,
	type RestyleError,
	type RestyleRunStatus,
	type RestyleSkipReason,
} from '@repo/common/media-restyle'
import {
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	MediaRestyleRun,
	MediaRestyleRunItem,
	OrganizationMediaAsset,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import {
	posPhotoOwnedItemIds,
	readDishPhotoStates,
	type DishPhotoState,
} from '#app/utils/menu/dish-photo.server.ts'
import { assertCategoryIdsInOrganization } from '#app/utils/menu/ownership.server.ts'
import { type uploadOrganizationMediaFileOnly } from '#app/utils/storage.server.ts'
import { isMediaRestyleKillSwitchOn } from '../media-flags.ts'
import { restaurantDishPhotoStudio } from '../photo-studio-vertical.ts'
import { resolvePhotoStudioOptions } from '../photo-studio.ts'
import {
	getRestyleAdapter,
	type RestyleAdapter,
	type RestyleStyle,
} from './adapter.server.ts'
import {
	refreshRunCounters,
	restyledToday,
	type RestyleRemove,
} from './drafts.server.ts'
import { type RestyleItemView, type RestyleRunSummary } from './types.ts'
import { wakeMediaRestyleWorkflow } from './wake.server.ts'

/**
 * Menu restyle (#146): one studio style applied to the main photo of each
 * dish, as drafts. Live dish photos are never touched while a run works; the
 * operator reviews each draft and chooses (`decisions.server.ts`). A
 * background job (`MediaRestyleWorkflow` in jobs-cron plus its sweep, no extra
 * cron slot) does the model calls in small batches (`process.server.ts`).
 */

export type RestyleServiceError =
	| RestyleError
	| 'restyle_paused'
	| 'not_configured'
	| 'invalid_style'
	| 'invalid_categories'
	| 'run_cancelled'
	| 'not_retryable'

export type RestyleDeps = {
	/** `null` means none is set up. Unset: chosen from the environment. */
	adapter?: RestyleAdapter | null
	now?: () => number
	wake?: (runId: string) => Promise<boolean>
	/** Reads a stored photo's bytes in a form the model accepts. */
	readSource?: (asset: {
		objectKey: string
		storageScope: string
		organizationId: string
	}) => Promise<ImageInput>
	store?: typeof uploadOrganizationMediaFileOnly
	remove?: RestyleRemove
	/** True while the node kill switch (`MEDIA_RESTYLE_ENABLED=false`) is on. */
	killSwitch?: () => boolean
}

export function restyleKilled(deps: Pick<RestyleDeps, 'killSwitch'>) {
	return (deps.killSwitch ?? isMediaRestyleKillSwitchOn)()
}

export function restyleWake(deps: Pick<RestyleDeps, 'wake'>) {
	return deps.wake ?? wakeMediaRestyleWorkflow
}

export function restyleAdapter(deps: Pick<RestyleDeps, 'adapter'>) {
	return deps.adapter === undefined ? getRestyleAdapter() : deps.adapter
}

/** Raster formats the model takes as input. */
const SOURCE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
/** Skipped dishes kept as rows so the review page can list them. */
const MAX_SKIPPED_ROWS = 300
const SUBCATEGORY_DEPTH = 3
const CHUNK = 80
/** Rows per insert: each carries about twelve bound parameters (D1 allows 100). */
const ROWS_PER_INSERT = 7

function chunks<T>(values: T[], size = CHUNK) {
	const out: T[][] = []
	for (let i = 0; i < values.length; i += size) {
		out.push(values.slice(i, i + size))
	}
	return out
}

/** The style a run was started with, or null for a row that cannot be read. */
export function parseRunStyle(raw: string): RestyleStyle | null {
	try {
		const value = JSON.parse(raw) as {
			type?: unknown
			presetId?: unknown
			options?: unknown
		}
		if (value.type !== 'preset' || typeof value.presetId !== 'string') {
			return null
		}
		const options =
			value.options && typeof value.options === 'object'
				? (value.options as Record<string, unknown>)
				: {}
		return {
			presetId: value.presetId,
			options: Object.fromEntries(
				Object.entries(options).filter(
					(entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
				),
			),
		}
	} catch {
		return null
	}
}

/** Checks the preset against the studio's own list and fills option defaults. */
export function resolveRestyleStyle(
	presetId: unknown,
	options: unknown,
): RestyleStyle | null {
	if (typeof presetId !== 'string') return null
	const preset = restaurantDishPhotoStudio.presets.find(
		(candidate) => candidate.id === presetId,
	)
	if (!preset) return null
	return {
		presetId: preset.id,
		options: resolvePhotoStudioOptions(
			restaurantDishPhotoStudio,
			options && typeof options === 'object'
				? (options as Record<string, unknown>)
				: {},
		),
	}
}

/** The chosen categories and what sits under them (three levels down). */
async function expandCategoryIds(organizationId: string, ids: string[]) {
	const all = new Set(ids)
	let frontier = ids
	for (
		let depth = 0;
		depth < SUBCATEGORY_DEPTH && frontier.length > 0;
		depth++
	) {
		const next: string[] = []
		for (const chunk of chunks(frontier)) {
			const rows = await db
				.select({ id: OrganizationMenuCategory.id })
				.from(OrganizationMenuCategory)
				.where(
					and(
						eq(OrganizationMenuCategory.organizationId, organizationId),
						inArray(OrganizationMenuCategory.parentId, chunk),
					),
				)
			for (const row of rows) {
				if (!all.has(row.id)) {
					all.add(row.id)
					next.push(row.id)
				}
			}
		}
		frontier = next
	}
	return [...all]
}

async function dishIdsFor(organizationId: string, categoryIds: string[]) {
	if (categoryIds.length === 0) {
		const rows = await db
			.select({ id: OrganizationMenuItem.id })
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.orderBy(
				asc(OrganizationMenuItem.createdAt),
				asc(OrganizationMenuItem.id),
			)
		return rows.map((row) => row.id)
	}
	const ids = new Set<string>()
	for (const chunk of chunks(
		await expandCategoryIds(organizationId, categoryIds),
	)) {
		const rows = await db
			.select({ itemId: OrganizationMenuItemCategoryAssignment.itemId })
			.from(OrganizationMenuItemCategoryAssignment)
			.where(inArray(OrganizationMenuItemCategoryAssignment.categoryId, chunk))
			.orderBy(asc(OrganizationMenuItemCategoryAssignment.position))
		for (const row of rows) ids.add(row.itemId)
	}
	return [...ids]
}

export type RestyleCandidate = {
	itemId: string
	sourceAssetKey: string
	sourceAssetId: string
}

export type RestyleSkipped = {
	itemId: string
	reason: RestyleSkipReason | 'unsupported_photo' | 'pos_owned'
}

/**
 * The dishes a run would restyle (their main photo is a library image the
 * model takes) and the ones it would skip, with the reason.
 */
export async function collectRestyleCandidates(
	organizationId: string,
	categoryIds: string[],
): Promise<{ candidates: RestyleCandidate[]; skipped: RestyleSkipped[] }> {
	const itemIds = await dishIdsFor(organizationId, categoryIds)
	const states = new Map<string, DishPhotoState>()
	for (const chunk of chunks(itemIds)) {
		for (const [id, state] of await readDishPhotoStates(
			organizationId,
			chunk,
		)) {
			states.set(id, state)
		}
	}
	const keys = [
		...new Set(
			[...states.values()].flatMap((state) =>
				state.mainKey ? [state.mainKey] : [],
			),
		),
	]
	const assets = new Map<
		string,
		{ id: string; mimeType: string; objectKey: string }
	>()
	for (const chunk of chunks(keys)) {
		const rows = await db
			.select({
				id: OrganizationMediaAsset.id,
				objectKey: OrganizationMediaAsset.objectKey,
				mimeType: OrganizationMediaAsset.mimeType,
			})
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organizationId),
					inArray(OrganizationMediaAsset.objectKey, chunk),
				),
			)
		for (const row of rows) assets.set(row.objectKey, row)
	}
	// A dish whose photo a connected POS owns is left alone: the next sync
	// would put its own photo back.
	const posOwned = await posPhotoOwnedItemIds(organizationId)
	const candidates: RestyleCandidate[] = []
	const skipped: RestyleSkipped[] = []
	for (const itemId of itemIds) {
		const state = states.get(itemId)
		if (!state) continue
		if (posOwned.has(itemId)) {
			skipped.push({ itemId, reason: 'pos_owned' })
			continue
		}
		if (!state.mainKey) {
			skipped.push({ itemId, reason: 'no_photo' })
			continue
		}
		const asset = assets.get(state.mainKey)
		if (!asset) {
			skipped.push({ itemId, reason: 'photo_not_in_library' })
			continue
		}
		if (!SOURCE_MIME_TYPES.has(asset.mimeType)) {
			skipped.push({ itemId, reason: 'unsupported_photo' })
			continue
		}
		candidates.push({
			itemId,
			sourceAssetKey: asset.objectKey,
			sourceAssetId: asset.id,
		})
	}
	return { candidates, skipped }
}

/** Counts for the start page: how many dishes a run would restyle or skip. */
export async function previewRestyleRun(
	organizationId: string,
	rawCategoryIds: unknown,
) {
	const categoryIds = parseRestyleCategoryIds(rawCategoryIds)
	try {
		await assertCategoryIdsInOrganization(organizationId, categoryIds)
	} catch (error) {
		if (error instanceof Response) {
			return { ok: false as const, error: 'invalid_categories' as const }
		}
		throw error
	}
	const { candidates, skipped } = await collectRestyleCandidates(
		organizationId,
		categoryIds,
	)
	return {
		ok: true as const,
		withPhoto: candidates.length,
		withoutPhoto: skipped.length,
		tooMany: candidates.length > RESTYLE_MAX_PHOTOS_PER_RUN,
		maxPhotos: RESTYLE_MAX_PHOTOS_PER_RUN,
	}
}

type ActiveRow = { id: string; createdAt: Date }

async function activeRuns(organizationId: string): Promise<ActiveRow[]> {
	return db
		.select({ id: MediaRestyleRun.id, createdAt: MediaRestyleRun.createdAt })
		.from(MediaRestyleRun)
		.where(
			and(
				eq(MediaRestyleRun.organizationId, organizationId),
				inArray(MediaRestyleRun.status, [...RESTYLE_ACTIVE_STATUSES]),
			),
		)
		.orderBy(asc(MediaRestyleRun.createdAt), asc(MediaRestyleRun.id))
}

export type StartRestyleInput = {
	organizationId: string
	userId: string
	presetId: unknown
	options?: unknown
	/** Limit to these categories (and what is under them); omit for every dish. */
	categoryIds?: unknown
}

export async function startRestyleRun(
	input: StartRestyleInput,
	deps: RestyleDeps = {},
): Promise<
	| { ok: true; runId: string; total: number; skipped: number }
	| { ok: false; error: RestyleServiceError }
> {
	const now = deps.now?.() ?? Date.now()
	if (restyleKilled(deps)) return { ok: false, error: 'restyle_paused' }
	if (!restyleAdapter(deps)) return { ok: false, error: 'not_configured' }
	const style = resolveRestyleStyle(input.presetId, input.options)
	if (!style) return { ok: false, error: 'invalid_style' }

	const categoryIds = [...new Set(parseRestyleCategoryIds(input.categoryIds))]
	if (categoryIds.length > 60) return { ok: false, error: 'invalid_categories' }
	try {
		await assertCategoryIdsInOrganization(input.organizationId, categoryIds)
	} catch (error) {
		if (error instanceof Response)
			return { ok: false, error: 'invalid_categories' }
		throw error
	}

	if ((await activeRuns(input.organizationId)).length > 0) {
		return { ok: false, error: 'restyle_in_progress' }
	}
	const { candidates, skipped } = await collectRestyleCandidates(
		input.organizationId,
		categoryIds,
	)
	if (candidates.length === 0) return { ok: false, error: 'nothing_to_restyle' }
	if (candidates.length > RESTYLE_MAX_PHOTOS_PER_RUN) {
		return { ok: false, error: 'too_many_photos' }
	}

	const runId = createId()
	const rows = [
		...candidates.map((candidate) => ({
			itemId: candidate.itemId,
			sourceAssetKey: candidate.sourceAssetKey,
			sourceAssetId: candidate.sourceAssetId,
			status: 'pending',
			skipReason: null as string | null,
		})),
		...skipped.slice(0, MAX_SKIPPED_ROWS).map((entry) => ({
			itemId: entry.itemId,
			sourceAssetKey: null as string | null,
			sourceAssetId: null as string | null,
			status: 'skipped',
			skipReason: entry.reason as string | null,
		})),
	]
	const statements = [
		db.insert(MediaRestyleRun).values({
			id: runId,
			organizationId: input.organizationId,
			createdById: input.userId,
			style: JSON.stringify({ type: 'preset', ...style }),
			categoryIds: JSON.stringify(categoryIds),
			status: 'pending',
			total: rows.length,
			skipped: Math.min(skipped.length, MAX_SKIPPED_ROWS),
			createdAt: new Date(now),
		}),
		...chunks(rows, ROWS_PER_INSERT).map((chunk, chunkIndex) =>
			db.insert(MediaRestyleRunItem).values(
				chunk.map((row, index) => ({
					runId,
					organizationId: input.organizationId,
					...row,
					// Keeps the menu's order when the items are read back.
					createdAt: new Date(now + chunkIndex * ROWS_PER_INSERT + index),
				})),
			),
		),
	]
	try {
		await db.batch(statements as never)
	} catch (error) {
		// The unique index (one active run per organization) refused a second
		// start that raced this one.
		if (isUniqueViolation(error)) {
			return { ok: false, error: 'restyle_in_progress' }
		}
		throw error
	}

	// The checks above read and then insert, so two clicks at once can both
	// pass them. Look again with the new run in: the earlier run keeps its
	// place, the later one is taken back out (its items go with it).
	const after = await activeRuns(input.organizationId)
	if (after[0] && after[0].id !== runId) {
		await db.delete(MediaRestyleRun).where(eq(MediaRestyleRun.id, runId))
		return { ok: false, error: 'restyle_in_progress' }
	}
	await restyleWake(deps)(runId).catch(() => false)
	return { ok: true, runId, total: rows.length, skipped: skipped.length }
}

/** Stops a run: dishes not yet done stay as they are; drafts stay reviewable. */
export async function cancelRestyleRun(
	input: { organizationId: string; runId: string },
	deps: Pick<RestyleDeps, 'now'> = {},
): Promise<{ ok: true } | { ok: false; error: RestyleServiceError }> {
	const now = new Date(deps.now?.() ?? Date.now())
	const [run] = await db
		.select({ id: MediaRestyleRun.id, status: MediaRestyleRun.status })
		.from(MediaRestyleRun)
		.where(
			and(
				eq(MediaRestyleRun.id, input.runId),
				eq(MediaRestyleRun.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!run) return { ok: false, error: 'not_found' }
	const cancelled = await db
		.update(MediaRestyleRun)
		.set({ status: 'cancelled', completedAt: now, resumeAt: null })
		.where(
			and(
				eq(MediaRestyleRun.id, run.id),
				inArray(MediaRestyleRun.status, [...RESTYLE_ACTIVE_STATUSES]),
			),
		)
		.returning({ id: MediaRestyleRun.id })
	if (cancelled.length === 0) return { ok: false, error: 'run_cancelled' }
	await refreshRunCounters(run.id, now)
	return { ok: true }
}

/** The recent runs of an organization and today's use of the budget. */
export async function listRestyleRuns(
	organizationId: string,
	now = Date.now(),
) {
	const runs = await db
		.select()
		.from(MediaRestyleRun)
		.where(eq(MediaRestyleRun.organizationId, organizationId))
		.orderBy(desc(MediaRestyleRun.createdAt))
		.limit(10)
	const pendingReview = new Map<string, number>()
	if (runs.length > 0) {
		const rows = await db
			.select({
				runId: MediaRestyleRunItem.runId,
				decision: MediaRestyleRunItem.decision,
			})
			.from(MediaRestyleRunItem)
			.where(
				and(
					inArray(
						MediaRestyleRunItem.runId,
						runs.map((run) => run.id),
					),
					eq(MediaRestyleRunItem.status, 'drafted'),
				),
			)
		for (const row of rows) {
			if (row.decision === null) {
				pendingReview.set(row.runId, (pendingReview.get(row.runId) ?? 0) + 1)
			}
		}
	}
	const used = await restyledToday(organizationId, new Date(now))
	return {
		budget: RESTYLE_DAILY_BUDGET,
		usedToday: used,
		budgetLeft: restyleBudgetLeft(used),
		runs: runs.map((run): RestyleRunSummary => ({
			id: run.id,
			status: run.status as RestyleRunStatus,
			presetId: parseRunStyle(run.style)?.presetId ?? null,
			total: run.total,
			done: run.done,
			failed: run.failed,
			skipped: run.skipped,
			toDo: Math.max(0, run.total - run.skipped),
			resumeAt: run.resumeAt?.toISOString() ?? null,
			createdAt: run.createdAt.toISOString(),
			toReview: pendingReview.get(run.id) ?? 0,
		})),
	}
}

export function localizedName(raw: string) {
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

const imageUrl = (asset: { id: string; updatedAt: Date }) =>
	`/resources/images?mediaId=${encodeURIComponent(asset.id)}&v=${asset.updatedAt.getTime()}`

/** One run of the organization with every dish, for the review page. Another organization's id is null. */
export async function getRestyleRun(
	organizationId: string,
	runId: string,
	now = Date.now(),
) {
	const [run] = await db
		.select()
		.from(MediaRestyleRun)
		.where(
			and(
				eq(MediaRestyleRun.id, runId),
				eq(MediaRestyleRun.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!run) return null
	const items = await db
		.select()
		.from(MediaRestyleRunItem)
		.where(eq(MediaRestyleRunItem.runId, run.id))
		.orderBy(asc(MediaRestyleRunItem.createdAt), asc(MediaRestyleRunItem.id))
	const names = new Map<string, string>()
	for (const chunk of chunks(items.map((item) => item.itemId))) {
		const rows = await db
			.select({
				id: OrganizationMenuItem.id,
				displayName: OrganizationMenuItem.displayName,
			})
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organizationId),
					inArray(OrganizationMenuItem.id, chunk),
				),
			)
		for (const row of rows) names.set(row.id, localizedName(row.displayName))
	}
	const assetIds = [
		...new Set(
			items.flatMap((item) =>
				[item.sourceAssetId, item.draftAssetId].filter((id): id is string =>
					Boolean(id),
				),
			),
		),
	]
	const assets = new Map<
		string,
		{
			id: string
			updatedAt: Date
			createdAt: Date
			objectKey: string
			status: string
		}
	>()
	for (const chunk of chunks(assetIds)) {
		const rows = await db
			.select({
				id: OrganizationMediaAsset.id,
				updatedAt: OrganizationMediaAsset.updatedAt,
				createdAt: OrganizationMediaAsset.createdAt,
				objectKey: OrganizationMediaAsset.objectKey,
				status: OrganizationMediaAsset.status,
			})
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organizationId),
					inArray(OrganizationMediaAsset.id, chunk),
				),
			)
		for (const row of rows) assets.set(row.id, row)
	}
	const views = items.map((item): RestyleItemView => {
		const original = item.sourceAssetId ? assets.get(item.sourceAssetId) : null
		const draft = item.draftAssetId ? assets.get(item.draftAssetId) : null
		return {
			id: item.id,
			itemId: item.itemId,
			name: names.get(item.itemId) ?? '',
			status: item.status,
			decision: item.decision,
			skipReason: item.skipReason,
			error: item.error,
			originalUrl: original ? imageUrl(original) : null,
			draftUrl: draft ? imageUrl(draft) : null,
			draftKey: draft?.objectKey ?? null,
			draftExpiresAt:
				draft && draft.status === 'draft' && item.decision === null
					? restyleDraftExpiry(draft.createdAt).toISOString()
					: null,
		}
	})
	const used = await restyledToday(organizationId, new Date(now))
	return {
		run: {
			id: run.id,
			status: run.status as RestyleRunStatus,
			presetId: parseRunStyle(run.style)?.presetId ?? null,
			total: run.total,
			done: run.done,
			failed: run.failed,
			skipped: run.skipped,
			toDo: Math.max(0, run.total - run.skipped),
			resumeAt: run.resumeAt?.toISOString() ?? null,
			createdAt: run.createdAt.toISOString(),
		},
		items: views,
		budgetLeft: restyleBudgetLeft(used),
	}
}

/** A unique-index failure, however deep the driver wrapped it. */
function isUniqueViolation(error: unknown): boolean {
	for (let depth = 0; depth < 5 && error; depth += 1) {
		const text = `${(error as { code?: unknown }).code ?? ''} ${(error as { message?: unknown }).message ?? ''}`
		if (text.includes('UNIQUE')) return true
		error = (error as { cause?: unknown }).cause
	}
	return false
}
