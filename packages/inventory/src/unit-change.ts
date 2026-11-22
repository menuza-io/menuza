import { type InventoryBaseUnit } from './units.ts'

/**
 * Changing an item's base unit (#494), pure. A change is an equation the
 * person types ("1 piece = 180 g": `oldAmount` of the old unit equals
 * `newAmount` of the new one) and becomes the exact fraction
 * `new thousandths = old thousandths * num / den`. Every stored quantity of
 * the item converts with that one fraction, rounded half up; the cost per
 * base unit converts with the inverse, so a quantity times its cost stays the
 * same money.
 */

export type Fraction = { num: number; den: number }

const MAX_FACTOR_PART = 1_000_000_000_000

function gcd(a: bigint, b: bigint): bigint {
	let x = a < 0n ? -a : a
	let y = b < 0n ? -b : b
	while (y !== 0n) {
		;[x, y] = [y, x % y]
	}
	return x
}

/** `"180"` or `"1.03"` as an exact positive scaled integer, or null. */
function scaled(amount: string): { value: bigint; scale: bigint } | null {
	const trimmed = amount.trim()
	const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(trimmed)
	if (!match) return null
	const decimals = match[2] ?? ''
	const value = BigInt(match[1]! + decimals)
	if (value <= 0n) return null
	return { value, scale: 10n ** BigInt(decimals.length) }
}

export type ConversionResult =
	| { ok: true; factor: Fraction }
	| { ok: false; reason: 'invalid_amount' | 'out_of_range' }

/**
 * The factor of the equation `oldAmount old = newAmount new`:
 * `newAmount / oldAmount`, reduced. Both amounts are plain decimals with at
 * most six decimal places.
 */
export function conversionFactor(
	oldAmount: string,
	newAmount: string,
): ConversionResult {
	const a = scaled(oldAmount)
	const b = scaled(newAmount)
	if (!a || !b) return { ok: false, reason: 'invalid_amount' }
	// (b.value / b.scale) / (a.value / a.scale) = (b.value * a.scale) / (a.value * b.scale)
	let num = b.value * a.scale
	let den = a.value * b.scale
	const divisor = gcd(num, den)
	num /= divisor
	den /= divisor
	if (
		num > BigInt(MAX_FACTOR_PART) ||
		den > BigInt(MAX_FACTOR_PART) ||
		num < 1n ||
		den < 1n
	) {
		return { ok: false, reason: 'out_of_range' }
	}
	return { ok: true, factor: { num: Number(num), den: Number(den) } }
}

/** `round(quantity * factor)` half away from zero, exact with BigInt. */
export function convertQuantity(quantity: number, factor: Fraction): number {
	if (quantity === 0) return 0
	const negative = quantity < 0
	const abs = BigInt(Math.abs(quantity))
	const num = abs * BigInt(factor.num)
	const den = BigInt(factor.den)
	const rounded = (num * 2n + den) / (den * 2n)
	const value = Number(rounded)
	if (!Number.isSafeInteger(value)) throw new RangeError('Quantity too large')
	return negative ? -value : value
}

/**
 * A cost per base unit (micro-minor) in the new unit: the inverse factor, so
 * `quantity * cost` keeps its value. Rounded half up; never below one
 * micro-minor for a priced item (zero would turn a price into "free").
 */
export function convertCostMicro(cost: number, factor: Fraction): number {
	if (cost === 0) return 0
	const num = BigInt(cost) * BigInt(factor.den)
	const den = BigInt(factor.num)
	const rounded = (num * 2n + den) / (den * 2n)
	return Math.max(1, Number(rounded))
}

/** The same change seen from the other side (used to convert history back). */
export function invertFactor(factor: Fraction): Fraction {
	return { num: factor.den, den: factor.num }
}

/** Every base unit may become either of the others (with a conversion). */
export function changeableTargets(
	from: InventoryBaseUnit,
): InventoryBaseUnit[] {
	return (['g', 'ml', 'piece'] as const).filter((unit) => unit !== from)
}

/** A recorded change, as readers of history need it. */
export type UnitChangeRecord = { at: number; factor: Fraction }

/**
 * A quantity written at `writtenAt` expressed in the item's current unit:
 * every change completed after it applies, oldest first. History rows are
 * never rewritten; every reader that sums or shows old quantities calls this.
 */
export function quantityInCurrentUnit(
	quantity: number,
	writtenAt: number,
	changes: readonly UnitChangeRecord[],
): number {
	let value = quantity
	for (const change of changes) {
		if (writtenAt < change.at) value = convertQuantity(value, change.factor)
	}
	return value
}
