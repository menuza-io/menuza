import { auditService, AuditAction } from '@repo/audit'
import { checkUseDraft, type RestyleDecision } from '@repo/common/media-restyle'
import {
	and,
	db,
	eq,
	inArray,
	isNull,
	or,
	sql,
	MediaRestyleRun,
	MediaRestyleRunItem,
	OrganizationMediaAsset,
} from '@repo/database'
import {
	dishMainPhotoIs,
	findLibraryAssetByKey,
	readDishPhotoStates,
	replaceDishMainPhoto,
	type DishPhotoOrganization,
} from '#app/utils/menu/dish-photo.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { deleteDraftAsset, refreshRunCounters } from './drafts.server.ts'
import {
	restyleAdapter,
	restyleKilled,
	restyleWake,
	type RestyleDeps,
	type RestyleServiceError,
} from './service.server.ts'

/**
 * What the operator decides about each draft of a run (#146). Every function
 * is scoped to one organization: a run or item of another organization is
 * `not_found`, never touched. A dish's photo changes only through
 * `replaceDishMainPhoto` (compare and set), so a stale review cannot overwrite
 * a photo someone changed meanwhile.
 */

type Actor = {
	organization: DishPhotoOrganization
	userId: string
	request?: Request
}

type Failure = { ok: false; error: RestyleServiceError }

/** A run item of this organization (through its run), with its run. */
async function loadItem(
	organizationId: string,
	runId: string,
	itemRowId: string,
) {
	const [row] = await db
		.select({ item: MediaRestyleRunItem, run: MediaRestyleRun })
		.from(MediaRestyleRunItem)
		.innerJoin(
			MediaRestyleRun,
			eq(MediaRestyleRunItem.runId, MediaRestyleRun.id),
		)
		.where(
			and(
				eq(MediaRestyleRunItem.id, itemRowId),
				eq(MediaRestyleRunItem.runId, runId),
				eq(MediaRestyleRun.organizationId, organizationId),
				eq(MediaRestyleRunItem.organizationId, organizationId),
			),
		)
		.limit(1)
	return row ?? null
}

async function recordChange(
	actor: Actor,
	itemId: string,
	details: string,
	metadata: Record<string, unknown>,
) {
	await auditService.log({
		action: AuditAction.MENU_ITEM_UPDATED,
		userId: actor.userId,
		organizationId: actor.organization.id,
		resourceType: 'menu_item',
		resourceId: itemId,
		details,
		metadata,
		request: actor.request,
	})
}

type ApplyInput = Actor & {
	runId: string
	itemRowId: string
	/** The draft file the reviewer saw: a draft remade since is `draft_changed`. */
	draftKey?: string | null
	/** Bulk callers record and purge once themselves. */
	skipRecord?: boolean
}

/**
 * "Use new": the draft becomes the dish's main photo. Refused while the dish's
 * main photo is no longer the one the draft was made from (`photo_changed`),
 * while the draft changed (`draft_changed`), or when it was decided already.
 * The original stays in the library as the draft's original (#147), and out of
 * the dish's gallery.
 */
export async function applyRestyleDraft(
	input: ApplyInput,
): Promise<{ ok: true; previousKey: string | null } | Failure> {
	const { organization } = input
	const found = await loadItem(organization.id, input.runId, input.itemRowId)
	if (!found) return { ok: false, error: 'not_found' }
	const { item } = found
	const draft =
		item.status === 'drafted' && item.draftAssetId
			? ((
					await db
						.select()
						.from(OrganizationMediaAsset)
						.where(
							and(
								eq(OrganizationMediaAsset.id, item.draftAssetId),
								eq(OrganizationMediaAsset.organizationId, organization.id),
							),
						)
						.limit(1)
				)[0] ?? null)
			: null
	const state = (await readDishPhotoStates(organization.id, [item.itemId])).get(
		item.itemId,
	)
	if (!state) return { ok: false, error: 'not_found' }
	const checked = checkUseDraft({
		currentMainKey: state.mainKey,
		sourceKey: item.sourceAssetKey ?? '',
		draftKey: draft?.objectKey,
		draftKeyAtReview: item.draftObjectKey,
		decision: item.decision as RestyleDecision | null,
		draftStatus: draft?.status,
	})
	if (!checked.ok) return checked
	if (input.draftKey && draft && input.draftKey !== draft.objectKey) {
		return { ok: false, error: 'draft_changed' }
	}
	if (!draft || !item.sourceAssetKey)
		return { ok: false, error: 'draft_missing' }

	const now = new Date()
	const result = await replaceDishMainPhoto({
		organization,
		userId: input.userId,
		request: input.request,
		itemId: item.itemId,
		asset: {
			id: draft.id,
			objectKey: draft.objectKey,
			updatedAt: draft.updatedAt,
			status: draft.status,
		},
		expectSourceKey: item.sourceAssetKey,
		// The old photo leaves the dish's gallery; it stays in the library.
		dropKey: item.sourceAssetKey,
		// The draft's original was linked when it was made.
		linkVersion: false,
		allowDraft: true,
		// Guarded: these run only when the dish switch applied.
		after: ({ itemId, newKey }) => [
			db
				.update(OrganizationMediaAsset)
				.set({ status: 'ready' })
				.where(
					and(
						eq(OrganizationMediaAsset.id, draft.id),
						eq(OrganizationMediaAsset.status, 'draft'),
						dishMainPhotoIs(itemId, newKey),
					),
				),
			db
				.update(MediaRestyleRunItem)
				.set({
					decision: 'used',
					replacedAssetKey: item.sourceAssetKey,
					decidedAt: now,
				})
				.where(
					and(
						eq(MediaRestyleRunItem.id, item.id),
						isNull(MediaRestyleRunItem.decision),
						dishMainPhotoIs(itemId, newKey),
					),
				),
		],
		details: 'Menu restyle: used the new photo',
		metadata: { runId: input.runId },
		skipRecord: input.skipRecord,
	})
	if (!result.ok) {
		return {
			ok: false,
			error:
				result.error === 'photo_changed'
					? 'photo_changed'
					: result.error === 'not_found'
						? 'not_found'
						: result.error === 'pos_owned'
							? 'pos_owned'
							: 'draft_changed',
		}
	}
	return { ok: true, previousKey: result.previousKey }
}

