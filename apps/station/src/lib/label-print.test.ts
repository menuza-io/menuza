import { type LabelData } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import { labelHtml } from './label-print.ts'

const words = {
	made: 'Made',
	opened: 'Opened',
	useBy: 'Use by',
	madeBy: 'Made by',
	quantity: 'Quantity',
}
const label: LabelData = {
	itemId: 'i1',
	nameEn: 'Hummus <b>',
	nameAr: 'حمص',
	kind: 'made',
	madeAt: 1,
	useByAt: 2,
	madeAtLabel: '2026-11-27 10:00',
	useByLabel: '2026-11-30 10:00',
	madeBy: null,
	quantityLabel: '2 L',
	storageNote: null,
	timeZone: 'UTC',
	copies: 2,
}

describe('labelHtml', () => {
	it('prints the made and use-by times, the Arabic name and one page per copy', () => {
		const html = labelHtml(label, words)
		expect(html).toContain('Made')
		expect(html).toContain('Use by')
		expect(html).toContain('2026-11-30 10:00')
		expect(html).toContain('حمص')
		expect(html).toContain('dir="rtl"')
		expect(html.match(/class="page"/g)).toHaveLength(2)
	})
	it('escapes the item name', () => {
		expect(labelHtml(label, words)).not.toContain('<b>')
	})
	it('says Opened for an opened item and omits a missing use-by', () => {
		const html = labelHtml(
			{ ...label, kind: 'opened', useByLabel: null, nameAr: null },
			words,
		)
		expect(html).toContain('Opened')
		expect(html).not.toContain('Use by')
	})
})
