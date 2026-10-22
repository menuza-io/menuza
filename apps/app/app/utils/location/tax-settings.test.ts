import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { locationTaxInputFields } from './tax-settings.ts'

const schema = z.object(locationTaxInputFields)

describe('locationTaxInputFields', () => {
	it('defaults to tax-exclusive with no VAT number', () => {
		expect(schema.parse({})).toEqual({ taxInclusive: false, vatNumber: null })
	})

	it('reads the form switch value', () => {
		expect(schema.parse({ taxInclusive: 'true' }).taxInclusive).toBe(true)
		expect(schema.parse({ taxInclusive: 'false' }).taxInclusive).toBe(false)
	})

	it('trims the VAT number and clears an empty one', () => {
		expect(schema.parse({ vatNumber: '  310123456700003 ' }).vatNumber).toBe(
			'310123456700003',
		)
		expect(schema.parse({ vatNumber: '   ' }).vatNumber).toBeNull()
		expect(schema.parse({ vatNumber: 'GB123456789' }).vatNumber).toBe(
			'GB123456789',
		)
	})

	it('rejects symbols, spaces and overlong numbers', () => {
		expect(schema.safeParse({ vatNumber: '310-123' }).success).toBe(false)
		expect(schema.safeParse({ vatNumber: '310 123' }).success).toBe(false)
		expect(schema.safeParse({ vatNumber: '1'.repeat(33) }).success).toBe(false)
		expect(schema.safeParse({ vatNumber: '1'.repeat(32) }).success).toBe(true)
	})
})
