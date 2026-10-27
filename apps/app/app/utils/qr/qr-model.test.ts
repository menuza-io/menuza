import { describe, expect, it } from 'vitest'
import { expandTableLabels } from './qr-model.ts'

describe('expandTableLabels', () => {
	it('expands ranges and keeps plain labels', () => {
		expect(expandTableLabels('T1-T3')).toEqual(['T1', 'T2', 'T3'])
		expect(expandTableLabels('1-3, Patio, Bar 2')).toEqual([
			'1',
			'2',
			'3',
			'Patio',
			'Bar 2',
		])
		expect(expandTableLabels('T5-T2')).toEqual(['T5-T2'])
		expect(expandTableLabels('A1-A500')).toHaveLength(1)
	})
})
