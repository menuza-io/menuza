import { z } from 'zod'

/**
 * Daily quantity cap per dish or modifier option (#409). Control-plane menu
 * data only: it holds a number, never a guest. The region counts sales and
 * open holds against it (`order_dish_daily_counts`).
 */
export const DAILY_DISH_SOLD_OUT_CODE = 'daily_dish_sold_out'

export const DAILY_DISH_LIMITS_FLAG = 'ordering.daily_dish_limits'

/** Guests only see "Only N left" at or below this many units. */
export const DAILY_DISH_LOW_STOCK_THRESHOLD = 5

const limitUnits = z.number().int().min(1).max(10_000)

export const dailySaleLimitSchema = z
	.strictObject({
		/** Org-wide default when no per-location override. */
		limit: limitUnits.nullable(),
		/** When true, guests may see "Only N left" when the number is low. */
		showRemaining: z.boolean().default(false),
		/**
		 * Optional per-location override by location id. `null` lifts the limit at
		 * that location.
		 */
		byLocation: z.record(z.string().min(1), limitUnits.nullable()).optional(),
	})
	.superRefine((value, ctx) => {
		if (
			value.limit === null &&
			(!value.byLocation || !Object.keys(value.byLocation).length)
		) {
			ctx.addIssue({
				code: 'custom',
				message: 'Set a limit or clear the setting',
			})
		}
	})

export type DailySaleLimit = z.infer<typeof dailySaleLimitSchema>

export function parseDailySaleLimit(raw: unknown): DailySaleLimit | null {
	if (raw == null || raw === '') return null
	let candidate: unknown = raw
	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate)
		} catch {
			return null
		}
	}
	const parsed = dailySaleLimitSchema.safeParse(candidate)
	return parsed.success ? parsed.data : null
}

/**
 * Form input: a JSON string, an already-parsed object, or nothing. It becomes a
 * clean config or null. Empty clears the limit; a value that is present but not
 * a valid config is a field error (never silently dropped).
 */
export const dailySaleLimitInputSchema = z
	.unknown()
	.optional()
	.transform((raw, ctx): DailySaleLimit | null => {
		if (raw == null) return null
		let candidate: unknown = raw
		if (typeof raw === 'string') {
			const trimmed = raw.trim()
			if (trimmed === '' || trimmed === 'null') return null
			try {
				candidate = JSON.parse(trimmed)
			} catch {
				ctx.addIssue({ code: 'custom', message: 'Enter a valid daily limit' })
				return z.NEVER
			}
			if (candidate == null) return null
		}
		const parsed = dailySaleLimitSchema.safeParse(candidate)
		if (!parsed.success) {
			ctx.addIssue({
				code: 'custom',
				message: parsed.error.issues[0]?.message ?? 'Enter a valid daily limit',
			})
			return z.NEVER
		}
		return parsed.data
	})

export function serializeDailySaleLimit(
	value: DailySaleLimit | null | undefined,
): string | null {
	return value ? JSON.stringify(value) : null
}

export function dailySaleLimitForLocation(
	config: DailySaleLimit | null,
	locationId: string,
): number | null {
	if (!config) return null
	const atLocation = config.byLocation?.[locationId]
	if (atLocation !== undefined) return atLocation
	return config.limit
}

export type DailyDishKind = 'item' | 'option'

/** Counter key: `item:<menu item id>` or `option:<modifier option id>`. */
export function dailyDishKey(kind: DailyDishKind, id: string): string {
	return `${kind}:${id}`
}

export function parseDailyDishKey(
	key: string,
): { kind: DailyDishKind; id: string } | null {
	const split = key.indexOf(':')
	if (split <= 0) return null
	const kind = key.slice(0, split)
	const id = key.slice(split + 1)
	if ((kind !== 'item' && kind !== 'option') || !id) return null
	return { kind, id }
}

/**
 * Orders in these statuses hold or use stock; the rest (cancelled, expired,
 * payment review) give it back. Mirrors `RESTAURANT_ACTIVE_ORDER_STATUSES`
 * (checked in a test) and the `order_dish_daily_claims_sync` trigger in
 * tenant-db migration 0050.
 */
const CLAIMING_ORDER_STATUSES: readonly string[] = [
	'pending_acceptance',
	'accepted',
	'preparing',
	'ready',
	'completed',
]

export type DailyDishClaimState = 'held' | 'sold' | 'released'

/**
 * What an order's claim on a capped dish is: `held` while an online order
 * waits for payment (an open cart holding stock), `sold` once it counts,
 * `released` when it no longer holds stock.
 */
export function dailyDishClaimState(order: {
	status: string
	paymentMethod: string
	paymentStatus: string
}): DailyDishClaimState {
	if (!CLAIMING_ORDER_STATUSES.includes(order.status)) return 'released'
	return order.paymentMethod === 'online' && order.paymentStatus === 'pending'
		? 'held'
		: 'sold'
}

