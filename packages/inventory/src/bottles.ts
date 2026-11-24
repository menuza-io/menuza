import { z } from 'zod'

/**
 * Counting by bottle (#470): items whose base unit is millilitres (spirits,
 * wine, syrups). A person counts whole full bottles and the open bottle either
 * in tenths (a slider on the bottle shape) or by weight on a scale (typed; no
 * Bluetooth). Everything resolves to millilitres, the amount a count entry
 * stores as before (`{ amount: ml, unit: 'ml' }`), so expected versus counted
 * works in ml exactly as for any other item.
 */

/** Largest bottle, millilitres (a 5 litre jug). */
export const MAX_BOTTLE_SIZE_ML = 5000
/** Largest bottle weight, grams. */
export const MAX_BOTTLE_WEIGHT_G = 10_000
/** Whole bottles in one entry. */
export const MAX_WHOLE_BOTTLES = 10_000

export const bottleSizeMlSchema = z
	.number()
	.int()
	.min(1)
	.max(MAX_BOTTLE_SIZE_ML)
export const bottleWeightGSchema = z
	.number()
	.int()
	.min(1)
	.max(MAX_BOTTLE_WEIGHT_G)

/** What an item stores to be counted by bottle. */
export type BottleSpec = {
	sizeMl: number
	/** Grams of a full bottle; with the empty weight it enables counting by weight. */
	fullWeightG: number | null
	emptyWeightG: number | null
}

export type BottleSpecProblem =
	'size_required' | 'weights_pair' | 'full_not_heavier'

/**
 * Why a bottle spec cannot be saved, or null when it is fine. Weights are both
 * set or both empty, and a full bottle weighs more than an empty one.
 */
export function bottleSpecProblem(spec: {
	sizeMl: number | null
	fullWeightG: number | null
	emptyWeightG: number | null
}): BottleSpecProblem | null {
	if (spec.sizeMl === null || spec.sizeMl < 1) return 'size_required'
	const hasFull = spec.fullWeightG !== null
	const hasEmpty = spec.emptyWeightG !== null
	if (hasFull !== hasEmpty) return 'weights_pair'
	if (
		spec.fullWeightG !== null &&
		spec.emptyWeightG !== null &&
		spec.fullWeightG <= spec.emptyWeightG
	) {
		return 'full_not_heavier'
	}
	return null
}

/** Counting by weight needs both weights. */
export function canCountByWeight(spec: BottleSpec): boolean {
	return (
		spec.fullWeightG !== null &&
		spec.emptyWeightG !== null &&
		spec.fullWeightG > spec.emptyWeightG
	)
}

/** The tenths a slider offers for the open bottle: 0.0 (empty) to 1.0 (full). */
export const BOTTLE_TENTHS_MAX = 10

/**
 * Millilitres in `whole` full bottles plus an open bottle at `openTenths` tenths
 * (0 to 10). 3 full and one at 0.4 of a 700 ml bottle is 3.4 bottles = 2380 ml.
 */
export function bottlesToMl(
	spec: Pick<BottleSpec, 'sizeMl'>,
	whole: number,
	openTenths: number,
): number {
	if (!Number.isInteger(whole) || whole < 0 || whole > MAX_WHOLE_BOTTLES) {
		throw new RangeError('Whole bottles must be a whole number')
	}
	if (
		!Number.isInteger(openTenths) ||
		openTenths < 0 ||
		openTenths > BOTTLE_TENTHS_MAX
	) {
		throw new RangeError('The open bottle is counted in tenths, 0 to 10')
	}
	return whole * spec.sizeMl + Math.round((spec.sizeMl * openTenths) / 10)
}

/**
 * Millilitres left in an open bottle that weighs `weightG` on the scale, from
 * the stored full and empty weights: the liquid is `weight - empty` out of
 * `full - empty`. A weight below the empty bottle reads as empty and above the
 * full one as full (a scale rarely agrees to the gram); `null` when the item
 * has no weights.
 */
export function openBottleMlFromWeight(
	spec: BottleSpec,
	weightG: number,
): number | null {
	if (!canCountByWeight(spec)) return null
	if (!Number.isFinite(weightG) || weightG < 0) {
		throw new RangeError('Weight must be zero or more')
	}
	const liquid = spec.fullWeightG! - spec.emptyWeightG!
	const share = Math.min(
		1,
		Math.max(0, (weightG - spec.emptyWeightG!) / liquid),
	)
	return Math.round(share * spec.sizeMl)
}

/** Whole bottles plus the open bottle's weight: the total in millilitres. */
export function bottlesAndWeightToMl(
	spec: BottleSpec,
	whole: number,
	openWeightG: number,
): number | null {
	const open = openBottleMlFromWeight(spec, openWeightG)
	if (open === null) return null
	return bottlesToMl(spec, whole, 0) + open
}

/**
 * Splits a stored amount (ml) back into whole bottles and tenths of the open
 * bottle, to show a figure someone typed earlier. The open part is rounded to
 * the nearest tenth (10 tenths carries into a whole bottle).
 */
export function mlToBottleParts(
	spec: Pick<BottleSpec, 'sizeMl'>,
	ml: number,
): { whole: number; openTenths: number } {
	const safe = Math.max(0, ml)
	let whole = Math.floor(safe / spec.sizeMl)
	let tenths = Math.round(((safe - whole * spec.sizeMl) * 10) / spec.sizeMl)
	if (tenths >= BOTTLE_TENTHS_MAX) {
		whole += 1
		tenths = 0
	}
	return { whole, openTenths: tenths }
}

/** The bottle fields an item reads and writes (`null` unless counted by bottle). */
export const itemBottleSchema = z.object({
	sizeMl: bottleSizeMlSchema,
	fullWeightG: bottleWeightGSchema.nullable(),
	emptyWeightG: bottleWeightGSchema.nullable(),
})
export type ItemBottle = z.infer<typeof itemBottleSchema>
