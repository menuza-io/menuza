import {
	displayUnitFor,
	type InventoryBaseUnit,
	inventoryValueMinor,
	parseUnitRef,
	QUANTITY_SCALE,
	roundForDisplay,
	STANDARD_UNIT_SPECS,
	standardUnitsFor,
	thousandthsPerUnit,
	type UnitRef,
	type UnitSystem,
} from '@repo/inventory'
import { currencyExponent } from '#app/utils/money-input.ts'

/**
 * How stock reads on screen. Stored quantities are integer thousandths of the
 * item's base unit (g, ml or piece); people see them in the unit they count
 * in ("6 kg", "3 Box") or, without one, in the unit that reads best.
 */

export type ItemUnitLike = {
	id: string
	name: string
	baseQuantity: number
	archived?: boolean
}

/** Names for the units `Intl` has no unit for (pieces, quarts). Translated by the caller. */
export type UnitLabels = {
	/** "2 pieces" */
	piece: (amount: number) => string
	/** "pieces" */
	pieceName: string
	/** "2 qt" */
	quart: (amount: number) => string
	/** "qt" */
	quartName: string
}

export type FormatQuantityOptions = {
	baseUnit: InventoryBaseUnit
	/** The unit the item is counted in here; absent means the best-fitting unit. */
	countUnit?: UnitRef | null
	units?: readonly ItemUnitLike[]
	system: UnitSystem
	locale: string
	labels: UnitLabels
}

export type QuantityParts = {
	/** The amount in `unitRef`, rounded for display. */
	amount: number
	unitRef: UnitRef
	text: string
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions) {
	try {
		return new Intl.NumberFormat(locale, options)
	} catch {
		return new Intl.NumberFormat('en', options)
	}
}

function formatAmount(amount: number, locale: string): string {
	return numberFormat(locale, {
		maximumFractionDigits: 3,
		useGrouping: true,
	}).format(amount)
}

/** The unit a quantity is shown in, falling back to the best-fitting one. */
function resolveUnitRef(
	quantity: number,
	{ baseUnit, countUnit, units = [], system }: FormatQuantityOptions,
): UnitRef {
	if (countUnit) {
		const parsed = parseUnitRef(countUnit)
		if (parsed.kind === 'named') {
			if (units.some((unit) => unit.id === parsed.id)) return countUnit
		} else if (STANDARD_UNIT_SPECS[parsed.unit].base === baseUnit) {
			return countUnit
		}
	}
	return displayUnitFor(quantity, baseUnit, system)
}

/** Base thousandths in one of a unit, for an item. Null for a unit the item does not have. */
export function thousandthsInUnit(
	unitRef: UnitRef,
	baseUnit: InventoryBaseUnit,
	units: readonly ItemUnitLike[] = [],
): number | null {
	const parsed = parseUnitRef(unitRef)
	if (parsed.kind === 'named') {
		return units.find((unit) => unit.id === parsed.id)?.baseQuantity ?? null
	}
	if (STANDARD_UNIT_SPECS[parsed.unit].base !== baseUnit) return null
	return thousandthsPerUnit({ kind: 'standard', unit: parsed.unit }, baseUnit)
}

/** The short name of a unit: "kg", "L", "Box", "pieces". */
export function formatUnitName(
	unitRef: UnitRef,
	{
		units = [],
		locale,
		labels,
	}: Pick<FormatQuantityOptions, 'units' | 'locale' | 'labels'>,
): string {
	const parsed = parseUnitRef(unitRef)
	if (parsed.kind === 'named') {
		return units.find((unit) => unit.id === parsed.id)?.name ?? parsed.id
	}
	if (parsed.unit === 'piece') return labels.pieceName
	const intl = STANDARD_UNIT_SPECS[parsed.unit].intl
	if (intl === null) return labels.quartName
	const parts = numberFormat(locale, {
		style: 'unit',
		unit: intl,
		unitDisplay: 'short',
	}).formatToParts(1)
	return parts.find((part) => part.type === 'unit')?.value ?? parsed.unit
}

/**
 * Stored thousandths as an amount and text in the item's count unit:
 * `formatQuantity(6_000_000, { baseUnit: 'g', countUnit: 'kg', ... })` reads
 * "6 kg". Callers put the text in `<bdi dir="ltr">`.
 */
