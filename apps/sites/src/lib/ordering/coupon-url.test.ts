import { describe, expect, it } from 'vitest'
import { adoptCouponFromUrl, loadStoredCode } from './discount-quote'

function memoryStorage() {
	const map = new Map<string, string>()
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
	}
}

describe('adoptCouponFromUrl', () => {
	it('keeps a printed code like a typed one', () => {
		const storage = memoryStorage()
		expect(
			adoptCouponFromUrl(storage, 'org1', '?coupon=SAVE-10&utm_source=print'),
		).toBe('SAVE-10')
		expect(loadStoredCode(storage, 'org1')).toBe('SAVE-10')
	})

	it('ignores a missing, implausible or oversized code', () => {
		const storage = memoryStorage()
		for (const search of [
			'',
			'?coupon=',
			'?coupon=<script>',
			'?coupon=ab',
			`?coupon=${'A'.repeat(61)}`,
		]) {
			expect(adoptCouponFromUrl(storage, 'org1', search)).toBeNull()
		}
		expect(loadStoredCode(storage, 'org1')).toBeNull()
	})

	it('leaves an earlier code alone when the new one is invalid', () => {
		const storage = memoryStorage()
		adoptCouponFromUrl(storage, 'org1', '?coupon=FIRST')
		adoptCouponFromUrl(storage, 'org1', '?coupon=%%')
		expect(loadStoredCode(storage, 'org1')).toBe('FIRST')
	})
})
