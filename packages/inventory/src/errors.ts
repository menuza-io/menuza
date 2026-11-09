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
} as const
