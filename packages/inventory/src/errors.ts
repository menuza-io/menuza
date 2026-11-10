/** Error codes the regional inventory API answers with. */
export const INVENTORY_ERROR_CODES = [
	'invalid_request',
	'unauthorized',
	'forbidden',
	'location_forbidden',
	'inventory_disabled',
	'inventory_unavailable',
	'feature_disabled',
	'not_found',
	'stale_version',
	'idempotency_conflict',
	'unit_in_use',
	'unit_mismatch',
	'count_closed',
	'name_taken',
	'limit_reached',
	'count_in_progress',
	'undo_expired',
	'already_undone',
	'reason_not_allowed',
	// Phase 2 (additive).
	'order_not_editable',
	'order_closed',
	'order_empty',
	'supplier_mismatch',
	'purchasing_required',
	'prices_confirmed',
	'upload_not_configured',
	'email_failed',
	// Phase 3 (additive).
	'recipe_cycle',
	'recipe_too_deep',
	'recipe_empty',
	'not_a_made_item',
	// Phase 4 (additive).
	'task_closed',
	// Phase 5 (additive).
	'transfer_closed',
	'transfer_same_location',
	'reader_not_configured',
	'reader_failed',
	'no_photo',
	// Review fixes (additive).
	'currency_unknown',
	'currency_mismatch',
	'not_batch_counted',
	'send_in_progress',
] as const
export type InventoryErrorCode = (typeof INVENTORY_ERROR_CODES)[number]

/** Caps per organization; the region refuses with `limit_reached` beyond. */
export const INVENTORY_LIMITS = {
	items: 5000,
	unitsPerItem: 12,
	storageAreasPerLocation: 40,
	countListsPerLocation: 50,
	suppliers: 500,
	entriesPerBatch: 200,
	// Phase 2 (additive).
	linesPerOrder: 200,
	openOrdersPerLocation: 100,
	levelsPerBatch: 200,
	// Phase 3 (additive).
	linesPerRecipe: 60,
	costRefsPerRequest: 200,
	/** Made items inside made items, at most (also `MAX_RECIPE_DEPTH`). */
	recipeDepth: 8,
} as const
