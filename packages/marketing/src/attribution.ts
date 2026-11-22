/** Orders and revenue credited to marketing (#115), as the region counts them. */
export type AttributionTotals = { orders: number; revenueMinor: number }
export type AttributionView = {
	currency: string
	clicked: AttributionTotals
	reached: AttributionTotals
}
export type AttributionMode = 'clicked' | 'reached'

/**
 * The figures one mode shows. "Reached" includes every "Clicked" order, so it
 * is never below it; the region guarantees that, and this keeps a stale or odd
 * answer from showing otherwise.
 */
export function attributionFigures(
	view: Pick<AttributionView, 'clicked' | 'reached'>,
	mode: AttributionMode,
): AttributionTotals {
	if (mode === 'clicked') return view.clicked
	return {
		orders: Math.max(view.reached.orders, view.clicked.orders),
		revenueMinor: Math.max(
			view.reached.revenueMinor,
			view.clicked.revenueMinor,
		),
	}
}

/** Reads the region's answer; a missing or malformed part counts as none. */
export function readAttributionView(value: unknown): AttributionView {
	const record = (value ?? {}) as Record<string, unknown>
	const totals = (raw: unknown): AttributionTotals => {
		const part = (raw ?? {}) as Record<string, unknown>
		const orders = Number(part.orders)
		const revenue = Number(part.revenueMinor)
		return {
			orders: Number.isFinite(orders) && orders > 0 ? Math.floor(orders) : 0,
			revenueMinor:
				Number.isFinite(revenue) && revenue > 0 ? Math.floor(revenue) : 0,
		}
	}
	return {
		currency:
			typeof record.currency === 'string' && record.currency
				? record.currency
				: 'usd',
		clicked: totals(record.clicked),
		reached: totals(record.reached),
	}
}

export function formatAttributionMoney(
	minor: number,
	currency: string,
	locale?: string,
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: currency.toUpperCase(),
		}).format(minor / 100)
	} catch {
		return (minor / 100).toFixed(2)
	}
}
