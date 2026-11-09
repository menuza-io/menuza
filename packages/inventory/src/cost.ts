/**
 * Item costs. A cost is stored as an integer number of MICRO-MINOR units
 * (millionths of a cent or halala) per ONE base unit (1 g, 1 ml, 1 piece).
 * Bulk goods cost fractions of a minor unit per gram, which an integer minor
 * column would round away and a float would drift; a millionth keeps six
 * decimals for the cheapest goods and stays far below 2^53 for the dearest.
 * Quantities are thousandths of the base unit (see `units.ts`), so the value
 * of quantity `q` at cost `c` is `q * c / 1e9` minor units. All products go
 * through BigInt, so large quantities never lose precision.
 */
export const COST_MICRO_PER_MINOR = 1_000_000

/** Divisor from (thousandths x micro-minor) to minor: 1000 x 1_000_000. */
const VALUE_DIVISOR = 1_000_000_000n

function assertInt(value: number, name: string, min = 0): void {
	if (!Number.isSafeInteger(value) || value < min) {
		throw new RangeError(`${name} must be a safe integer >= ${min}`)
	}
}

/** Integer division of BigInts, rounding halves away from zero. */
function divRoundHalfUp(numerator: bigint, divisor: bigint): bigint {
	const negative = numerator < 0n
	const abs = negative ? -numerator : numerator
	const quotient = (abs + divisor / 2n) / divisor
	return negative ? -quotient : quotient
}

function toSafeNumber(value: bigint, name: string): number {
	if (
		value > BigInt(Number.MAX_SAFE_INTEGER) ||
		value < BigInt(Number.MIN_SAFE_INTEGER)
	) {
		throw new RangeError(`${name} is out of range`)
	}
	return Number(value)
}

/**
 * Cost per base unit of a pack priced `priceMinor` that holds
 * `packQuantity` base thousandths (a SAR 280 box of 10 kg: 28000, 10_000_000
 * → 2_800_000 micro-halalas per gram).
 */
export function costMicroFromPackPrice(
	priceMinor: number,
	packQuantity: number,
): number {
	assertInt(priceMinor, 'priceMinor')
	assertInt(packQuantity, 'packQuantity', 1)
	return toSafeNumber(
		divRoundHalfUp(BigInt(priceMinor) * VALUE_DIVISOR, BigInt(packQuantity)),
		'cost',
	)
}

/**
 * Value in minor units of `quantity` base thousandths at `costMicro`. Signed
 * quantities give signed values (stock out is negative).
 */
export function inventoryValueMinor(
	quantity: number,
	costMicro: number,
): number {
	assertInt(quantity, 'quantity', Number.MIN_SAFE_INTEGER)
	assertInt(costMicro, 'costMicro')
	return toSafeNumber(
		divRoundHalfUp(BigInt(quantity) * BigInt(costMicro), VALUE_DIVISOR),
		'value',
	)
}

/**
 * The moving weighted average after a delivery: what was on hand at the old
 * average plus what arrived at its price, over the new total. Stock already
 * below zero (sales recorded before a count) counts as none, so a negative
 * estimate never drags the average. With nothing on hand, the delivery price
 * becomes the average.
 */
export function weightedAverageCostMicro(input: {
	onHandQuantity: number
	averageCostMicro: number | null
	receivedQuantity: number
	receivedCostMicro: number
}): number {
	assertInt(input.receivedQuantity, 'receivedQuantity')
	assertInt(input.receivedCostMicro, 'receivedCostMicro')
	assertInt(input.onHandQuantity, 'onHandQuantity', Number.MIN_SAFE_INTEGER)
	const onHand =
		input.averageCostMicro === null ? 0 : Math.max(0, input.onHandQuantity)
	if (input.averageCostMicro !== null) {
		assertInt(input.averageCostMicro, 'averageCostMicro')
	}
	const total = BigInt(onHand) + BigInt(input.receivedQuantity)
	if (total === 0n) return input.averageCostMicro ?? input.receivedCostMicro
	const weighted =
		BigInt(onHand) * BigInt(input.averageCostMicro ?? 0) +
		BigInt(input.receivedQuantity) * BigInt(input.receivedCostMicro)
	return toSafeNumber(divRoundHalfUp(weighted, total), 'average cost')
}
