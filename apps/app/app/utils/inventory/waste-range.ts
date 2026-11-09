/**
 * The Waste tab's period and reason live in the URL:
 * `?range=30d`, `?range=custom&from=2026-11-01&to=2026-11-07&reason=expired`.
 * Dates are the viewer's calendar days (business dates, `YYYY-MM-DD`).
 */

export const WASTE_RANGES = ['7d', '30d', 'month', 'custom'] as const
export type WasteRange = (typeof WASTE_RANGES)[number]

export const WASTE_PAGE_SIZE = 25
export const WASTE_MAX_LIMIT = 200
/** The longest custom period (the summary scans every day of it). */
export const WASTE_MAX_RANGE_DAYS = 366

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function toIsoDate(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${date.getFullYear()}-${month}-${day}`
}

function parseIsoDate(value: string | null): Date | null {
	if (!value || !DATE.test(value)) return null
	const [year, month, day] = value.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const date = new Date(year, month - 1, day)
	return date.getFullYear() === year &&
		date.getMonth() === month - 1 &&
		date.getDate() === day
		? date
		: null
}

export type ResolvedWasteRange = {
	range: WasteRange
	from: string
	to: string
	/** True when `custom` was asked for but its dates were not usable. */
	invalidCustom: boolean
}

function daysAgo(now: Date, days: number): Date {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days)
}

/** The period to show for the URL's params, always a usable `from`..`to`. */
export function resolveWasteRange(
	params: URLSearchParams,
	now: Date = new Date(),
): ResolvedWasteRange {
	const asked = params.get('range')
	const range: WasteRange = (WASTE_RANGES as readonly string[]).includes(
		asked ?? '',
	)
		? (asked as WasteRange)
		: '7d'
	const today = toIsoDate(now)
	if (range === '30d') {
		return {
			range,
			from: toIsoDate(daysAgo(now, 29)),
			to: today,
			invalidCustom: false,
		}
	}
	if (range === 'month') {
		return {
			range,
			from: toIsoDate(new Date(now.getFullYear(), now.getMonth(), 1)),
			to: today,
			invalidCustom: false,
		}
	}
	if (range === 'custom') {
		const from = parseIsoDate(params.get('from'))
		const to = parseIsoDate(params.get('to'))
		if (from && to && from <= to) {
			const span = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
			if (span <= WASTE_MAX_RANGE_DAYS) {
				return {
					range,
					from: toIsoDate(from),
					to: toIsoDate(to),
					invalidCustom: false,
				}
			}
		}
		return {
			range: '7d',
			from: toIsoDate(daysAgo(now, 6)),
			to: today,
			invalidCustom: true,
		}
	}
	return {
		range: '7d',
		from: toIsoDate(daysAgo(now, 6)),
		to: today,
		invalidCustom: false,
	}
}

/** The params after choosing a period, keeping everything else (location, reason). */
export function withWasteRange(
	current: URLSearchParams,
	range: WasteRange,
	custom?: { from: string; to: string },
): URLSearchParams {
	const next = new URLSearchParams(current)
	next.delete('limit')
	if (range === '7d') {
		next.delete('range')
		next.delete('from')
		next.delete('to')
		return next
	}
	next.set('range', range)
	if (range === 'custom' && custom) {
		next.set('from', custom.from)
		next.set('to', custom.to)
	} else {
		next.delete('from')
		next.delete('to')
	}
	return next
}

export function wasteLimit(params: URLSearchParams): number {
	const raw = Number(params.get('limit'))
	return Number.isInteger(raw) && raw >= WASTE_PAGE_SIZE
		? Math.min(raw, WASTE_MAX_LIMIT)
		: WASTE_PAGE_SIZE
}

/** Whole percent, one decimal below 10%, or null without purchases to compare with. */
export function shareOfPurchases(
	wastedMinor: number | undefined,
	purchasesMinor: number | undefined,
): number | null {
	if (wastedMinor === undefined || purchasesMinor === undefined) return null
	if (purchasesMinor <= 0) return null
	const share = (wastedMinor / purchasesMinor) * 100
	return share < 10 ? Math.round(share * 10) / 10 : Math.round(share)
}
