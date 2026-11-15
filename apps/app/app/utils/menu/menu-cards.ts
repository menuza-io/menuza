import {
	AVAILABILITY_STATUSES,
	MODIFIER_SELECTION_TYPES,
	type AvailabilityStatus,
	type ModifierSelectionType,
} from '@repo/common/menu-types'
import { z } from 'zod'

/**
 * Review cards: the generic shape behind the structure (#92) and polish
 * (#234) suggestions in the review stack. Pure, so the server (which detects,
 * plans and applies them) and the browser (which shows them) agree.
 *
 * A card carries codes and menu data only, never an English UI sentence: the
 * UI turns `kind`, option `code`s, preview `note`s and `warnings` into Lingui
 * text. Menu data (names, prices) is cleaned with `sanitizeSuggestionText`.
 *
 * Accept never sends a plan from the browser. It sends the card's `kind`,
 * `id`, `refs` and `params`; the server re-plans against the current menu,
 * refuses when any ref changed (`stale_suggestion`), and writes only the
 * closed set of operations below (`MenuCardOp`).
 */

// --- Kinds -----------------------------------------------------------------

/** #92, behind the `menu.structure_suggestions` flag (default off). */
export const MENU_STRUCTURE_CARD_KINDS = [
	'merge_duplicates',
	'make_sizes',
	'merge_categories',
	'split_add_remove',
	'make_required',
	'half_whole_toppings',
	'check_price',
] as const

/** #234, rule based, no flag. */
export const MENU_POLISH_CARD_KINDS = [
	'typo',
	'capitals',
	'missing_choice',
	'selection_limits',
	'required_first',
	'option_order',
	'no_option_style',
	'free_dish',
	'category_order',
] as const

export const MENU_CARD_KINDS = [
	...MENU_POLISH_CARD_KINDS,
	...MENU_STRUCTURE_CARD_KINDS,
] as const

export type MenuStructureCardKind = (typeof MENU_STRUCTURE_CARD_KINDS)[number]
export type MenuPolishCardKind = (typeof MENU_POLISH_CARD_KINDS)[number]
export type MenuCardKind = (typeof MENU_CARD_KINDS)[number]
export type MenuCardFamily = 'structure' | 'polish'

const STRUCTURE_KIND_SET = new Set<string>(MENU_STRUCTURE_CARD_KINDS)
const CARD_KIND_SET = new Set<string>(MENU_CARD_KINDS)

export function isMenuCardKind(kind: unknown): kind is MenuCardKind {
	return typeof kind === 'string' && CARD_KIND_SET.has(kind)
}

export function isStructureCardKind(
	kind: string,
): kind is MenuStructureCardKind {
	return STRUCTURE_KIND_SET.has(kind)
}

export function menuCardFamily(kind: MenuCardKind): MenuCardFamily {
	return isStructureCardKind(kind) ? 'structure' : 'polish'
}

// --- Card ------------------------------------------------------------------

export const MENU_CARD_ENTITY_TYPES = [
	'item',
	'category',
	'modifier_group',
	'option',
	'menu',
] as const
export type MenuCardEntityType = (typeof MENU_CARD_ENTITY_TYPES)[number]

export type MenuCardRefKey = { type: MenuCardEntityType; id: string }

/** A record Accept may touch, with the `updatedAt` the card was made from. */
export type MenuCardRef = MenuCardRefKey & { updatedAt: string }

/** One line of a before/after preview: menu data, no UI sentences. */
export type MenuCardPreviewRow = {
	text: string
	detail?: string
	price?: number | null
	change?: 'added' | 'removed' | 'changed' | 'hidden' | 'moved'
}

export type MenuCardPreviewBlock = {
	entity: MenuCardEntityType
	/** Menu data: the dish, group or category name. */
	title: string
	/** A code the UI labels, e.g. `hidden`, `new`, `required`, `optional`. */
	note?: string
	rows: MenuCardPreviewRow[]
}

export type MenuCardPreview = {
	before: MenuCardPreviewBlock[]
	after: MenuCardPreviewBlock[]
}

