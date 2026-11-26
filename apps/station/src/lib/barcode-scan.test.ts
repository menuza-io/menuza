import { describe, expect, it } from 'vitest'
import { findBarcode, wedgeBarcode } from './barcode-scan.ts'
import { type MenuItem } from './types.ts'

const cola = {
	id: 'cola',
	displayName: 'Cola',
	barcode: '5901234123457',
	modifierGroups: [
		{
			id: 'size',
			options: [{ id: 'large', displayName: 'Large', barcode: '012345678905' }],
		},
	],
} as unknown as MenuItem

describe('barcode scan (#407)', () => {
	it('adds the item for a known barcode from the cached catalog', () => {
		expect(findBarcode([cola], '5901234123457')?.kind).toBe('item')
		const option = findBarcode([cola], '012345678905')
		expect(option?.kind).toBe('option')
	})

	it('works with no connection: the catalog argument is all it reads', () => {
		expect(findBarcode([cola], '000000000000')).toBeNull()
		expect(wedgeBarcode(['5', '9', '0', '1', '2', '3', '4', '1', '2', '3', '4', '5', '7'], 40)).toBe(
			'5901234123457',
		)
		expect(wedgeBarcode(['5', '9', '0'], 500)).toBeNull()
	})
})
