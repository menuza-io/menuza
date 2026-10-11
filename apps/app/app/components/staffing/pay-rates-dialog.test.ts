import { describe, expect, it } from 'vitest'
import { parseRate } from './pay-rates-dialog.tsx'

describe('parseRate', () => {
	it('reads hourly amounts as cents', () => {
		expect(parseRate('18')).toBe(1800)
		expect(parseRate('18.5')).toBe(1850)
		expect(parseRate(' 18,05 ')).toBe(1805)
		expect(parseRate('0.29')).toBe(29)
	})

	it('treats blank as no rate and rejects anything else', () => {
		expect(parseRate('')).toBeNull()
		expect(parseRate('  ')).toBeNull()
		expect(parseRate('-1')).toBeUndefined()
		expect(parseRate('18.555')).toBeUndefined()
		expect(parseRate('$18')).toBeUndefined()
		expect(parseRate('99999.99')).toBeUndefined()
	})
})
