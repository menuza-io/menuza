import { isAvailable } from './availability.ts'
import { toCents } from './money.ts'
import { type MenuItem } from './types.ts'

export function lowestPriceCents(item: MenuItem): {
	cents: number
	isFrom: boolean
} {
	const available = item.variations.variants.filter((v) =>
		isAvailable(v.availabilityStatus),
	)
	if (available.length === 0)
		return { cents: toCents(item.price), isFrom: false }
	const prices = available.map((v) => toCents(v.price))
	const min = Math.min(...prices)
	return { cents: min, isFrom: prices.some((p) => p !== min) }
}