/** The units a guest can still order: the cap plus top-ups, minus sold and held. */
export function dailyDishRemaining(input: {
	limit: number
	toppedUpUnits: number
	soldUnits: number
	heldUnits: number
}): number {
	return Math.max(
		0,
		input.limit + input.toppedUpUnits - input.soldUnits - input.heldUnits,
	)
}

/**
 * "Only N left" is shown only when the operator turned it on and the number
 * is low. Sold out (0) is always shown as sold out.
 */
export function dailyDishShowsRemaining(input: {
	showRemaining: boolean
	remaining: number
}): boolean {
	return (
		input.showRemaining &&
		input.remaining > 0 &&
		input.remaining <= DAILY_DISH_LOW_STOCK_THRESHOLD
	)
}

/**
 * The order context's daily-limit block (App to region, never to a guest): the
 * flag, and every capped dish or option with its config. It rides in the
 * context, not in the public menu, so the cap itself is never published.
 */
export const dailyDishLimitsContextSchema = z.object({
	enabled: z.boolean().default(false),
	entries: z
		.array(
			z.object({
				kind: z.enum(['item', 'option']),
				id: z.string().min(1),
				/** The name an operator sees in the top-up list. */
				name: z.string(),
				/** `DailySaleLimit`, validated when read: a bad row is dropped. */
				config: z.unknown(),
			}),
		)
		.default([]),
})

export type DailyDishLimitsContext = z.infer<
	typeof dailyDishLimitsContextSchema
>

/**
 * What the region tells a guest page about a capped dish or option. Only two
 * cases appear, so a cap the operator did not choose to show never leaks:
 * sold out (`remaining: 0`) and, when "Only N left" is on, a low number.
 */
export const dailyDishAvailabilitySchema = z.record(
	z.string(),
	z.strictObject({
		/** Units still orderable today; 0 is sold out. */
		remaining: z.number().int().min(0),
		/** True only when the operator allows "Only N left" and it is low. */
		showRemaining: z.boolean(),
	}),
)

export type DailyDishAvailability = z.infer<typeof dailyDishAvailabilitySchema>

/** Largest top-up or amount-left a manager can enter, so a typo cannot run away. */
export const DAILY_DISH_MAX_UNITS = 10_000

const dailyDishKeySchema = z
	.string()
	.min(3)
	.max(220)
	.refine((key) => parseDailyDishKey(key) !== null, {
		message: 'Not a daily limit key',
	})

/**
 * A manager's change to one capped dish or option: add units (a fresh batch
 * came out) or state the amount left (a count at the pass), exactly one.
 */
export const dailyDishChangeBodySchema = z
	.strictObject({
		key: dailyDishKeySchema,
		addUnits: z.number().int().min(1).max(DAILY_DISH_MAX_UNITS).optional(),
		amountLeft: z.number().int().min(0).max(DAILY_DISH_MAX_UNITS).optional(),
	})
	.refine(
		(body) => (body.addUnits === undefined) !== (body.amountLeft === undefined),
		{
			message: 'Send addUnits or amountLeft, not both',
			path: ['addUnits'],
		},
	)

export type DailyDishChangeBody = z.infer<typeof dailyDishChangeBodySchema>

/** The App's operator route also names the location (Station's is server-bound). */
export const operatorDailyDishChangeSchema = z
	.strictObject({
		locationId: z.string().min(1).max(100),
		key: dailyDishKeySchema,
		addUnits: z.number().int().min(1).max(DAILY_DISH_MAX_UNITS).optional(),
		amountLeft: z.number().int().min(0).max(DAILY_DISH_MAX_UNITS).optional(),
	})
	.refine(
		(body) => (body.addUnits === undefined) !== (body.amountLeft === undefined),
		{
			message: 'Send addUnits or amountLeft, not both',
			path: ['addUnits'],
		},
	)

export const operatorDailyDishStatusQuerySchema = z.strictObject({
	locationId: z.string().min(1).max(100),
})

/** One row of today's list as it goes to the App and Station. */
export const dailyDishStatusRowSchema = z.object({
	key: z.string(),
	kind: z.enum(['item', 'option']),
	id: z.string(),
	name: z.string(),
	limit: z.number().int(),
	showRemaining: z.boolean(),
	toppedUpUnits: z.number().int(),
	soldUnits: z.number().int(),
	heldUnits: z.number().int(),
	remaining: z.number().int(),
})

export const dailyDishStatusSchema = z.object({
	enabled: z.boolean(),
	businessDate: z.string(),
	rows: z.array(dailyDishStatusRowSchema),
})

export type DailyDishStatusRowData = z.infer<typeof dailyDishStatusRowSchema>
export type DailyDishStatusData = z.infer<typeof dailyDishStatusSchema>