/** An alternative way to fix (which dish to keep, a capitals style, ...). */
export type MenuCardOption = {
	/** Stable within the card; sent back as `optionId`. */
	id: string
	/** Per-kind code the UI labels, e.g. `keep`, `set_price`, `title`. */
	code: string
	/** Menu data the label names (a dish or group name). */
	subject?: string
	preview?: MenuCardPreview
	/** Accept needs a value typed by the manager (sent back as `input`). */
	input?: 'price' | 'text' | null
	/** Codes, e.g. `shared_group`. */
	warnings?: string[]
}

/** #90 "Used in" facts for a record the default fix hides. */
export type MenuCardReference = {
	entity: MenuCardEntityType
	id: string
	name: string
	groups: Array<{ kind: string; total: number; names: string[] }>
}

export type MenuCard = {
	kind: MenuCardKind
	/** `<kind>:<primaryId>[:<hash of the other ids>]`, at most 120 characters. */
	id: string
	primary: MenuCardRefKey
	/** Cleaned menu data for the title (a dish, group or category name). */
	subject: string
	/** Every record Accept may touch, with its `updatedAt`. */
	refs: MenuCardRef[]
	/** The state the card was made from; a "not a problem" skip compares it. */
	fingerprint: string
	/** What the plan needs: ids and cleaned text only. Untrusted on Accept. */
	params: Record<string, unknown>
	preview: MenuCardPreview
	options?: MenuCardOption[]
	defaultOptionId?: string
	/** Filled by the framework for records the default fix hides. */
	references?: MenuCardReference[]
	/** Codes. */
	warnings?: string[]
	/** Optional AI-written sentence in the menu's language, cleaned. */
	explanation?: string | null
	/** True when a model contributed text to this card. */
	ai: boolean
}

/** What Accept returns and Undo sends back. */
export type MenuCardUndo = {
	snapshotId: string
	/**
	 * Existing records Accept changed, with their `updatedAt` after Accept and
	 * the columns Accept wrote (Undo puts back only those; link ends have none).
	 */
	touched: MenuCardUndoTouched[]
	/** Records Accept created (Undo deletes them), with their `updatedAt`. */
	created: MenuCardRef[]
	/**
	 * Every link Accept added, changed or removed. Undo puts back exactly
	 * these rows as the snapshot has them (or removes them), and no other
	 * link of the touched records.
	 */
	links: MenuCardLinkRef[]
	/** When Accept ran (epoch ms). Undo refuses a manifest older than a day. */
	issuedAt: number
	/**
	 * Server HMAC over the organization and everything above, so Undo only
	 * ever restores what this Accept actually changed.
	 */
	signature: string
}

export type MenuCardUndoTouched = MenuCardRef & { fields: string[] }

/** How long an Undo manifest stays valid after Accept. */
export const MENU_CARD_UNDO_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type MenuCardLinkRef = {
	link: MenuCardLink
	parentId: string
	childId: string
}

export const MENU_CARD_ERRORS = [
	/** A record changed since the card was made (or since Accept, on Undo). */
	'stale_suggestion',
	'too_few_records',
	'groups_differ',
	'invalid_keep',
	'option_in_both',
	/** The fix would change a field a POS import fills. */
	'pos_owned',
	/** The card no longer applies, or the kind has no plan. */
	'not_applicable',
	'invalid_input',
	/** Structure suggestions are off for this organization. */
	'feature_off',
	/** The Undo snapshot was pruned or belongs elsewhere. */
	'snapshot_gone',
	/** A plan wrote outside its refs or used a column it may not. A bug. */
	'invalid_plan',
	/** A History restore is running. */
	'restore_in_progress',
	/** The write failed and nothing was saved for this card. */
	'write_failed',
	/** The plan has more ops than one card may write. */
	'plan_too_large',
] as const
export type MenuCardError = (typeof MENU_CARD_ERRORS)[number]

export const MENU_CARD_SKIP_REASONS = ['not_a_problem', 'fixed_myself'] as const
export type MenuCardSkipReason = (typeof MENU_CARD_SKIP_REASONS)[number]

/** Cards one "accept several" request may carry. */
export const MENU_CARDS_PER_REQUEST = 20

export const MENU_CARD_LIMITS = {
	id: 120,
	entityId: 64,
	refs: 400,
	/** `JSON.stringify(params).length`. */
	paramsJson: 8_000,
	input: 300,
	undoTouched: 400,
	undoCreated: 60,
	undoLinks: 400,
} as const

