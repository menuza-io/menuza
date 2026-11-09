import { z } from 'zod'

/**
 * Quantities. Every item has one base unit (gram, millilitre or piece) and
 * every stored quantity is an integer number of thousandths of that unit:
 * 1.5 kg is 1_500_000, a quarter of a piece is 250. One rule for all three
 * keeps fractions of open packs exact and fits SQLite integers.
 */
export const INVENTORY_BASE_UNITS = ['g', 'ml', 'piece'] as const
export type InventoryBaseUnit = (typeof INVENTORY_BASE_UNITS)[number]
export const inventoryBaseUnitSchema = z.enum(INVENTORY_BASE_UNITS)

/** Thousandths per base unit. */
export const QUANTITY_SCALE = 1000

/**
 * Largest stored quantity: about 9 tonnes / 9 kL / 9 million pieces in one
 * entry, far below `Number.MAX_SAFE_INTEGER` so sums of many entries stay
 * exact.
 */
export const MAX_ENTRY_QUANTITY = 9_000_000_000

/** Built-in units that convert to a base unit without per-item setup. */
export const STANDARD_UNITS = [
	'g',
	'kg',
	'ml',
	'l',
	'oz',
	'lb',
	'fl_oz',
	'qt',
	'gal',
	'piece',
] as const
export type StandardUnit = (typeof STANDARD_UNITS)[number]
export const standardUnitSchema = z.enum(STANDARD_UNITS)

type StandardUnitSpec = {
	base: InventoryBaseUnit
	/** Base units in one of this unit (exact or the international definition). */
	factor: number
	system: 'metric' | 'us' | 'any'
	/**
	 * `Intl.NumberFormat` unit identifier, when the unit is one the
	 * specification sanctions. Others are labelled in the UI with Lingui.
	 */
	intl: string | null
}

export const STANDARD_UNIT_SPECS: Readonly<
	Record<StandardUnit, StandardUnitSpec>
> = {
	g: { base: 'g', factor: 1, system: 'metric', intl: 'gram' },
	kg: { base: 'g', factor: 1000, system: 'metric', intl: 'kilogram' },
	ml: { base: 'ml', factor: 1, system: 'metric', intl: 'milliliter' },
	l: { base: 'ml', factor: 1000, system: 'metric', intl: 'liter' },
	oz: { base: 'g', factor: 28.349523125, system: 'us', intl: 'ounce' },
	lb: { base: 'g', factor: 453.59237, system: 'us', intl: 'pound' },
	fl_oz: {
		base: 'ml',
		factor: 29.5735295625,
		system: 'us',
		intl: 'fluid-ounce',
	},
	qt: { base: 'ml', factor: 946.352946, system: 'us', intl: null },
	gal: { base: 'ml', factor: 3785.411784, system: 'us', intl: 'gallon' },
	piece: { base: 'piece', factor: 1, system: 'any', intl: null },
}

export const UNIT_SYSTEMS = ['metric', 'us'] as const
export type UnitSystem = (typeof UNIT_SYSTEMS)[number]
export const unitSystemSchema = z.enum(UNIT_SYSTEMS)

/** Region default: KSA is metric; US organizations see US units by default. */
export function defaultUnitSystem(region: 'us' | 'ksa'): UnitSystem {
	return region === 'us' ? 'us' : 'metric'
}

/** Standard units an item with `base` can be entered or shown in. */
export function standardUnitsFor(
	base: InventoryBaseUnit,
	system?: UnitSystem,
): StandardUnit[] {
	return STANDARD_UNITS.filter((unit) => {
		const spec = STANDARD_UNIT_SPECS[unit]
		if (spec.base !== base) return false
		if (!system || spec.system === 'any') return true
		// Metric units stay available to US organizations (recipes in grams).
		return spec.system === system || spec.system === 'metric'
	})
}

/**
 * A per-item named unit ("Box" = 10 kg, "Case" = 6 × 1 L): how many base
 * thousandths one of it holds. Once used it never changes size; a new size is
 * a new unit.
 */
export const namedUnitSchema = z
	.object({
		name: z.string().trim().min(1).max(40),
		baseQuantity: z.number().int().positive().max(MAX_ENTRY_QUANTITY),
	})
	.strict()
export type NamedUnit = z.infer<typeof namedUnitSchema>

export type QuantityUnit =
	| { kind: 'standard'; unit: StandardUnit }
	| { kind: 'named'; baseQuantity: number }

export class UnitMismatchError extends Error {
	constructor(unit: string, base: InventoryBaseUnit) {
		super(`Unit ${unit} cannot measure an item counted in ${base}`)
		this.name = 'UnitMismatchError'
	}
}

/** Base thousandths in one of `unit`, for an item measured in `base`. */
export function thousandthsPerUnit(
	unit: QuantityUnit,
	base: InventoryBaseUnit,
): number {
	if (unit.kind === 'named') return unit.baseQuantity
	const spec = STANDARD_UNIT_SPECS[unit.unit]
	if (spec.base !== base) throw new UnitMismatchError(unit.unit, base)
	return spec.factor * QUANTITY_SCALE
}

/**
 * Convert an amount typed in `unit` to stored thousandths of the base unit,
 * rounded to the nearest thousandth.
 */
export function toBaseQuantity(
	amount: number,
	unit: QuantityUnit,
	base: InventoryBaseUnit,
): number {
	if (!Number.isFinite(amount)) throw new RangeError('Amount is not a number')
	return Math.round(amount * thousandthsPerUnit(unit, base))
}

/** Convert stored thousandths back to an amount in `unit`. */
export function fromBaseQuantity(
	quantity: number,
	unit: QuantityUnit,
	base: InventoryBaseUnit,
): number {
	return quantity / thousandthsPerUnit(unit, base)
}

/**
 * The standard unit that reads best for a quantity: kilograms from 1 kg,
 * litres from 1 L, pounds from 1 lb, gallons from 1 gal; pieces as pieces.
 */
export function displayUnitFor(
	quantity: number,
	base: InventoryBaseUnit,
	system: UnitSystem,
): StandardUnit {
	if (base === 'piece') return 'piece'
	const abs = Math.abs(quantity)
	if (system === 'us') {
		if (base === 'g') {
			return abs >= STANDARD_UNIT_SPECS.lb.factor * QUANTITY_SCALE ? 'lb' : 'oz'
		}
		return abs >= STANDARD_UNIT_SPECS.gal.factor * QUANTITY_SCALE
			? 'gal'
			: 'fl_oz'
	}
	if (base === 'g') return abs >= 1000 * QUANTITY_SCALE ? 'kg' : 'g'
	return abs >= 1000 * QUANTITY_SCALE ? 'l' : 'ml'
}

/**
 * Round an amount for display: whole numbers above 100, otherwise up to two
 * decimals (three below 1). The stored value is never rounded.
 */
export function roundForDisplay(amount: number): number {
	const abs = Math.abs(amount)
	const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : 3
	const factor = 10 ** digits
	return Math.round(amount * factor) / factor
}
