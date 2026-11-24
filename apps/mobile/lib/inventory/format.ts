import { type UnitRef } from '@repo/inventory'

/**
 * Small, pure helpers for showing stock on a phone. Quantities are stored as
 * thousandths of the item's base unit (gram, millilitre or piece); the phone
 * shows them in the unit that reads best. Names of units come from the screen
 * (Lingui), so this file only decides numbers and unit keys.
 */

export type BaseUnit = 'g' | 'ml' | 'piece'

export function baseToDisplay(
	quantity: number,
	baseUnit: BaseUnit,
): { amount: number; unit: 'g' | 'kg' | 'ml' | 'l' | 'piece' } {
	const units = quantity / 1000
	if (baseUnit === 'piece') return { amount: units, unit: 'piece' }
	if (baseUnit === 'g') {
		return Math.abs(units) >= 1000
			? { amount: units / 1000, unit: 'kg' }
			: { amount: units, unit: 'g' }
	}
	return Math.abs(units) >= 1000
		? { amount: units / 1000, unit: 'l' }
		: { amount: units, unit: 'ml' }
}

/** "4.5" or "12": up to two decimals, no trailing zeros. */
export function trimNumber(value: number, locale: string): string {
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
		value,
	)
}

/** Whether a unit is one of the built-in ones (anything else is the item's own named unit, `unit:<id>`). */
export function isNamedUnit(unit: UnitRef): boolean {
	return unit.startsWith('unit:')
}

/** The unit a person counts in, kept as the region's key for the entry. */
export const STEP_FOR: Readonly<Record<string, number>> = {
	g: 50,
	kg: 0.5,
	ml: 50,
	l: 0.5,
	piece: 1,
}

/** A typed amount as a number: blank is "not counted", a comma is a decimal point. */
export function parseTypedAmount(text: string): number | null {
	const trimmed = text.trim().replace(',', '.')
	if (trimmed === '') return null
	const value = Number(trimmed)
	return Number.isFinite(value) && value >= 0 ? value : null
}
