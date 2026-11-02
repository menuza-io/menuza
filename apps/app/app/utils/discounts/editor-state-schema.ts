import {
	DISCOUNT_APPLICATION_VALUES,
	DISCOUNT_CHANNEL_VALUES,
	DISCOUNT_COMBINE_CLASS_VALUES,
	DISCOUNT_ELIGIBILITY_VALUES,
	DISCOUNT_FULFILLMENT_VALUES,
	DISCOUNT_LIMIT_PERIOD_VALUES,
	DISCOUNT_TIER_BASIS_VALUES,
	DISCOUNT_TOTAL_LIMIT_PRESETS,
	DISCOUNT_VALUE_TYPE_VALUES,
} from '@repo/discounts'
import { z } from 'zod'
import {
	type EditorState,
	type ItemGroupState,
	type TotalLimitChoice,
} from './editor-model.ts'

/**
 * The shape of the editor state the discount form posts. The server parses it
 * with this before `stateToDefinition` reads it, so a hand-made payload is a
 * bad request instead of a crash. The bounds only cap the payload: the
 * discount's real limits (name length, how many items or codes) stay in
 * `stateToDefinition`, which marks the field that breaks them.
 */

/** Typed text the editor parses later (amounts, counts, dates). */
const typed = z.string().max(64)
const text = z.string().max(500)
const id = z.string().min(1).max(200)
const idList = z.array(id).max(2000)
/** "Only these options" rows: an option type and the values that qualify. */
const variantRows = z
	.array(
		z.object({
			group: z.string().max(200),
			values: z.array(z.string().max(200)).max(500),
		}),
	)
	.max(20)
/** Guest-facing text by website language. */
const localizedText = z
	.record(z.string().regex(/^[a-z]{2,3}$/), text)
	.refine((map) => Object.keys(map).length <= 20)
/** A stable React key the client makes up. */
const key = z.string().max(100)

const TOTAL_LIMIT_CHOICES = [
	'unlimited',
	'custom',
	...DISCOUNT_TOTAL_LIMIT_PRESETS.map(
		(preset) => String(preset) as `${typeof preset}`,
	),
] as [TotalLimitChoice, ...TotalLimitChoice[]]

const itemGroupSchema = z.object({
	quantity: typed,
	itemIds: idList,
	categoryIds: idList,
	variants: variantRows,
	by: z.enum(['quantity', 'spend']),
	spend: typed,
})

export const editorStateSchema = z.object({
	name: localizedText,
	internalName: text,
	description: localizedText,
	application: z.enum(DISCOUNT_APPLICATION_VALUES),
	valueType: z.enum(DISCOUNT_VALUE_TYPE_VALUES),
	percent: typed,
	amount: typed,
	maxDiscount: typed,
	tiersOn: z.boolean(),
	tierBasis: z.enum(DISCOUNT_TIER_BASIS_VALUES),
	tiers: z.array(z.object({ key, at: typed, value: typed })).max(100),
	maxDeliveryFee: typed,
	scope: z.enum(['order', 'items', 'categories', 'modifiers']),
	modifierGroupIds: idList,
	modifierOptionIds: idList,
	variants: variantRows,
	itemIds: idList,
	categoryIds: idList,
	excludeItemIds: idList,
	excludeCategoryIds: idList,
	requireOn: z.boolean(),
	requireQuantity: typed,
	requireItemIds: idList,
	requireCategoryIds: idList,
	quantityKind: z.enum([
		'none',
		'exact',
		'minimum',
		'bogo',
		'buy_get',
		'bundle',
		'per_item',
	]),
	perItemN: typed,
	buyGroup: itemGroupSchema,
	getGroup: itemGroupSchema,
	bundleSlots: z.array(itemGroupSchema.extend({ key })).max(50),
	quantityN: typed,
	buyQuantity: typed,
	getQuantity: typed,
	maxUnits: typed,
	minSubtotal: typed,
	allLocations: z.boolean(),
	locationIds: idList,
	channels: z.array(z.enum(DISCOUNT_CHANNEL_VALUES)).max(20),
	fulfillments: z.array(z.enum(DISCOUNT_FULFILLMENT_VALUES)).max(20),
	includeDrops: z.boolean(),
	startsAt: typed,
	endsAt: typed,
	hoursOn: z.boolean(),
	schedule: z
		.array(
			z.object({
				day: z.number().int().min(0).max(6),
				start: typed,
				end: typed,
			}),
		)
		.max(200),
	eligibility: z.enum(DISCOUNT_ELIGIBILITY_VALUES),
	totalLimit: z.enum(TOTAL_LIMIT_CHOICES),
	totalLimitCustom: typed,
	perCustomerOn: z.boolean(),
	perCustomerCount: typed,
	perCustomerPeriod: z.enum(DISCOUNT_LIMIT_PERIOD_VALUES),
	codes: z
		.array(
			z.object({
				key,
				id: id.nullable(),
				code: z.string().max(100),
				maxUses: typed,
			}),
		)
		.max(1000),
	combinesWith: z.array(z.enum(DISCOUNT_COMBINE_CLASS_VALUES)).max(10),
	priority: typed,
	promoteOnMenu: z.boolean(),
	requireApproval: z.boolean(),
}) satisfies z.ZodType<EditorState>

