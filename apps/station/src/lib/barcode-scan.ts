import { normalizeBarcode } from '@repo/common/pos-barcode'
import { type MenuItem, type MenuOption } from './types.ts'

export type ScannedHit =
	| { kind: 'item'; item: MenuItem }
	| { kind: 'option'; item: MenuItem; option: MenuOption }

/**
 * Finds a dish or option in the catalog the till already has. No network.
 */
export function findBarcode(
	items: readonly MenuItem[],
	raw: string,
): ScannedHit | null {
	const code = normalizeBarcode(raw)
	if (!code) return null
	for (const item of items) {
		if (item.barcode && normalizeBarcode(item.barcode) === code) {
			return { kind: 'item', item }
		}
		for (const group of item.modifierGroups ?? []) {
			for (const option of group.options) {
				if (option.barcode && normalizeBarcode(option.barcode) === code) {
					return { kind: 'option', item, option }
				}
			}
		}
	}
	return null
}

/**
 * A keyboard-wedge scanner types the code and ends with Enter. Returns the
 * code when the burst looks like a scan, otherwise null (a person typing).
 */
export function wedgeBarcode(
	chars: readonly string[],
	elapsedMs: number,
): string | null {
	if (elapsedMs > 80) return null
	const text = chars.join('')
	return normalizeBarcode(text)
}
