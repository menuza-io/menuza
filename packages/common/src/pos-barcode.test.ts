import { describe, expect, it } from 'vitest'

import {
	duplicateBarcodeMessage,
	normalizeBarcode,
	otherBarcodeOwner,
} from './pos-barcode.ts'

describe('menu barcodes (#407)', () => {
	it('accepts EAN, UPC and GTIN and rejects anything else', () => {
		expect(normalizeBarcode(' 5901234-123457 ')).toBe('5901234123457')
		expect(normalizeBarcode('012345678905')).toBe('012345678905')
		expect(normalizeBarcode('12345670')).toBe('12345670')
		expect(normalizeBarcode('12345678901234')).toBe('12345678901234')
		expect(normalizeBarcode('')).toBeNull()
		expect(normalizeBarcode('ABC1234567890')).toBeNull()
		expect(normalizeBarcode('12345')).toBeNull()
	})

	it('names the other item when the barcode is already used', () => {
		const other = otherBarcodeOwner(
			[
				{ kind: 'item', id: 'self', name: 'Cola' },
				{ kind: 'item', id: 'other', name: 'Water' },
			],
			{ kind: 'item', id: 'self' },
		)
		expect(other?.name).toBe('Water')
		expect(duplicateBarcodeMessage(other!)).toBe(
			'That barcode is already on the item “Water”.',
		)
		expect(
			otherBarcodeOwner(
				[{ kind: 'option', id: 'opt', name: 'Large' }],
				{ kind: 'option', id: 'opt' },
			),
		).toBeNull()
	})
})
