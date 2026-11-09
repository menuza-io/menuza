/**
 * Exact non-negative rationals over BigInt. The recipe engine keeps every
 * quantity as a fraction (usable yield, size multipliers, halves, batch
 * yields) and rounds ONCE, at the end, to a whole thousandth. That is what
 * makes the results independent of the order lines are processed in and keeps
 * "two halves equal a whole" exact.
 */
export type Fraction = { readonly n: bigint; readonly d: bigint }

export const ZERO: Fraction = { n: 0n, d: 1n }
export const ONE: Fraction = { n: 1n, d: 1n }

function gcd(a: bigint, b: bigint): bigint {
	let x = a < 0n ? -a : a
	let y = b < 0n ? -b : b
	while (y !== 0n) {
		;[x, y] = [y, x % y]
	}
	return x
}

export function frac(n: bigint | number, d: bigint | number = 1): Fraction {
	const numerator = BigInt(n)
	const denominator = BigInt(d)
	if (denominator <= 0n) throw new RangeError('denominator must be positive')
	if (numerator === 0n) return ZERO
	const divisor = gcd(numerator, denominator)
	return { n: numerator / divisor, d: denominator / divisor }
}

export function fadd(a: Fraction, b: Fraction): Fraction {
	if (a.n === 0n) return b
	if (b.n === 0n) return a
	return frac(a.n * b.d + b.n * a.d, a.d * b.d)
}

export function fmul(a: Fraction, b: Fraction): Fraction {
	if (a.n === 0n || b.n === 0n) return ZERO
	return frac(a.n * b.n, a.d * b.d)
}

export function fdiv(a: Fraction, b: Fraction): Fraction {
	if (b.n === 0n) throw new RangeError('division by zero')
	return fmul(a, { n: b.d, d: b.n })
}

/** `a - b`, never below zero. */
export function fsubFloor(a: Fraction, b: Fraction): Fraction {
	const n = a.n * b.d - b.n * a.d
	return n <= 0n ? ZERO : frac(n, a.d * b.d)
}

export function fcmp(a: Fraction, b: Fraction): number {
	const left = a.n * b.d
	const right = b.n * a.d
	return left < right ? -1 : left > right ? 1 : 0
}

export function fmin(a: Fraction, b: Fraction): Fraction {
	return fcmp(a, b) <= 0 ? a : b
}

export function isZero(a: Fraction): boolean {
	return a.n === 0n
}

/** Nearest integer, halves up. */
export function roundHalfUp(a: Fraction): bigint {
	return (2n * a.n + a.d) / (2n * a.d)
}

export function toSafeInteger(value: bigint, name: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(`${name} is out of range`)
	}
	return Number(value)
}