/** The most characters of posted editor state the server reads. */
export const EDITOR_STATE_MAX_LENGTH = 500_000

/** The posted `state` field as editor state, or null when it is malformed. */
export function parseEditorStateField(value: unknown): EditorState | null {
	if (typeof value !== 'string' || value.length > EDITOR_STATE_MAX_LENGTH) {
		return null
	}
	let raw: unknown
	try {
		raw = JSON.parse(value)
	} catch {
		return null
	}
	const parsed = editorStateSchema.safeParse(raw)
	return parsed.success ? parsed.data : null
}

/** The organization's own ids a discount may name. */
export type OrganizationDiscountIds = {
	locationIds: ReadonlySet<string>
	itemIds: ReadonlySet<string>
	categoryIds: ReadonlySet<string>
	modifierGroupIds: ReadonlySet<string>
	modifierOptionIds: ReadonlySet<string>
}

/**
 * Keeps only ids that belong to the organization: a posted id from another
 * organization, or one deleted since the editor opened, is dropped. Dropping
 * never widens a discount: a list it empties fails `stateToDefinition`
 * ("choose one"), and an excluded id that is not on this menu can't be in a
 * cart anyway. Option filters are names, not ids, so they are left as they
 * are (dropping "Large" would turn "Large only" into "any size").
 */
export function keepOrganizationIds(
	state: EditorState,
	ids: OrganizationDiscountIds,
): EditorState {
	const keep = (list: readonly string[], allowed: ReadonlySet<string>) =>
		list.filter((value) => allowed.has(value))
	const group = <T extends ItemGroupState>(input: T): T => ({
		...input,
		itemIds: keep(input.itemIds, ids.itemIds),
		categoryIds: keep(input.categoryIds, ids.categoryIds),
	})
	return {
		...state,
		locationIds: keep(state.locationIds, ids.locationIds),
		itemIds: keep(state.itemIds, ids.itemIds),
		categoryIds: keep(state.categoryIds, ids.categoryIds),
		excludeItemIds: keep(state.excludeItemIds, ids.itemIds),
		excludeCategoryIds: keep(state.excludeCategoryIds, ids.categoryIds),
		requireItemIds: keep(state.requireItemIds, ids.itemIds),
		requireCategoryIds: keep(state.requireCategoryIds, ids.categoryIds),
		modifierGroupIds: keep(state.modifierGroupIds, ids.modifierGroupIds),
		modifierOptionIds: keep(state.modifierOptionIds, ids.modifierOptionIds),
		buyGroup: group(state.buyGroup),
		getGroup: group(state.getGroup),
		bundleSlots: state.bundleSlots.map(group),
	}
}