/**
 * "Use all remaining": uses every draft with no decision, one at a time. A
 * dish whose photo changed meanwhile is counted as refused and never
 * overwritten. Records and purges the site cache once.
 */
export async function applyAllRestyleDrafts(
	input: Actor & { runId: string; limit?: number },
): Promise<
	| {
			ok: true
			used: number
			refused: Array<{ itemId: string; error: RestyleServiceError }>
			/** Drafts still waiting after this call (when `limit` cut it short). */
			remaining: number
	  }
	| Failure
> {
	const [run] = await db
		.select({ id: MediaRestyleRun.id })
		.from(MediaRestyleRun)
		.where(
			and(
				eq(MediaRestyleRun.id, input.runId),
				eq(MediaRestyleRun.organizationId, input.organization.id),
			),
		)
		.limit(1)
	if (!run) return { ok: false, error: 'not_found' }
	const open = await db
		.select({ id: MediaRestyleRunItem.id, itemId: MediaRestyleRunItem.itemId })
		.from(MediaRestyleRunItem)
		.where(
			and(
				eq(MediaRestyleRunItem.runId, run.id),
				eq(MediaRestyleRunItem.status, 'drafted'),
				isNull(MediaRestyleRunItem.decision),
			),
		)
		.orderBy(MediaRestyleRunItem.createdAt, MediaRestyleRunItem.id)
	const batch = open.slice(0, input.limit ?? open.length)
	const used: string[] = []
	const refused: Array<{ itemId: string; error: RestyleServiceError }> = []
	for (const entry of batch) {
		const result = await applyRestyleDraft({
			...input,
			itemRowId: entry.id,
			skipRecord: true,
		})
		if (result.ok) used.push(entry.itemId)
		else refused.push({ itemId: entry.itemId, error: result.error })
	}
	for (const itemId of used) {
		await recordChange(input, itemId, 'Menu restyle: used the new photo', {
			runId: input.runId,
		})
	}
	if (used.length > 0) {
		await purgeOrganizationSiteCache(
			input.organization.id,
			input.organization.slug,
		)
	}
	return {
		ok: true,
		used: used.length,
		refused,
		remaining: open.length - batch.length,
	}
}

/**
 * "Switch back": the dish gets its original main photo again, in one step.
 * Refused unless the draft was used (`not_used`), the original is still in the
 * library (`switch_back_unavailable`) and the dish still shows the draft
 * (`photo_changed`). The draft stays in the library as a ready photo.
 */
export async function switchBackRestyleItem(
	input: ApplyInput,
): Promise<{ ok: true } | Failure> {
	const { organization } = input
	const found = await loadItem(organization.id, input.runId, input.itemRowId)
	if (!found) return { ok: false, error: 'not_found' }
	const { item } = found
	if (item.decision !== 'used') return { ok: false, error: 'not_used' }
	if (!item.replacedAssetKey || !item.draftObjectKey) {
		return { ok: false, error: 'switch_back_unavailable' }
	}
	const original = await findLibraryAssetByKey(
		organization.id,
		item.replacedAssetKey,
	)
	if (!original || original.status !== 'ready') {
		return { ok: false, error: 'switch_back_unavailable' }
	}
	const now = new Date()
	const result = await replaceDishMainPhoto({
		organization,
		userId: input.userId,
		request: input.request,
		itemId: item.itemId,
		asset: {
			id: original.id,
			objectKey: original.objectKey,
			updatedAt: original.updatedAt,
			status: original.status,
		},
		expectSourceKey: item.draftObjectKey,
		// The dish goes back to exactly what it had: the draft leaves its gallery.
		dropKey: item.draftObjectKey,
		linkVersion: false,
		after: ({ itemId, newKey }) => [
			db
				.update(MediaRestyleRunItem)
				.set({ decision: 'kept', decidedAt: now })
				.where(
					and(
						eq(MediaRestyleRunItem.id, item.id),
						eq(MediaRestyleRunItem.decision, 'used'),
						dishMainPhotoIs(itemId, newKey),
					),
				),
		],
		details: 'Menu restyle: switched back to the original photo',
		metadata: { runId: input.runId },
	})
	if (!result.ok) {
		return {
			ok: false,
			error:
				result.error === 'not_found'
					? 'not_found'
					: result.error === 'photo_changed'
						? 'photo_changed'
						: result.error === 'pos_owned'
							? 'pos_owned'
							: 'switch_back_unavailable',
		}
	}
	return { ok: true }
}

