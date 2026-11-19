import { z } from 'zod'

/**
 * Saved audiences (#98): "all of" / "any of" rules over what guests did (orders,
 * visits, loyalty, profile). Pure: the App validates what the operator builds,
 * tenant-api compiles the same definition to SQL against the regional database.
 *
 * Rules hold numbers and ids only, never a name, phone, email, tag or allergy
 * note, so a definition is safe to keep and to show anywhere. An audience only
 * ever NARROWS who may be messaged: consent is judged first and always.
 */

export const AUDIENCE_LIMITS = {
	/** Saved audiences per organization. */
	audiences: 50,
	/** Rules in one audience. */
	rules: 20,
	nameMax: 80,
	/** Counts below this are shown as "fewer than 5". */
	countFloor: 5,
	maxWindowDays: 730,
} as const

export const AUDIENCE_ERROR_CODES = [
	'audience_not_found',
	'audience_in_use',
	'audience_limit',
	'audience_name_taken',
	'audience_version_changed',
	'invalid_audience',
	'sensitive_rule_not_allowed',
	'location_out_of_scope',
] as const
export type AudienceErrorCode = (typeof AUDIENCE_ERROR_CODES)[number]

const compare = z.enum(['gte', 'lte', 'eq'])
const count = z.number().int().min(0).max(1_000_000)
const days = z.number().int().min(0).max(3650)
const windowDays = z.number().int().min(1).max(AUDIENCE_LIMITS.maxWindowDays)
const locationIds = z.array(z.string().min(1).max(100)).min(1).max(50)

export const audienceRuleSchema = z.discriminatedUnion('field', [
	/** Orders that count (paid online, or accepted at pickup; Station sales of a linked guest). */
	z
		.object({
			field: z.literal('orders_count'),
			op: compare,
			value: count,
			windowDays: windowDays.optional(),
			locationIds: locationIds.optional(),
		})
		.strict(),
	/** Net spend in minor units (refunds taken off). */
	z
		.object({
			field: z.literal('spend'),
			op: compare,
			value: count,
			windowDays: windowDays.optional(),
			locationIds: locationIds.optional(),
		})
		.strict(),
	/** Days since the guest's last order; only guests who ordered at least once. */
	z
		.object({
			field: z.literal('days_since_last_order'),
			op: compare,
			value: days,
			locationIds: locationIds.optional(),
		})
		.strict(),
	/** The biggest spenders: the top `percent` by net spend over the window. */
	z
		.object({
			field: z.literal('top_spenders'),
			percent: z.number().int().min(1).max(50),
			windowDays,
		})
		.strict(),
	z.object({ field: z.literal('visits'), op: compare, value: count }).strict(),
	z
		.object({
			field: z.literal('days_since_last_visit'),
			op: compare,
			value: days,
		})
		.strict(),
	z
		.object({
			field: z.literal('has_upcoming_reservation'),
			value: z.boolean(),
		})
		.strict(),
	z.object({ field: z.literal('loyalty_member'), value: z.boolean() }).strict(),
	z
		.object({ field: z.literal('loyalty_points'), op: compare, value: count })
		.strict(),
	/** Members whose points are within `withinPercent` of the cheapest active reward, but not past it. */
	z
		.object({
			field: z.literal('loyalty_near_reward'),
			withinPercent: z.number().int().min(1).max(90),
		})
		.strict(),
	z
		.object({
			field: z.literal('loyalty_tier'),
			tierId: z.string().trim().min(1).max(64),
		})
		.strict(),
	z.object({ field: z.literal('phone_verified'), value: z.boolean() }).strict(),
	z
		.object({ field: z.literal('joined_within_days'), value: windowDays })
		.strict(),
])
export type AudienceRule = z.infer<typeof audienceRuleSchema>
export type AudienceRuleField = AudienceRule['field']

export const audienceDefinitionSchema = z
	.object({
		match: z.enum(['all', 'any']),
		rules: z.array(audienceRuleSchema).min(1).max(AUDIENCE_LIMITS.rules),
	})
	.strict()
export type AudienceDefinition = z.infer<typeof audienceDefinitionSchema>

