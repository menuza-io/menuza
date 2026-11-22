import { z } from 'zod'
import { inventoryBaseUnitSchema } from '../units.ts'
import { inventoryLocationIdSchema } from '../token.ts'
import {
	clientIdSchema,
	currencyOut,
	expectedVersionSchema,
	inventoryIdSchema,
	inventoryNameSchema,
	minorOut,
	locationQuerySchema,
} from './common.ts'

/**
 * Setup: where an item is used (#518), changing its unit (#494), ingredient
 * groups (#495), merging duplicates (#493) and the "Check your setup" list
 * (#510). Everything is regional; the App only joins dish names from ids.
 * Money is optional in every response (cost grant only).
 */

// ── Used in (#518) ──────────────────────────────────────────────────────────

export const USED_IN_OWNER_KINDS = [
	'menu_item',
	'variant',
	'option',
	'made_item',
] as const
export const usedInOwnerKindSchema = z.enum(USED_IN_OWNER_KINDS)

/** Used-in rows are capped; the sheet says "and N more". */
export const USED_IN_LIMIT = 200

export const usedInRowSchema = z.object({
	ownerKind: usedInOwnerKindSchema,
	/** A menu item, size or option id (the App joins the name) or a made item's inventory id. */
	ownerId: z.string(),
	/** Set for a made item: its inventory name. Menu owners are named by the App. */
	ownerName: z.string().nullable(),
	/** What ends up in one portion, in base thousandths of the item. */
	quantity: z.number().int(),
	usableBp: z.number().int(),
	mode: z.enum(['add', 'replace']),
	/** The recipe uses a group this item belongs to, not the item itself. */
	viaGroupItemId: z.string().nullable(),
	viaGroupName: z.string().nullable(),
	/** The line's cost and its share of the plate cost (cost grant only). */
	costMinor: minorOut,
	shareBp: z.number().int().nullable().optional(),
	currency: currencyOut,
})
export type UsedInRow = z.infer<typeof usedInRowSchema>

/** `GET /items/:id/used-in` */
export const usedInResultSchema = z.object({
	itemId: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	rows: z.array(usedInRowSchema),
	/** Rows beyond the cap. */
	more: z.number().int(),
})
export type UsedInResult = z.infer<typeof usedInResultSchema>

// ── What blocks a change (#494, #493) ───────────────────────────────────────

export const BLOCKER_KINDS = [
	'open_count',
	'open_transfer',
	'open_order',
	'in_group',
	'is_group',
] as const
export const blockerSchema = z.object({
	kind: z.enum(BLOCKER_KINDS),
	id: z.string(),
	locationId: z.string().nullable(),
	/** An order number or a count date: something a person can recognise. */
	reference: z.string().nullable(),
})
export type Blocker = z.infer<typeof blockerSchema>

// ── Change unit (#494) ──────────────────────────────────────────────────────

/** A plain decimal typed by a person ("1", "180", "1.03"). */
export const decimalAmountSchema = z
	.string()
	.trim()
	.regex(/^\d{1,12}(\.\d{1,6})?$/, 'Invalid amount')

/**
 * "`oldAmount` of the old unit equals `newAmount` of the new one": 1 piece =
 * 180 g is `{ oldAmount: '1', newAmount: '180' }`; a density of 1.03 g per ml
 * going from g to ml is `{ oldAmount: '1.03', newAmount: '1' }`.
 */
export const unitChangeBodySchema = z
	.object({
		toUnit: inventoryBaseUnitSchema,
		oldAmount: decimalAmountSchema,
		newAmount: decimalAmountSchema,
		expectedVersion: expectedVersionSchema,
	})
	.strict()
export type UnitChangeBody = z.infer<typeof unitChangeBodySchema>

const beforeAfter = z.object({
	before: z.number().int(),
	after: z.number().int(),
})