/**
 * "Keep original": nothing changes on the dish. The draft is deleted now, so
 * the library stays clean (the original is untouched).
 */
export async function keepRestyleOriginal(
	input: { organizationId: string; runId: string; itemRowId: string },
	deps: Pick<RestyleDeps, 'now' | 'remove'> = {},
): Promise<{ ok: true } | Failure> {
	const found = await loadItem(
		input.organizationId,
		input.runId,
		input.itemRowId,
	)
	if (!found) return { ok: false, error: 'not_found' }
	const { item } = found
	if (item.status !== 'drafted') return { ok: false, error: 'draft_missing' }
	const now = new Date(deps.now?.() ?? Date.now())
	const [kept] = await db
		.update(MediaRestyleRunItem)
		.set({
			decision: 'kept',
			decidedAt: now,
			draftAssetId: null,
			draftObjectKey: null,
		})
		.where(
			and(
				eq(MediaRestyleRunItem.id, item.id),
				eq(MediaRestyleRunItem.status, 'drafted'),
				isNull(MediaRestyleRunItem.decision),
			),
		)
		.returning({ id: MediaRestyleRunItem.id })
	if (!kept) return { ok: false, error: 'already_decided' }
	if (item.draftAssetId) {
		await deleteDraftAsset(
			{ organizationId: input.organizationId, assetId: item.draftAssetId },
			deps,
		)
	}
	return { ok: true }
}

/**
 * "Try again": throws the old draft away and queues this dish for a new one,
 * and the run goes on. Not while another run is active, the run is cancelled,
 * or the node kill switch is on. A dish whose draft was used is switched back
 * first. The daily budget still applies: past it, the run waits for tomorrow.
 */
export async function retryRestyleItem(
	input: { organizationId: string; runId: string; itemRowId: string },
	deps: RestyleDeps = {},
): Promise<{ ok: true } | Failure> {
	const found = await loadItem(
		input.organizationId,
		input.runId,
		input.itemRowId,
	)
	if (!found) return { ok: false, error: 'not_found' }
	const { item, run } = found
	if (restyleKilled(deps)) return { ok: false, error: 'restyle_paused' }
	if (!restyleAdapter(deps)) return { ok: false, error: 'not_configured' }
	if (run.status === 'cancelled') return { ok: false, error: 'run_cancelled' }
	if (item.decision === 'used') return { ok: false, error: 'already_decided' }
	if (item.status !== 'drafted' && item.status !== 'failed') {
		return { ok: false, error: 'not_retryable' }
	}
	// One run at a time: this run may go on only if no other one is active.
	const others = await db
		.select({ id: MediaRestyleRun.id })
		.from(MediaRestyleRun)
		.where(
			and(
				eq(MediaRestyleRun.organizationId, input.organizationId),
				inArray(MediaRestyleRun.status, ['pending', 'running', 'paused']),
				sql`${MediaRestyleRun.id} <> ${run.id}`,
			),
		)
		.limit(1)
	if (others.length > 0) return { ok: false, error: 'restyle_in_progress' }
	if (!item.sourceAssetKey || !item.sourceAssetId) {
		return { ok: false, error: 'not_retryable' }
	}

	const [reset] = await db
		.update(MediaRestyleRunItem)
		.set({
			status: 'pending',
			attempts: 0,
			decision: null,
			decidedAt: null,
			error: null,
			draftAssetId: null,
			draftObjectKey: null,
		})
		.where(
			and(
				eq(MediaRestyleRunItem.id, item.id),
				eq(MediaRestyleRunItem.status, item.status),
				or(
					isNull(MediaRestyleRunItem.decision),
					eq(MediaRestyleRunItem.decision, 'kept'),
				),
			),
		)
		.returning({ id: MediaRestyleRunItem.id })
	if (!reset) return { ok: false, error: 'already_decided' }
	if (item.draftAssetId) {
		await deleteDraftAsset(
			{ organizationId: input.organizationId, assetId: item.draftAssetId },
			deps,
		)
	}
	await db
		.update(MediaRestyleRun)
		.set({ status: 'running', resumeAt: null, completedAt: null })
		.where(eq(MediaRestyleRun.id, run.id))
	await refreshRunCounters(run.id, new Date(deps.now?.() ?? Date.now()))
	await restyleWake(deps)(run.id).catch(() => false)
	return { ok: true }
}
