import { describe, expect, it } from 'vitest'
import {
	generateMarketingCode,
	MARKETING_CODE_ALPHABET,
	parseMarketingOffer,
	usesCouponCodeTag,
} from './marketing-offer.ts'

describe('marketing offers', () => {
	it('mints prefixed codes from the unambiguous alphabet', () => {
		let seed = 0
		const bytes = (length: number) =>
			Uint8Array.from({ length }, () => (seed = (seed * 31 + 7) % 256))
		for (let i = 0; i < 200; i++) {
			const { code, normalizedCode } = generateMarketingCode('hi-5', bytes)
			expect(code).toMatch(/^HI5-[A-Z2-9]{8}$/)
			for (const char of code.slice(4)) {
				expect(MARKETING_CODE_ALPHABET).toContain(char)
			}
			expect(normalizedCode).toBe(code.replace('-', ''))
		}
		expect(generateMarketingCode('', bytes).code).toMatch(/^[A-Z2-9]{8}$/)
	})

	it('skips bytes that would bias the alphabet', () => {
		// Every byte at or past the last whole multiple of the alphabet is dropped.
		const high = (length: number) => new Uint8Array(length).fill(255)
		let calls = 0
		const mixed = (length: number) =>
			++calls === 1 ? high(length) : new Uint8Array(length).fill(0)
		expect(generateMarketingCode('', mixed).code).toBe('AAAAAAAA')
		expect(calls).toBe(2)
	})

	it('spots the tag with spaces or a fallback, and nothing else', () => {
		expect(usesCouponCodeTag('Use {{couponCode}}')).toBe(true)
		expect(usesCouponCodeTag(null, '{{ couponCode | SAVE }}')).toBe(true)
		expect(usesCouponCodeTag('{{coupon}}', '{{couponCodes}}', undefined)).toBe(
			false,
		)
	})

	it('parses stored offers and ignores broken ones', () => {
		expect(
			parseMarketingOffer('{"mode":"unique","discountId":"d1","prefix":"ab"}'),
		).toEqual({ mode: 'unique', discountId: 'd1', prefix: 'AB', validDays: 30 })
		expect(parseMarketingOffer('{oops')).toBeNull()
		expect(
			parseMarketingOffer({ mode: 'unique', discountId: 'd1', validDays: 0 }),
		).toBeNull()
		expect(
			parseMarketingOffer({ mode: 'shared', discountId: 'd1', code: 'a' }),
		).toBeNull()
		expect(parseMarketingOffer('')).toBeNull()
	})
})