// --- Ids and hashes --------------------------------------------------------

/**
 * A short stable hash (cyrb53, base 36, about 10 characters). Pure JS: this
 * runs in the browser bundle too. Not for security, only for ids and
 * fingerprints.
 */
export function shortHash(input: string): string {
	let h1 = 0xdeadbeef
	let h2 = 0x41c6ce57
	for (let i = 0; i < input.length; i++) {
		const ch = input.charCodeAt(i)
		h1 = Math.imul(h1 ^ ch, 2654435761)
		h2 = Math.imul(h2 ^ ch, 1597334677)
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * `<kind>:<primaryId>[:<hash of the other ids>]`. The other ids are sorted
 * first, so their order does not change the id.
 */
export function menuCardId(
	kind: MenuCardKind,
	primaryId: string,
	otherIds: readonly string[] = [],
): string {
	const base = `${kind}:${primaryId}`
	if (otherIds.length === 0) return base.slice(0, MENU_CARD_LIMITS.id)
	const hash = shortHash([...otherIds].sort().join('|'))
	return `${base}:${hash}`.slice(0, MENU_CARD_LIMITS.id)
}

/** The primary id inside a card id, or null when the id is not a card id. */
export function parseMenuCardId(
	id: string,
): { kind: MenuCardKind; primaryId: string } | null {
	const [kind, primaryId] = id.split(':')
	if (!isMenuCardKind(kind) || !primaryId) return null
	return { kind, primaryId }
}

/** The default fingerprint: the records and their edit times. */
export function menuCardFingerprint(
	refs: readonly MenuCardRef[],
	extra?: unknown,
): string {
	const parts = refs
		.map((ref) => `${ref.type}:${ref.id}:${ref.updatedAt}`)
		.sort()
	if (extra !== undefined) parts.push(JSON.stringify(extra))
	return shortHash(parts.join('|'))
}

// --- Operations (the safety boundary) ---------------------------------------

/**
 * Columns no card may ever write. Allergens, calories and dietary flags are
 * safety data: they are not in any whitelist below, and these `never` keys
 * make an object that names them a type error. `MenuCardOpSchema` refuses
 * them at runtime too.
 */
export const MENU_CARD_SAFETY_COLUMNS = [
	'allergens',
	'isGlutenFree',
	'isVegetarian',
	'isAlcohol',
	'calorieMin',
	'calorieMax',
	'calories',
] as const
type ForbiddenSafetyColumns = {
	[K in (typeof MENU_CARD_SAFETY_COLUMNS)[number]]?: never
}

export type MenuCardItemSet = {
	/** Localized JSON string, as stored. */
	displayName?: string
	description?: string | null
	price?: number
	/** `MenuVariations` JSON, as stored. */
	variations?: string
	availabilityStatus?: AvailabilityStatus
	/** ISO date or null. */
	unavailableUntil?: string | null
	position?: number
} & ForbiddenSafetyColumns

export type MenuCardCategorySet = {
	displayName?: string
	availabilityStatus?: AvailabilityStatus
	unavailableUntil?: string | null
	position?: number
} & ForbiddenSafetyColumns

export type MenuCardGroupSet = {
	name?: string
	selectionType?: ModifierSelectionType
	minSelections?: number
	maxSelections?: number | null
	position?: number
} & ForbiddenSafetyColumns

export type MenuCardOptionSet = {
	displayName?: string
	price?: number
	priceWhole?: number | null
	priceLeft?: number | null
	priceRight?: number | null
	position?: number
} & ForbiddenSafetyColumns

/** Assignment tables: parent and child as the table names them. */
export const MENU_CARD_LINKS = [
	/** OrganizationMenuCategoryAssignment: menu -> category. */
	'menu_category',
	/** OrganizationMenuItemCategoryAssignment: category -> item. */
	'item_category',
	/** OrganizationMenuItemModifierGroupAssignment: item -> modifier group. */
	'item_modifier_group',
	/** OrganizationMenuModifierGroupOptionAssignment: modifier group -> option. */
	'group_option',
] as const
export type MenuCardLink = (typeof MENU_CARD_LINKS)[number]

/** The entity types at each end of a link. */
export const MENU_CARD_LINK_ENDS: Record<
	MenuCardLink,
	{ parent: MenuCardEntityType; child: MenuCardEntityType }
> = {
	menu_category: { parent: 'menu', child: 'category' },
	item_category: { parent: 'category', child: 'item' },
	item_modifier_group: { parent: 'item', child: 'modifier_group' },
	group_option: { parent: 'modifier_group', child: 'option' },
}

/**
 * An id in an op: an existing record's id, or `new:<tempId>` for a record an
 * earlier `insert` op in the same plan creates (see `newRecordRef`).
 */
export type MenuCardIdRef = string

export const NEW_RECORD_PREFIX = 'new:'
export function newRecordRef(tempId: string): MenuCardIdRef {
	return `${NEW_RECORD_PREFIX}${tempId}`
}
export function isNewRecordRef(id: string): boolean {
	return id.startsWith(NEW_RECORD_PREFIX)
}

export type MenuCardOp =
	| { op: 'update'; entity: 'item'; id: string; set: MenuCardItemSet }
	| { op: 'update'; entity: 'category'; id: string; set: MenuCardCategorySet }
	| { op: 'update'; entity: 'modifier_group'; id: string; set: MenuCardGroupSet }
	| { op: 'update'; entity: 'option'; id: string; set: MenuCardOptionSet }
	/**
	 * A new dish is always a copy of an existing one (`copyFrom`, which must
	 * be in `refs`): allergens, dietary flags, calories, tax and photos are
	 * copied verbatim and never edited; `values` overrides only whitelisted
	 * columns.
	 */
	| {
			op: 'insert'
			entity: 'item'
			tempId: string
			copyFrom: string
			values: MenuCardItemSet & { displayName: string }
	  }
	| {
			op: 'insert'
			entity: 'category'
			tempId: string
			values: MenuCardCategorySet & { displayName: string }
	  }
	| {
			op: 'insert'
			entity: 'modifier_group'
			tempId: string
			/** `availabilityStatus` is allowed on insert only (a new group can start hidden). */
			values: MenuCardGroupSet & {
				name: string
				availabilityStatus?: AvailabilityStatus
			}
	  }
	/** With `copyFrom` (in `refs`) the option's safety data is copied verbatim. */
	| {
			op: 'insert'
			entity: 'option'
			tempId: string
			copyFrom?: string
			values: MenuCardOptionSet & { displayName: string }
	  }
	/**
	 * Add a link, or update its position (and, for `group_option`, its price
	 * overrides and default) when it exists.
	 */
	| {
			op: 'assign'
			link: Exclude<MenuCardLink, 'group_option'>
			parentId: MenuCardIdRef
			childId: MenuCardIdRef
			position?: number
	  }
	| {
			op: 'assign'
			link: 'group_option'
			parentId: MenuCardIdRef
			childId: MenuCardIdRef
			position?: number
			priceOverride?: number | null
			priceWholeOverride?: number | null
			priceLeftOverride?: number | null
			priceRightOverride?: number | null
			isDefault?: boolean
	  }
	| {
			op: 'unassign'
			link: MenuCardLink
			parentId: MenuCardIdRef
			childId: MenuCardIdRef
	  }

const Id = z.string().min(1).max(MENU_CARD_LIMITS.entityId + 8)
const TempId = z.string().min(1).max(40)
const Name = z.string().min(1).max(4_000)
const Price = z.number().finite().min(0).max(1_000_000)
const NullablePrice = Price.nullable()
const Position = z.number().int().min(0).max(100_000)
const Until = z.string().max(40).nullable()
const Availability = z.enum(AVAILABILITY_STATUSES)

const ItemSetShape = {
	displayName: Name,
	description: z.string().max(8_000).nullable(),
	price: Price,
	variations: z.string().max(20_000),
	availabilityStatus: Availability,
	unavailableUntil: Until,
	position: Position,
}
const CategorySetShape = {
	displayName: Name,
	availabilityStatus: Availability,
	unavailableUntil: Until,
	position: Position,
}
const GroupSetShape = {
	name: Name,
	selectionType: z.enum(MODIFIER_SELECTION_TYPES),
	minSelections: z.number().int().min(0).max(100),
	maxSelections: z.number().int().min(0).max(100).nullable(),
	position: Position,
}
const OptionSetShape = {
	displayName: Name,
	price: Price,
	priceWhole: NullablePrice,
	priceLeft: NullablePrice,
	priceRight: NullablePrice,
	position: Position,
}

function partialStrict<T extends z.ZodRawShape>(shape: T) {
	return z.strictObject(shape).partial()
}

const UpdateSchema = z.discriminatedUnion('entity', [
	z.strictObject({
		op: z.literal('update'),
		entity: z.literal('item'),
		id: Id,
		set: partialStrict(ItemSetShape),
	}),
	z.strictObject({
		op: z.literal('update'),
		entity: z.literal('category'),
		id: Id,
		set: partialStrict(CategorySetShape),
	}),
	z.strictObject({
		op: z.literal('update'),
		entity: z.literal('modifier_group'),
		id: Id,
		set: partialStrict(GroupSetShape),
	}),
	z.strictObject({
		op: z.literal('update'),
		entity: z.literal('option'),
		id: Id,
		set: partialStrict(OptionSetShape),
	}),
])

const InsertSchema = z.discriminatedUnion('entity', [
	z.strictObject({
		op: z.literal('insert'),
		entity: z.literal('item'),
		tempId: TempId,
		copyFrom: Id,
		values: partialStrict(ItemSetShape).required({ displayName: true }),
	}),
	z.strictObject({
		op: z.literal('insert'),
		entity: z.literal('category'),
		tempId: TempId,
		values: partialStrict(CategorySetShape).required({ displayName: true }),
	}),
	z.strictObject({
		op: z.literal('insert'),
		entity: z.literal('modifier_group'),
		tempId: TempId,
		values: partialStrict({
			...GroupSetShape,
			availabilityStatus: Availability,
		}).required({ name: true }),
	}),
	z.strictObject({
		op: z.literal('insert'),
		entity: z.literal('option'),
		tempId: TempId,
		copyFrom: Id.optional(),
		values: partialStrict(OptionSetShape).required({ displayName: true }),
	}),
])

const AssignSchema = z.union([
	z.strictObject({
		op: z.literal('assign'),
		link: z.enum(['menu_category', 'item_category', 'item_modifier_group']),
		parentId: Id,
		childId: Id,
		position: Position.optional(),
	}),
	z.strictObject({
		op: z.literal('assign'),
		link: z.literal('group_option'),
		parentId: Id,
		childId: Id,
		position: Position.optional(),
		priceOverride: NullablePrice.optional(),
		priceWholeOverride: NullablePrice.optional(),
		priceLeftOverride: NullablePrice.optional(),
		priceRightOverride: NullablePrice.optional(),
		isDefault: z.boolean().optional(),
	}),
])

const UnassignSchema = z.strictObject({
	op: z.literal('unassign'),
	link: z.enum(MENU_CARD_LINKS),
	parentId: Id,
	childId: Id,
})

/**
 * Runtime check of a plan's ops: strict objects, so an unknown column
 * (allergens included) is refused, not dropped.
 */
export const MenuCardOpSchema: z.ZodType<MenuCardOp> = z.union([
	UpdateSchema,
	InsertSchema,
	AssignSchema,
	UnassignSchema,
])

/** Most ops one card's plan may hold. */
export const MENU_CARD_MAX_OPS = 500

export const MenuCardOpsSchema = z.array(MenuCardOpSchema).max(MENU_CARD_MAX_OPS)

/**
 * Every existing record a plan writes or copies from, with its type. Link
 * ops touch both ends (their `updatedAt` is bumped). `new:` refs are left
 * out: they are created by the plan itself.
 */
export function recordsTouchedByOps(ops: readonly MenuCardOp[]): {
	touched: MenuCardRefKey[]
	copiedFrom: MenuCardRefKey[]
} {
	const touched = new Map<string, MenuCardRefKey>()
	const copiedFrom = new Map<string, MenuCardRefKey>()
	const add = (
		map: Map<string, MenuCardRefKey>,
		type: MenuCardEntityType,
		id: string,
	) => {
		if (isNewRecordRef(id)) return
		map.set(`${type}:${id}`, { type, id })
	}
	for (const op of ops) {
		switch (op.op) {
			case 'update':
				add(touched, op.entity, op.id)
				break
			case 'insert':
				if ('copyFrom' in op && op.copyFrom) {
					add(copiedFrom, op.entity, op.copyFrom)
				}
				break
			case 'assign':
			case 'unassign': {
				const ends = MENU_CARD_LINK_ENDS[op.link]
				add(touched, ends.parent, op.parentId)
				add(touched, ends.child, op.childId)
				break
			}
		}
	}
	return { touched: [...touched.values()], copiedFrom: [...copiedFrom.values()] }
}

/** Records the ops hide (`availabilityStatus: 'hidden'`), for "Used in". */
export function recordsHiddenByOps(
	ops: readonly MenuCardOp[],
): MenuCardRefKey[] {
	const hidden: MenuCardRefKey[] = []
	for (const op of ops) {
		if (op.op !== 'update') continue
		if (op.entity !== 'item' && op.entity !== 'category') continue
		if (op.set.availabilityStatus === 'hidden') {
			hidden.push({ type: op.entity, id: op.id })
		}
	}
	return hidden
}

// --- Request shapes (route bodies) -------------------------------------------

export const MenuCardRefSchema = z.object({
	type: z.enum(MENU_CARD_ENTITY_TYPES),
	id: z.string().min(1).max(MENU_CARD_LIMITS.entityId),
	updatedAt: z.string().min(1).max(40),
})

/** What the browser sends back to accept a card. */
export const MenuCardApplyInputSchema = z.object({
	kind: z.enum(MENU_CARD_KINDS),
	id: z.string().min(1).max(MENU_CARD_LIMITS.id),
	refs: z.array(MenuCardRefSchema).max(MENU_CARD_LIMITS.refs),
	params: z
		.record(z.string().max(60), z.unknown())
		.refine(
			(params) =>
				JSON.stringify(params).length <= MENU_CARD_LIMITS.paramsJson,
			{ error: 'too_large' },
		),
	optionId: z.string().min(1).max(60).optional(),
	input: z.string().max(MENU_CARD_LIMITS.input).optional(),
})
export type MenuCardApplyInput = z.infer<typeof MenuCardApplyInputSchema>

export const MenuCardUndoSchema = z.object({
	snapshotId: z.string().min(1).max(64),
	touched: z
		.array(
			MenuCardRefSchema.extend({
				fields: z.array(z.string().min(1).max(60)).max(60),
			}),
		)
		.max(MENU_CARD_LIMITS.undoTouched),
	created: z.array(MenuCardRefSchema).max(MENU_CARD_LIMITS.undoCreated),
	links: z
		.array(
			z.object({
				link: z.enum(MENU_CARD_LINKS),
				parentId: z.string().min(1).max(MENU_CARD_LIMITS.entityId),
				childId: z.string().min(1).max(MENU_CARD_LIMITS.entityId),
			}),
		)
		.max(MENU_CARD_LIMITS.undoLinks),
	issuedAt: z.number().int().positive(),
	signature: z.string().regex(/^[0-9a-f]{64}$/),
})

export const MenuCardSkipInputSchema = z.object({
	id: z.string().min(1).max(MENU_CARD_LIMITS.id),
	kind: z.enum(MENU_CARD_KINDS),
	reason: z.enum(MENU_CARD_SKIP_REASONS),
})

/** Organization-level review settings (`menu.review.settings`). */
export const CAPITAL_STYLES = ['title', 'sentence', 'upper'] as const
export type CapitalStyle = (typeof CAPITAL_STYLES)[number]

export type MenuCardSettings = {
	/** "Picked once" by the manager on the first capitals card; null until then. */
	capitalStyle: CapitalStyle | null
}

export const DEFAULT_MENU_CARD_SETTINGS: MenuCardSettings = {
	capitalStyle: null,
}

export const MenuCardSettingInputSchema = z.discriminatedUnion('key', [
	z.object({ key: z.literal('capitalStyle'), value: z.enum(CAPITAL_STYLES) }),
])
export type MenuCardSettingInput = z.infer<typeof MenuCardSettingInputSchema>
