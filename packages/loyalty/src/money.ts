import { z } from 'zod'

/**
 * Integer money and point arithmetic. Money is always integer minor units
 * (cents, halalas) with an explicit ISO currency; percentages are basis points
 * (1% = 100 bp). Products go through BigInt so large carts never lose
 * precision, and every rounding direction is explicit.
 */

/** Largest money amount accepted anywhere in loyalty (10 billion major units). */
export const LOYALTY_MAX_MINOR = 1_000_000_000_000
/** Largest point amount on a single entry or reward. */
export const LOYALTY_MAX_POINTS = 100_000_000
export const BASIS_POINTS = 10_000

export const minorSchema = z.number().int().min(0).max(LOYALTY_MAX_MINOR)
export const positiveMinorSchema = minorSchema.min(1)
export const currencySchema = z
	.string()
	.regex(/^[A-Z]{3}$/, 'currency must be a 3-letter uppercase ISO code')

export type Rounding = 'floor' | 'ceil' | 'half_up'

function assertNonNegativeInt(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer`)
	}
}

/** `a * b / c` for non-negative integers, rounded as asked. */
export function mulDiv(
	a: number,
	b: number,
	c: number,
	rounding: Rounding = 'floor',
): number {
	assertNonNegativeInt(a, 'a')
	assertNonNegativeInt(b, 'b')
	assertNonNegativeInt(c, 'c')
	if (c === 0) throw new RangeError('division by zero')
	const numerator = BigInt(a) * BigInt(b)
	const divisor = BigInt(c)
	let quotient = numerator / divisor
	const remainder = numerator % divisor
	if (remainder !== 0n) {
		if (rounding === 'ceil') quotient += 1n
		else if (rounding === 'half_up' && remainder * 2n >= divisor) quotient += 1n
	}
	const result = Number(quotient)
	if (!Number.isSafeInteger(result)) throw new RangeError('result overflow')
	return result
}

/**
 * Split `total` across `weights` in proportion, by largest remainder. Ties go
 * to the earlier index, so the same input always gives the same split. The
 * shares sum to `total`; when `total <= sum(weights)` no share exceeds its
 * weight. All weights zero puts everything on the first entry.
 */
export function allocateProportionally(
	total: number,
	weights: readonly number[],
): number[] {
	assertNonNegativeInt(total, 'total')
	if (weights.length === 0) {
		if (total !== 0) throw new RangeError('nothing to allocate to')
		return []
	}
	for (const weight of weights) assertNonNegativeInt(weight, 'weight')
	const sum = weights.reduce((acc, weight) => acc + weight, 0)
	if (sum === 0) return weights.map((_, index) => (index === 0 ? total : 0))
	const bigTotal = BigInt(total)
	const bigSum = BigInt(sum)
	const shares = weights.map((weight) => {
		const numerator = bigTotal * BigInt(weight)
		return { floor: numerator / bigSum, remainder: numerator % bigSum }
	})
	let left = total - shares.reduce((acc, share) => acc + Number(share.floor), 0)
	const order = shares
		.map((share, index) => ({ index, remainder: share.remainder }))
		.sort((a, b) =>
			a.remainder === b.remainder
				? a.index - b.index
				: a.remainder > b.remainder
					? -1
					: 1,
		)
	const result = shares.map((share) => Number(share.floor))
	for (const { index } of order) {
		if (left <= 0) break
		result[index]! += 1
		left -= 1
	}
	return result
}

/** Tax contained in a tax-inclusive amount, the way the order engines round it. */
export function inclusiveTaxMinor(
	amountMinor: number,
	taxRatePercent: number,
): number {
	const rate = Math.max(0, Math.min(100, taxRatePercent || 0))
	if (!(rate > 0) || !(amountMinor > 0)) return 0
	return Math.round((amountMinor * rate) / (100 + rate))
}

export function sumMinor(values: readonly number[]): number {
	return values.reduce((acc, value) => acc + value, 0)
}

export function normalizeCurrency(value: string): string {
	return value.trim().toUpperCase()
}

export function sameCurrency(a: string, b: string): boolean {
	return normalizeCurrency(a) === normalizeCurrency(b)
}
