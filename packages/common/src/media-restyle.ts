/**
 * Menu photo restyle (#146). Pure: the App stores runs and items and the
 * workflow wakes it; these are the rules both follow.
 *
 * - A run makes a draft of each dish's main photo in one style. Live photos
 *   do not change until the operator picks "Use new".
 * - Only the plate, the backdrop and the light may change; never the food.
 * - A draft can be used only while the dish's main photo is still the photo
 *   it was made from (`photo_changed`) and the draft itself is unchanged
 *   (`draft_changed`).
 * - One run at a time per organization (`restyle_in_progress`), at most 200
 *   photos a run, a daily budget; at the budget the run pauses and resumes the
 *   next day. Drafts nobody chose are deleted after 30 days.
 */

export const RESTYLE_MAX_PHOTOS_PER_RUN = 200
/** Photos one organization may restyle per UTC day, across runs. */
export const RESTYLE_DAILY_BUDGET = 150
/** A job call processes this many dishes. */
export const RESTYLE_BATCH_SIZE = 4
export const RESTYLE_DRAFT_TTL_DAYS = 30
/** Photos one item may be retried before it stays failed. */
export const RESTYLE_MAX_ATTEMPTS = 2

export const RESTYLE_RUN_STATUSES = [
	'pending',
	'running',
	'paused',
	'ready',
	'cancelled',
] as const
export type RestyleRunStatus = (typeof RESTYLE_RUN_STATUSES)[number]

/** A run counts as "in progress" until it is finished or cancelled. */
export const RESTYLE_ACTIVE_STATUSES: readonly RestyleRunStatus[] = [
	'pending',
	'running',
	'paused',
]

export const RESTYLE_ITEM_STATUSES = [
	'pending',
	'drafted',
	'failed',
	'skipped',
] as const
export type RestyleItemStatus = (typeof RESTYLE_ITEM_STATUSES)[number]

export const RESTYLE_DECISIONS = ['used', 'kept', 'retry'] as const
export type RestyleDecision = (typeof RESTYLE_DECISIONS)[number]

export type RestyleError =
	| 'restyle_in_progress'
	| 'photo_changed'
	| 'draft_changed'
	| 'draft_missing'
	| 'already_decided'
	| 'too_many_photos'
	| 'nothing_to_restyle'
	| 'not_found'
	| 'not_used'
	| 'pos_owned'
	| 'switch_back_unavailable'

export type RestyleSkipReason = 'no_photo' | 'photo_not_in_library'

/** The studio rule, repeated in every restyle prompt. */
export const RESTYLE_FOOD_RULE =
	'Change only the plate, the backdrop and the light. Do not change the food: its shape, portion, colour, toppings and garnish must stay exactly as photographed. Do not add or remove food.'

/**
 * May a draft become the dish's main photo? The dish's current main photo must
 * still be the one the draft was made from, and the draft file must be the one
 * the run stored.
 */
export function checkUseDraft(input: {
	currentMainKey: string | null | undefined
	sourceKey: string
	draftKey: string | null | undefined
	draftKeyAtReview: string | null | undefined
	decision?: RestyleDecision | null
	draftStatus?: string | null
}): { ok: true } | { ok: false; error: RestyleError } {
	if (!input.draftKey) return { ok: false, error: 'draft_missing' }
	if (input.decision) return { ok: false, error: 'already_decided' }
	if (input.draftStatus && input.draftStatus !== 'draft')
		return { ok: false, error: 'draft_changed' }
	if (input.draftKeyAtReview && input.draftKeyAtReview !== input.draftKey)
		return { ok: false, error: 'draft_changed' }
	if (input.currentMainKey !== input.sourceKey)
		return { ok: false, error: 'photo_changed' }
	return { ok: true }
}

/** Items left to do today: the daily budget minus what was already restyled. */
export function restyleBudgetLeft(usedToday: number): number {
	return Math.max(0, RESTYLE_DAILY_BUDGET - usedToday)
}

/** The next UTC midnight: when a paused run may go on. */
export function nextBudgetReset(now: Date): Date {
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
	)
}

export function restyleDraftExpiry(createdAt: Date): Date {
	return new Date(createdAt.getTime() + RESTYLE_DRAFT_TTL_DAYS * 86_400_000)
}

export function restyleDraftIsExpired(createdAt: Date, now: Date): boolean {
	return restyleDraftExpiry(createdAt).getTime() <= now.getTime()
}

/**
 * What state a run is in, from its items: `ready` once nothing is pending
 * (every dish drafted, failed or skipped).
 */
export function restyleRunStatusFrom(input: {
	pending: number
	budgetLeft: number
	cancelled?: boolean
}): RestyleRunStatus {
	if (input.cancelled) return 'cancelled'
	if (input.pending === 0) return 'ready'
	return input.budgetLeft <= 0 ? 'paused' : 'running'
}

export function parseRestyleCategoryIds(raw: unknown): string[] {
	let value = raw
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw)
		} catch {
			return []
		}
	}
	if (!Array.isArray(value)) return []
	return value.filter(
		(id): id is string => typeof id === 'string' && id.length > 0,
	)
}
