import { describe, expect, it } from 'vitest'
import { estimateTax } from './tax.ts'

describe('estimateTax', () => {
	it('adds exclusive tax on top', () => {
		expect(estimateTax(20, 8.25, false)).toEqual({ tax: 1.65, added: 1.65 })
	})

	it('reports the tax contained in inclusive prices without adding it', () => {
		const result = estimateTax(115, 15, true)
		expect(result.tax).toBeCloseTo(15)
		expect(result.added).toBe(0)
	})

	it('is zero for an empty cart or a zero rate', () => {
		expect(estimateTax(0, 15, true)).toEqual({ tax: 0, added: 0 })
		expect(estimateTax(10, 0, false)).toEqual({ tax: 0, added: 0 })
	})
})
