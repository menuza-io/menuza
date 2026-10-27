import { describe, expect, it } from 'vitest'
import { expandTableLabels, planTableLabels } from './qr-model.ts'

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

describe('planTableLabels', () => {
	it('says why an input would not do what it looks like', () => {
		expect(planTableLabels('T1-T3')).toEqual({
			labels: ['T1', 'T2', 'T3'],
			singleRange: true,
			problem: null,
		})
		expect(planTableLabels('Patio 1, Bar').singleRange).toBe(false)
		expect(planTableLabels('T20-T5').problem).toBe('reversed_range')
		expect(planTableLabels('T1-T500').problem).toBe('range_too_large')
		expect(planTableLabels('A1-A150, B1-B150').problem).toBe('too_many')
		expect(planTableLabels('A1-A150, B1-B150').labels).toEqual([])
	})
})
