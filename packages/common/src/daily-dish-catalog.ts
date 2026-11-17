import {
	type DailyDishKind,
	type DailyDishLimitsContext,
	dailyDishKey,
	dailySaleLimitForLocation,
	parseDailySaleLimit,
} from './daily-dish-limits.ts'

export type DailyDishLimitEntry = {
	/** `item:<id>` or `option:<id>`, the counter key. */
	key: string
	kind: DailyDishKind
	id: string
	/** The name an operator sees in the top-up list. */
	name: string
	/** The cap for the location, before today's top-ups. */
	limit: number
	showRemaining: boolean
}

/** What an order asks of the counters: its lines and the options on each. */
export type DailyDishDemandLine = {
	itemId: string
	quantity: number
	options?: ReadonlyArray<{ optionId: string; quantity?: number | null }>
}

/**
 * Every dish and option that has a daily cap at one location, read from the
 * order context's `dailyDishLimits` block. A per-location `null` lifts the cap
 * there. A config that cannot be read is skipped (never throws).
 */
export function collectDailyDishLimits(
	block: DailyDishLimitsContext | undefined,
	locationId: string,
): Map<string, DailyDishLimitEntry> {
	const out = new Map<string, DailyDishLimitEntry>()
	if (!block?.enabled) return out
	for (const entry of block.entries) {
		const config = parseDailySaleLimit(entry.config)
		if (!config) continue
		const limit = dailySaleLimitForLocation(config, locationId)
		if (limit == null) continue
		const key = dailyDishKey(entry.kind, entry.id)
		out.set(key, {
			key,
			kind: entry.kind,
			id: entry.id,
			name: entry.name,
			limit,
			showRemaining: config.showRemaining === true,
		})
	}
	return out
}

/** Units each counter key would use for these lines (dish quantity, and option quantity times line quantity). */
export function dailyDishDemand(
	lines: readonly DailyDishDemandLine[],
): Map<string, number> {
	const demand = new Map<string, number>()
	const bump = (key: string, units: number) => {
		if (units > 0) demand.set(key, (demand.get(key) ?? 0) + units)
	}
	for (const line of lines) {
		bump(dailyDishKey('item', line.itemId), line.quantity)
		for (const option of line.options ?? []) {
			bump(
				dailyDishKey('option', option.optionId),
				line.quantity * Math.max(1, option.quantity ?? 1),
			)
		}
	}
	return demand
}

/** Stored order lines (JSON) as demand lines; unreadable entries are skipped. */
export function dailyDishLinesFromStored(
	lines: unknown,
): DailyDishDemandLine[] {
	if (!Array.isArray(lines)) return []
	const out: DailyDishDemandLine[] = []
	for (const raw of lines) {
		if (!raw || typeof raw !== 'object') continue
		const line = raw as {
			itemId?: unknown
			quantity?: unknown
			options?: unknown
		}
		if (typeof line.itemId !== 'string' || typeof line.quantity !== 'number') {
			continue
		}
		const options: Array<{ optionId: string; quantity?: number }> = []
		if (Array.isArray(line.options)) {
			for (const option of line.options) {
				if (!option || typeof option !== 'object') continue
				const selection = option as { optionId?: unknown; quantity?: unknown }
				if (typeof selection.optionId !== 'string') continue
				options.push({
					optionId: selection.optionId,
					...(typeof selection.quantity === 'number'
						? { quantity: selection.quantity }
						: {}),
				})
			}
		}
		out.push({ itemId: line.itemId, quantity: line.quantity, options })
	}
	return out
}