export const unitChangePlanSchema = z.object({
	itemId: z.string(),
	itemName: z.string(),
	fromUnit: inventoryBaseUnitSchema,
	toUnit: inventoryBaseUnitSchema,
	factor: z.object({ num: z.number().int(), den: z.number().int() }),
	blockers: z.array(blockerSchema),
	onHand: z.array(
		z.object({ locationId: z.string() }).extend(beforeAfter.shape),
	),
	/** Cost per base unit, micro-minor (cost grant only). */
	cost: z
		.object({
			currency: z.string(),
			avg: beforeAfter.partial().nullable(),
			last: beforeAfter.partial().nullable(),
		})
		.nullable()
		.optional(),
	packs: z.array(
		z
			.object({
				kind: z.enum(['supplier_product', 'named_unit']),
				id: z.string(),
				name: z.string(),
			})
			.extend(beforeAfter.shape),
	),
	recipes: z.array(
		z.object({
			ownerKind: usedInOwnerKindSchema,
			ownerId: z.string(),
			lines: z.array(
				z.object({ lineId: z.string() }).extend(beforeAfter.shape),
			),
			makes: beforeAfter.nullable(),
		}),
	),
	levels: z.array(
		z.object({
			locationId: z.string(),
			orderBelow: beforeAfter.nullable(),
			fillUpTo: beforeAfter.nullable(),
		}),
	),
	lastCount: z
		.object({ locationId: z.string(), at: z.number().int() })
		.extend(beforeAfter.shape)
		.nullable(),
	/** A line or level that would round to nothing: the change is refused. */
	tooSmall: z.boolean(),
	/** Recipes would get a new version and the caller lacks the recipe grant. */
	needsRecipeGrant: z.boolean().optional(),
	canApply: z.boolean(),
})
export type UnitChangePlan = z.infer<typeof unitChangePlanSchema>

/** `POST /items/:id/unit-change` answers the plan it applied (same shape as the preview). */
export const unitChangeResultSchema = z.object({
	plan: unitChangePlanSchema,
	changeId: z.string(),
})

// ── Groups (#495) ───────────────────────────────────────────────────────────

export const MAX_GROUP_MEMBERS = 12

export const groupMemberInputSchema = z
	.object({
		itemId: inventoryIdSchema,
		/** `memberQuantity` of the member = `groupQuantity` of the group (default 1:1). */
		memberQuantity: z.number().int().min(1).max(1_000_000).default(1),
		groupQuantity: z.number().int().min(1).max(1_000_000).default(1),
	})
	.strict()

export const createGroupSchema = z
	.object({
		clientId: clientIdSchema,
		name: inventoryNameSchema,
		baseUnit: inventoryBaseUnitSchema,
		category: z.string().max(60).optional(),
		autoSoldOut: z.boolean().optional(),
		/** Primary first. */
		members: z.array(groupMemberInputSchema).min(1).max(MAX_GROUP_MEMBERS),
	})
	.strict()

export const updateGroupSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		name: inventoryNameSchema.optional(),
		autoSoldOut: z.boolean().optional(),
		/** The whole member list, primary first. */
		members: z
			.array(groupMemberInputSchema)
			.min(1)
			.max(MAX_GROUP_MEMBERS)
			.optional(),
	})
	.strict()

export const groupMemberSchema = z.object({
	itemId: z.string(),
	name: z.string(),
	rank: z.number().int(),
	baseUnit: inventoryBaseUnitSchema,
	memberQuantity: z.number().int(),
	groupQuantity: z.number().int(),
	/** On hand in the member's own base thousandths. */
	onHand: z.number().int(),
	/** The same stock in group thousandths. */
	onHandInGroupUnit: z.number().int(),
	costMicro: z.number().int().nullable().optional(),
	currency: currencyOut,
	archived: z.boolean(),
})

export const itemGroupSchema = z.object({
	id: z.string(),
	name: z.string(),
	category: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	version: z.number().int(),
	autoSoldOut: z.boolean(),
	archived: z.boolean(),
	/** The members' total in group thousandths. */
	onHand: z.number().int(),
	members: z.array(groupMemberSchema),
	/** The primary's price, per group base unit (cost grant only). */
	costMicro: z.number().int().nullable().optional(),
	currency: currencyOut,
})
export type ItemGroup = z.infer<typeof itemGroupSchema>

