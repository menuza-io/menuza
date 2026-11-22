import { type BulkPhotoFlag } from '@repo/common/dish-photo-match'
import {
	type BulkApplyPair,
	type BulkDishChoice,
	type BulkProposedPhoto,
} from './types.ts'

/**
 * The review grid's decisions (#316), as plain data so the rules are tested
 * without a browser:
 *
 * - Nothing is confirmed unless the operator confirms it, except a confident
 *   match with no flag onto a dish that has no photo yet.
 * - A dish that already has a photo is only ever replaced when the operator
 *   ticks "Replace?" for that pair (it starts off); ticking it is also the
 *   confirmation, and unticking it takes the pair out again.
 * - A dish takes one photo and a photo goes to one dish: a dish already used
 *   by another photo is not offered again.
 */

export type ReviewRow = {
	assetId: string
	/** The dish this photo is paired with, or `null` (stays in the library). */
	itemId: string | null
	/** Confirmed by the operator (or confident by default). */
	confirmed: boolean
	/** "Replace?" for a dish that already has a photo. */
	replace: boolean
}

export type ReviewState = Record<string, ReviewRow>

/** A flag that stops a pair from being confirmed on its own. */
const BLOCKING_FLAGS: readonly BulkPhotoFlag[] = [
	'not_food',
	'too_small',
	'duplicate',
	'weak',
]

export function hasBlockingFlag(flags: readonly BulkPhotoFlag[]) {
	return flags.some((flag) => BLOCKING_FLAGS.includes(flag))
}

export function initialReviewState(
	photos: readonly BulkProposedPhoto[],
	dishes: readonly BulkDishChoice[],
): ReviewState {
	const dishById = new Map(dishes.map((dish) => [dish.id, dish]))
	const state: ReviewState = {}
	for (const photo of photos) {
		const { itemId, confidence, flags } = photo.proposal
		const dish = itemId ? dishById.get(itemId) : undefined
		state[photo.assetId] = {
			assetId: photo.assetId,
			itemId: dish ? itemId : null,
			confirmed:
				Boolean(dish) &&
				// Never for a replacement: that is the operator's tick.
				!dish!.hasPhoto &&
				(confidence === 'high' || confidence === 'medium') &&
				!hasBlockingFlag(flags) &&
				!photo.duplicateOfExisting,
			replace: false,
		}
	}
	return state
}

/** The dishes other rows already use (a dish takes one photo). */
export function usedItemIds(state: ReviewState, exceptAssetId?: string) {
	const used = new Set<string>()
	for (const row of Object.values(state)) {
		if (row.itemId && row.assetId !== exceptAssetId) used.add(row.itemId)
	}
	return used
}

/** Pairs a photo with another dish (or none). Starts unconfirmed. */
export function swapDish(
	state: ReviewState,
	assetId: string,
	itemId: string | null,
): ReviewState {
	const row = state[assetId]
	if (!row) return state
	if (itemId && usedItemIds(state, assetId).has(itemId)) return state
	return {
		...state,
		[assetId]: { ...row, itemId, confirmed: false, replace: false },
	}
}

export function setConfirmed(
	state: ReviewState,
	assetId: string,
	confirmed: boolean,
	dishes: readonly BulkDishChoice[],
): ReviewState {
	const row = state[assetId]
	if (!row || !row.itemId) return state
	const dish = dishes.find((candidate) => candidate.id === row.itemId)
	// A dish with a photo is confirmed only through "Replace?".
	if (confirmed && dish?.hasPhoto && !row.replace) return state
	return { ...state, [assetId]: { ...row, confirmed } }
}

export function setReplace(
	state: ReviewState,
	assetId: string,
	replace: boolean,
	dishes: readonly BulkDishChoice[],
): ReviewState {
	const row = state[assetId]
	if (!row || !row.itemId) return state
	const dish = dishes.find((candidate) => candidate.id === row.itemId)
	if (!dish?.hasPhoto) return state
	return { ...state, [assetId]: { ...row, replace, confirmed: replace } }
}

/** Takes the photo out of the review: it stays in the library. */
export function skipPhoto(state: ReviewState, assetId: string): ReviewState {
	const row = state[assetId]
	if (!row) return state
	return {
		...state,
		[assetId]: { ...row, itemId: null, confirmed: false, replace: false },
	}
}

/** The pairs to send: confirmed rows only, each dish once. */
export function confirmedPairs(
	state: ReviewState,
	dishes: readonly BulkDishChoice[],
): BulkApplyPair[] {
	const dishById = new Map(dishes.map((dish) => [dish.id, dish]))
	const seen = new Set<string>()
	const pairs: BulkApplyPair[] = []
	for (const row of Object.values(state)) {
		if (!row.confirmed || !row.itemId) continue
		const dish = dishById.get(row.itemId)
		if (!dish || seen.has(row.itemId)) continue
		// A replacement without the operator's tick is never sent.
		if (dish.hasPhoto && !row.replace) continue
		seen.add(row.itemId)
		pairs.push({
			assetId: row.assetId,
			itemId: row.itemId,
			replace: dish.hasPhoto ? row.replace : false,
			sourceKey: dish.sourceKey,
		})
	}
	return pairs
}

/** Photos that end up unmatched and stay in the library. */
export function unmatchedAssetIds(state: ReviewState): string[] {
	return Object.values(state)
		.filter((row) => !row.itemId)
		.map((row) => row.assetId)
}
