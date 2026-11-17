import {
	type DailyDishStatusRowData,
	operatorDailyDishChangeSchema,
} from '@repo/common/daily-dish-limits'

export type DailyLimitTopUp = {
	locationId: string
	key: string
	change: { addUnits: number } | { amountLeft: number }
}

/**
 * The top-up form (`locationId`, `key`, and either `addUnits` or
 * `amountLeft`, as text) read through the same schema the region uses, so a
 * bad value is refused here before any call is made.
 */
export function parseDailyLimitTopUpForm(
	entries: Record<string, FormDataEntryValue>,
): { ok: true; data: DailyLimitTopUp } | { ok: false } {
	const body: Record<string, unknown> = {
		locationId: entries.locationId,
		key: entries.key,
	}
	for (const field of ['addUnits', 'amountLeft'] as const) {
		const raw = entries[field]
		if (typeof raw === 'string' && raw.trim() !== '') {
			body[field] = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
		}
	}
	const parsed = operatorDailyDishChangeSchema.safeParse(body)
	if (!parsed.success) return { ok: false }
	const { locationId, key, addUnits, amountLeft } = parsed.data
	return {
		ok: true,
		data: {
			locationId,
			key,
			change:
				addUnits !== undefined ? { addUnits } : { amountLeft: amountLeft! },
		},
	}
}

/** The most a dish can sell today: its limit plus what a manager added. */
export function dailyLimitAllowance(
	row: Pick<DailyDishStatusRowData, 'limit' | 'toppedUpUnits'>,
): number {
	return Math.max(0, row.limit + row.toppedUpUnits)
}