/** `GET /groups?locationId=` */
export const listGroupsQuerySchema = locationQuerySchema
export const listGroupsResultSchema = z.object({
	groups: z.array(itemGroupSchema),
})

// ── Merge (#493) ────────────────────────────────────────────────────────────

/** An undo works for a day. */
export const MERGE_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000

export const mergeItemBodySchema = z
	.object({
		/** The item to keep. */
		intoItemId: inventoryIdSchema,
		expectedVersion: expectedVersionSchema,
		intoExpectedVersion: expectedVersionSchema,
	})
	.strict()

export const mergePreviewQuerySchema = z
	.object({ intoItemId: inventoryIdSchema })
	.strict()

export const mergeCountsSchema = z.object({
	recipes: z.number().int(),
	supplierProducts: z.number().int(),
	places: z.number().int(),
	countLists: z.number().int(),
	prepLevels: z.number().int(),
})

export const mergeItemPreviewSchema = z.object({
	itemId: z.string(),
	itemName: z.string(),
	intoItemId: z.string(),
	intoItemName: z.string(),
	blockers: z.array(blockerSchema),
	/** The two items measure in different base units: change one first. */
	unitMismatch: z.boolean(),
	moves: mergeCountsSchema,
	onHand: z.array(
		z.object({
			locationId: z.string(),
			duplicate: z.number().int(),
			kept: z.number().int(),
			after: z.number().int(),
		}),
	),
	/** The recipe grant is missing: recipes would move, so the merge is refused. */
	needsRecipeGrant: z.boolean(),
	canApply: z.boolean(),
})
export type MergeItemPreview = z.infer<typeof mergeItemPreviewSchema>

export const mergeResultSchema = z.object({
	mergeId: z.string(),
	kind: z.enum(['item', 'supplier']),
	keptId: z.string(),
	mergedId: z.string(),
	undoUntil: z.number().int(),
	moves: z.record(z.string(), z.number().int()),
})
export type MergeResult = z.infer<typeof mergeResultSchema>

export const mergeCandidateSchema = z.object({
	id: z.string(),
	name: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	/** Why it is listed near the top: same name words, same supplier product. */
	reasons: z.array(z.enum(['name', 'supplier_product'])),
})
export const mergeCandidatesResultSchema = z.object({
	candidates: z.array(mergeCandidateSchema),
})

export const mergeSupplierBodySchema = z
	.object({
		intoSupplierId: inventoryIdSchema,
		expectedVersion: expectedVersionSchema,
		intoExpectedVersion: expectedVersionSchema,
	})
	.strict()

export const mergeSupplierPreviewSchema = z.object({
	supplierId: z.string(),
	supplierName: z.string(),
	intoSupplierId: z.string(),
	intoSupplierName: z.string(),
	blockers: z.array(blockerSchema),
	moves: z.object({
		products: z.number().int(),
		orders: z.number().int(),
		deliveries: z.number().int(),
	}),
	/** What was bought from the duplicate and is still unpaid (cost grant only). */
	unpaidMinor: minorOut,
	currency: currencyOut,
	canApply: z.boolean(),
})

/** What an item or supplier sheet shows about merges. */
export const mergeLinkSchema = z.object({
	mergeId: z.string(),
	id: z.string(),
	name: z.string(),
	undoUntil: z.number().int(),
	undone: z.boolean(),
})
export type MergeLink = z.infer<typeof mergeLinkSchema>

// ── Check your setup (#510) ─────────────────────────────────────────────────

export const SETUP_FINDING_KINDS = [
	'price_placeholder',
	'price_out_of_line',
	'unit_off_1000x',
	'recipe_no_lines',
	'recipe_archived_item',
	'made_item_no_recipe',
	'dish_no_recipe',
	'item_no_area',
] as const
export const setupFindingKindSchema = z.enum(SETUP_FINDING_KINDS)
export type SetupFindingKind = z.infer<typeof setupFindingKindSchema>

