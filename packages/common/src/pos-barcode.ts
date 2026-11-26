/**
 * Menu barcodes (#407). EAN-8, UPC-A, EAN-13 and GTIN-14. Digits only, after
 * spaces and dashes are stripped. Items without a barcode are left alone.
 */

const BARCODE_LENGTHS = new Set([8, 12, 13, 14])

export function normalizeBarcode(raw: unknown): string | null {
	if (typeof raw !== 'string') return null
	const digits = raw.replace(/[\s-]/g, '')
	if (!digits) return null
	if (!/^\d+$/.test(digits)) return null
	if (!BARCODE_LENGTHS.has(digits.length)) return null
	return digits
}

export type BarcodeOwner = {
	kind: 'item' | 'option'
	id: string
	name: string
}

/**
 * The other dish or option that already uses this code, or null when the
 * code is free (or belongs to `self`).
 */
export function otherBarcodeOwner(
	owners: readonly BarcodeOwner[],
	self: { kind: 'item' | 'option'; id: string } | null,
): BarcodeOwner | null {
	return (
		owners.find((owner) => owner.kind !== self?.kind || owner.id !== self.id) ??
		null
	)
}

export function duplicateBarcodeMessage(other: BarcodeOwner): string {
	const what = other.kind === 'option' ? 'option' : 'item'
	return `That barcode is already on the ${what} “${other.name}”.`
}
