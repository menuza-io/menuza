import {
	type BulkPhotoProposal,
	type BulkPhotoPair,
} from '@repo/common/dish-photo-match'

/**
 * What the bulk dish photos route answers (#316). Types only, so the page can
 * import them without pulling in server code.
 */

export type BulkProposedPhoto = {
	assetId: string
	fileName: string | null
	url: string
	width: number | null
	height: number | null
	qualityScore: number | null
	/** What the model called the dish; display text only. */
	label: string | null
	proposal: BulkPhotoProposal
	/** The library already holds a file with this name and size. */
	duplicateOfExisting: boolean
	/** The proposed dish's main photo as read now (echoed back on apply). */
	sourceKey: string | null
}

export type BulkDishChoice = {
	id: string
	name: string
	hasPhoto: boolean
	imageUrl: string | null
	/** The main photo key a swap is checked against on apply. */
	sourceKey: string | null
}

export type BulkProposeResult = {
	ok: true
	vision: 'model' | 'mock' | 'none'
	/** The hourly image budget ran out: some photos matched by name only. */
	visionLimited: boolean
	photos: BulkProposedPhoto[]
	dishes: BulkDishChoice[]
	/** Ids that are not ready photos of this organization (ignored). */
	ignoredAssetIds: string[]
}

export type BulkApplyPair = BulkPhotoPair & {
	/** The dish's main photo as the reviewer saw it (null: none). */
	sourceKey?: string | null
}

export type BulkApplyRefusalError =
	| 'not_found'
	| 'photo_changed'
	| 'asset_not_found'
	| 'asset_not_ready'
	| 'pos_owned'

export type BulkApplyResponse =
	| {
			ok: true
			applied: string[]
			refused: Array<{ itemId: string; error: BulkApplyRefusalError }>
	  }
	| {
			ok: false
			error: string
			itemId?: string
			assetId?: string
	  }

export type BulkProposeResponse =
	BulkProposeResult | { ok: false; error: string }
