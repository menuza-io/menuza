/**
 * Quantities typed into a stepper: "2", "2.5", "٢٫٥", "1½", "1 1/2", "3/4".
 * Arabic-Indic and Persian digits, the Arabic decimal mark (٫) and the vulgar
 * fractions read like their ASCII forms. A comma only groups thousands (threes
 * after a first group of one to three digits); any other comma ("1,5") is
 * refused, so a slip is never read as a different amount.
 */

/** Most a typed quantity may be. */
export const MAX_TYPED_QUANTITY = 1_000_000_000

const VULGAR_FRACTIONS: Readonly<Record<string, number>> = {
	'¼': 0.25,
	'½': 0.5,
	'¾': 0.75,
	'⅓': 1 / 3,
	'⅔': 2 / 3,
	'⅛': 0.125,
}

/** The text with ASCII digits and marks; invisible direction marks dropped. */
export function asciiQuantityText(input: string): string {
	return input
		.replace(/[‎‏؜]/g, '')
		.trim()
		.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
		.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
		.replace(/٫/g, '.')
		.replace(/٬/g, ',')
}

function plainNumber(text: string): number | null {
	// "2." is a number still being typed.
	if (/^\d+(?:\.\d*)?$/.test(text) || /^\.\d+$/.test(text)) return Number(text)
	if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/.test(text)) {
		return Number(text.replace(/,/g, ''))
	}
	return null
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000
}

/**
 * A typed quantity as a number (rounded to thousandths), or null when the text
 * is empty, not a quantity, negative, or above `MAX_TYPED_QUANTITY`.
 */
export function parseQuantityText(input: string): number | null {
	const text = asciiQuantityText(input)
	if (text === '') return null

	let value: number | null = null
	const vulgar = /^(.*?)\s*([¼½¾⅓⅔⅛])$/.exec(text)
	const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(text)
	const simple = /^(\d+)\/(\d+)$/.exec(text)
	if (vulgar) {
		const whole = vulgar[1] === '' ? 0 : plainNumber(vulgar[1]!)
		const fraction = VULGAR_FRACTIONS[vulgar[2]!]
		// "2.5½" is not a quantity: the whole part of a mixed number is whole.
		value =
			whole === null || fraction === undefined || !Number.isInteger(whole)
				? null
				: whole + fraction
	} else if (mixed) {
		const denominator = Number(mixed[3])
		value =
			denominator === 0
				? null
				: Number(mixed[1]) + Number(mixed[2]) / denominator
	} else if (simple) {
		const denominator = Number(simple[2])
		value = denominator === 0 ? null : Number(simple[1]) / denominator
	} else {
		value = plainNumber(text)
	}

	if (value === null || !Number.isFinite(value)) return null
	const rounded = round3(value)
	return rounded >= 0 && rounded <= MAX_TYPED_QUANTITY ? rounded : null
}

/** A quantity as the plain text a field shows: ASCII digits, up to three decimals. */
export function formatQuantityText(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return ''
	return String(round3(value))
}

/** Add `delta` to a quantity and keep it within `min`..`max` (no float drift). */
export function stepQuantity(
	value: number | null,
	delta: number,
	{ min = 0, max = MAX_TYPED_QUANTITY }: { min?: number; max?: number } = {},
): number {
	return Math.min(max, Math.max(min, round3((value ?? 0) + delta)))
}