export function quantityParts(
	quantity: number,
	options: FormatQuantityOptions,
): QuantityParts {
	const unitRef = resolveUnitRef(quantity, options)
	const perUnit =
		thousandthsInUnit(unitRef, options.baseUnit, options.units) ??
		QUANTITY_SCALE
	const amount = roundForDisplay(quantity / perUnit)
	const parsed = parseUnitRef(unitRef)
	let text: string
	if (parsed.kind === 'named') {
		text = `${formatAmount(amount, options.locale)} ${formatUnitName(unitRef, options)}`
	} else if (parsed.unit === 'piece') {
		text = options.labels.piece(amount)
	} else {
		const spec = STANDARD_UNIT_SPECS[parsed.unit]
		text =
			spec.intl === null
				? options.labels.quart(amount)
				: numberFormat(options.locale, {
						style: 'unit',
						unit: spec.intl,
						unitDisplay: 'short',
						maximumFractionDigits: 3,
					}).format(amount)
	}
	return { amount, unitRef, text }
}

export function formatQuantity(
	quantity: number,
	options: FormatQuantityOptions,
): string {
	return quantityParts(quantity, options).text
}

/** The units a person may enter an amount in: standard units for the base, then the item's own. */
export function unitChoices(
	baseUnit: InventoryBaseUnit,
	units: readonly ItemUnitLike[],
	system: UnitSystem,
): UnitRef[] {
	const standard: UnitRef[] = standardUnitsFor(baseUnit, system)
	const named: UnitRef[] = units
		.filter((unit) => !unit.archived)
		.map((unit) => `unit:${unit.id}`)
	return [...standard, ...named]
}

/** The unit an amount is first offered in: the count unit, else the best standard one. */
export function defaultEntryUnit(
	baseUnit: InventoryBaseUnit,
	countUnit: UnitRef | null | undefined,
	units: readonly ItemUnitLike[],
	system: UnitSystem,
): UnitRef {
	if (countUnit && thousandthsInUnit(countUnit, baseUnit, units) !== null) {
		return countUnit
	}
	if (baseUnit === 'piece') return 'piece'
	if (system === 'us') return baseUnit === 'g' ? 'lb' : 'fl_oz'
	return baseUnit === 'g' ? 'kg' : 'l'
}

/** Money in minor units, in the currency's own decimals ("SAR 168.00"). */
export function formatMoney(
	minor: number,
	currency: string | undefined,
	locale: string,
): string {
	const code = currency ?? 'USD'
	const major = minor / 10 ** currencyExponent(code)
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: code,
		}).format(major)
	} catch {
		return `${major.toFixed(2)} ${code}`
	}
}

/** Cost of one count unit from the cost per base unit ("SAR 28.00" per box). */
export function formatCostPerUnit(
	costMicro: number,
	perUnitThousandths: number,
	currency: string | undefined,
	locale: string,
): string {
	const code = currency ?? 'USD'
	const exponent = currencyExponent(code)
	// micro-minor per base unit x thousandths in one unit / 1e9 = minor per unit.
	const minorPerUnit = (costMicro * perUnitThousandths) / 1_000_000_000
	const major = minorPerUnit / 10 ** exponent
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: code,
			minimumFractionDigits: exponent,
			maximumFractionDigits: Math.max(
				exponent,
				major < 1 ? exponent + 2 : exponent,
			),
		}).format(major)
	} catch {
		return `${major.toFixed(exponent)} ${code}`
	}
}

/** What a quantity is worth at a known cost, or null when the cost is unknown. */
export function estimateValueMinor(
	quantity: number,
	costMicro: number | null | undefined,
): number | null {
	if (costMicro === null || costMicro === undefined) return null
	return inventoryValueMinor(quantity, costMicro)
}

/** How full a shelf is against "fill up to": 0 to 1, or null without a level. */
export function fillRatio(
	onHand: number,
	fillUpTo: number | null | undefined,
): number | null {
	if (fillUpTo === null || fillUpTo === undefined || fillUpTo <= 0) return null
	return Math.min(1, Math.max(0, onHand / fillUpTo))
}

/** How much − and + change an amount typed in this unit. */
export function entryStep(unit: UnitRef | null | undefined): number {
	if (!unit) return 1
	if (unit === 'g' || unit === 'ml') return 50
	if (unit === 'kg' || unit === 'l' || unit === 'lb' || unit === 'gal') {
		return 0.5
	}
	return 1
}