const supplierProductEvidence = z.object({
	supplierProductId: z.string(),
	supplierId: z.string(),
	supplierName: z.string(),
	itemId: z.string(),
	itemName: z.string(),
	packName: z.string(),
	packBaseQuantity: z.number().int(),
	baseUnit: inventoryBaseUnitSchema,
	priceMinor: z.number().int(),
	currency: z.string(),
})

/** What Fix does: apply a change on the server, or open the screen that fixes it. */
export const setupFixSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('apply') }),
	z.object({
		kind: z.literal('open_recipe'),
		ownerKind: usedInOwnerKindSchema,
		ownerId: z.string(),
		/** The ingredient line to select (an item id). */
		lineItemId: z.string().nullable(),
	}),
	z.object({ kind: z.literal('open_item'), itemId: z.string() }),
	z.object({
		kind: z.literal('open_supplier_product'),
		supplierId: z.string(),
		supplierProductId: z.string(),
	}),
])
export type SetupFix = z.infer<typeof setupFixSchema>

export const setupFindingSchema = z.discriminatedUnion('kind', [
	supplierProductEvidence.extend({
		kind: z.literal('price_placeholder'),
		key: z.string(),
		fingerprint: z.string(),
		fix: setupFixSchema,
	}),
	supplierProductEvidence.extend({
		kind: z.literal('price_out_of_line'),
		key: z.string(),
		fingerprint: z.string(),
		fix: setupFixSchema,
		/** The price the other suppliers (or the last delivery) imply for this pack. */
		suggestedPriceMinor: z.number().int(),
	}),
	supplierProductEvidence.extend({
		kind: z.literal('unit_off_1000x'),
		key: z.string(),
		fingerprint: z.string(),
		fix: setupFixSchema,
		suggestedPackBaseQuantity: z.number().int(),
	}),
	z.object({
		kind: z.literal('recipe_no_lines'),
		key: z.string(),
		fingerprint: z.string(),
		fix: setupFixSchema,
		ownerKind: usedInOwnerKindSchema,
		ownerId: z.string(),
	}),
	z.object({
		kind: z.literal('recipe_archived_item'),
		key: z.string(),
		fingerprint: z.string(),
		fix: setupFixSchema,
		ownerKind: usedInOwnerKindSchema,
		ownerId: z.string(),
		itemId: z.string(),
		itemName: z.string(),
	}),
	z.object({
		kind: z.literal('made_item_no_recipe'),
		key: z.string(),
		fingerprint: z.string(),
		fix: setupFixSchema,
		itemId: z.string(),
		itemName: z.string(),
	}),
	z.object({
		kind: z.literal('dish_no_recipe'),
		key: z.string(),
		fingerprint: z.string(),
		fix: setupFixSchema,
		menuItemId: z.string(),
		soldCount: z.number().int(),
	}),
	z.object({
		kind: z.literal('item_no_area'),
		key: z.string(),
		fingerprint: z.string(),
		fix: setupFixSchema,
		itemId: z.string(),
		itemName: z.string(),
		locationId: z.string(),
		suggestedAreaId: z.string(),
		suggestedAreaName: z.string(),
	}),
])
export type SetupFinding = z.infer<typeof setupFindingSchema>

/** `GET /setup-checks?locationId=` */
export const setupChecksQuerySchema = z
	.object({ locationId: inventoryLocationIdSchema })
	.strict()
export const setupChecksResultSchema = z.object({
	findings: z.array(setupFindingSchema),
	/** Findings the owner dismissed that still stand (shown nowhere, counted for "Show dismissed"). */
	dismissed: z.number().int(),
})
export type SetupChecksResult = z.infer<typeof setupChecksResultSchema>

/** `POST /setup-checks/dismiss` and `POST /setup-checks/fix` */
export const setupFindingRefSchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		key: z.string().min(1).max(200),
		fingerprint: z.string().min(1).max(500),
	})
	.strict()
export const setupFixResultSchema = z.object({ fixed: z.boolean() })
