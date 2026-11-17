import { z } from 'zod'

/** Per dish / option daily cap (#409). Control-plane menu data only. */
export const dailySaleLimitSchema = z
	.strictObject({
		/** Org-wide default when no per-location override. */
		limit: z.number().int().min(1).max(10_000).nullable(),
		/** When true, guests may see "Only N left" under the cap. */
		showRemaining: z.boolean().default(false),
		/** Optional per-location override by location id. */
		byLocation: z
			.record(z.string().min(1), z.number().int().min(1).max(10_000).nullable())
			.optional(),
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

export function dailySaleLimitForLocation(
	config: DailySaleLimit | null,
	locationId: string,
): number | null {
	if (!config) return null
	const atLocation = config.byLocation?.[locationId]
	if (atLocation !== undefined) return atLocation
	return config.limit
}

export const DAILY_DISH_SOLD_OUT_CODE = 'daily_dish_sold_out'

export const DAILY_DISH_LIMITS_FLAG = 'ordering.daily_dish_limits'