export const audienceNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(AUDIENCE_LIMITS.nameMax)

export const saveAudienceSchema = z
	.object({
		name: audienceNameSchema,
		definition: audienceDefinitionSchema,
		/** The version the editor loaded; a stale save is refused. */
		expectedVersion: z.number().int().min(1).optional(),
	})
	.strict()
export type SaveAudienceInput = z.infer<typeof saveAudienceSchema>

/** A broadcast or an automation points at an audience by id and the version it was saved with. */
export const audienceRefSchema = z
	.object({
		audienceId: z.string().min(1).max(100),
		audienceVersion: z.number().int().min(1).optional(),
	})
	.strict()
export type AudienceRef = z.infer<typeof audienceRefSchema>

/**
 * Words that mark a sensitive rule: tags, allergy and dietary notes, health,
 * religion. The closed rule list above has no such field; this refuses a
 * request that names one with its own error instead of a generic schema one.
 */
const SENSITIVE_PATTERN =
	/tag|allerg|dietar|sensitive|medical|health|religio|disab|note|vip/i

/** True when a raw definition names a sensitive field anywhere (keys and `field` values). */
export function namesSensitiveRule(raw: unknown, depth = 0): boolean {
	if (depth > 6 || raw === null || typeof raw !== 'object') return false
	if (Array.isArray(raw))
		return raw.some((v) => namesSensitiveRule(v, depth + 1))
	for (const [key, value] of Object.entries(raw)) {
		if (SENSITIVE_PATTERN.test(key)) return true
		if (key === 'field' && typeof value === 'string') {
			if (SENSITIVE_PATTERN.test(value)) return true
		}
		if (namesSensitiveRule(value, depth + 1)) return true
	}
	return false
}

/** A count for display: below the floor it is not shown (`null`: "fewer than 5"). */
export function floorAudienceCount(value: number): number | null {
	return value < AUDIENCE_LIMITS.countFloor ? null : value
}

export type AudienceCounts = {
	/** Everyone matching, whatever their consent. Null: fewer than the floor. */
	size: number | null
	/** Of those, who may be emailed now. Null: fewer than the floor. */
	email: number | null
	/** Of those, who may be texted now. Null: fewer than the floor. */
	sms: number | null
}

/** Rules that look at locations: the ids they name, for the scope check. */
export function audienceLocationIds(definition: AudienceDefinition): string[] {
	const ids = new Set<string>()
	for (const rule of definition.rules) {
		if ('locationIds' in rule && rule.locationIds) {
			for (const id of rule.locationIds) ids.add(id)
		}
	}
	return [...ids]
}

/** Whether any rule looks at orders (the audiences tab hides these without ordering). */
export function audienceUsesOrders(definition: AudienceDefinition): boolean {
	return definition.rules.some(
		(rule) =>
			rule.field === 'orders_count' ||
			rule.field === 'spend' ||
			rule.field === 'days_since_last_order' ||
			rule.field === 'top_spenders',
	)
}

/**
 * Ready-made audiences added on first visit. `key` is stable so a second visit
 * never adds them again; an operator may edit or delete them like any other.
 */
export const READY_MADE_AUDIENCES: ReadonlyArray<{
	key: string
	name: string
	definition: AudienceDefinition
}> = [
	{
		key: 'lapsed_60',
		name: 'Lapsed 60 days',
		definition: {
			match: 'all',
			rules: [{ field: 'days_since_last_order', op: 'gte', value: 60 }],
		},
	},
	{
		key: 'top_spenders_90',
		name: 'Top 10% spenders (90 days)',
		definition: {
			match: 'all',
			rules: [{ field: 'top_spenders', percent: 10, windowDays: 90 }],
		},
	},
	{
		key: 'new_this_month',
		name: 'New this month',
		definition: {
			match: 'all',
			rules: [{ field: 'joined_within_days', value: 30 }],
		},
	},
	{
		key: 'loyalty_near_reward',
		name: 'Loyalty members near a reward',
		definition: {
			match: 'all',
			rules: [
				{ field: 'loyalty_member', value: true },
				{ field: 'loyalty_near_reward', withinPercent: 20 },
			],
		},
	},
]
