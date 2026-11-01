import { describe, expect, it } from 'vitest'
import {
	addressWithoutCoupon,
	adoptCouponFromUrl,
	forgetDroppedCode,
	loadStoredCode,
	rememberDroppedCode,
	sameCouponCode,
	saveStoredCode,
	stripCouponFromAddress,
} from './discount-quote'

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

describe('a code this tab let go of', () => {
	it('does not come back from the link on reload after the guest removed it', () => {
		const storage = memoryStorage()
		const search = '?coupon=SAVE-10'
		expect(adoptCouponFromUrl(storage, 'org1', search)).toBe('SAVE-10')
		// The guest removes it at checkout, then reloads the page they scanned.
		rememberDroppedCode(storage, 'org1', 'SAVE-10')
		saveStoredCode(storage, 'org1', null)
		expect(adoptCouponFromUrl(storage, 'org1', search)).toBeNull()
		expect(loadStoredCode(storage, 'org1')).toBeNull()
	})

	it('stays gone after a refusal, whatever case or dashes the link uses', () => {
		const storage = memoryStorage()
		rememberDroppedCode(storage, 'org1', 'save-10')
		expect(adoptCouponFromUrl(storage, 'org1', '?coupon=SAVE10')).toBeNull()
		expect(adoptCouponFromUrl(storage, 'org1', '?coupon=Save%2010')).toBeNull()
		expect(loadStoredCode(storage, 'org1')).toBeNull()
	})

	it('comes back from a link once the guest types it again', () => {
		const storage = memoryStorage()
		rememberDroppedCode(storage, 'org1', 'SAVE-10')
		forgetDroppedCode(storage, 'org1', 'save10')
		expect(adoptCouponFromUrl(storage, 'org1', '?coupon=SAVE-10')).toBe(
			'SAVE-10',
		)
	})

	it('is remembered per organization', () => {
		const storage = memoryStorage()
		rememberDroppedCode(storage, 'org1', 'SAVE-10')
		expect(adoptCouponFromUrl(storage, 'org2', '?coupon=SAVE-10')).toBe(
			'SAVE-10',
		)
	})

	it('keeps only the most recent codes', () => {
		const storage = memoryStorage()
		for (let index = 0; index < 25; index += 1) {
			rememberDroppedCode(storage, 'org1', `CODE${index}`)
		}
		// The oldest were forgotten; the newest are still held back.
		expect(adoptCouponFromUrl(storage, 'org1', '?coupon=CODE0')).toBe('CODE0')
		expect(adoptCouponFromUrl(storage, 'org1', '?coupon=CODE24')).toBeNull()
	})

	it('ignores a dropped list that is not what this page wrote', () => {
		const storage = memoryStorage()
		storage.setItem('menuza_coupon_dropped_org1', '{"not":"a list"}')
		expect(adoptCouponFromUrl(storage, 'org1', '?coupon=SAVE-10')).toBe(
			'SAVE-10',
		)
	})
})

describe('a link and the code already kept', () => {
	it('keeps the stored code when the link is the same code', () => {
		const storage = memoryStorage()
		saveStoredCode(storage, 'org1', 'save-10')
		expect(adoptCouponFromUrl(storage, 'org1', '?coupon=SAVE10')).toBe(
			'save-10',
		)
		expect(loadStoredCode(storage, 'org1')).toBe('save-10')
	})

	it('takes a different code from a new link', () => {
		const storage = memoryStorage()
		saveStoredCode(storage, 'org1', 'FIRST')
		expect(adoptCouponFromUrl(storage, 'org1', '?coupon=SECOND')).toBe('SECOND')
		expect(loadStoredCode(storage, 'org1')).toBe('SECOND')
	})

	it('compares codes the way the region does', () => {
		expect(sameCouponCode('save-10', 'SAVE 10')).toBe(true)
		expect(sameCouponCode('SAVE10', 'SAVE11')).toBe(false)
	})
})

describe('the coupon link leaves the address bar', () => {
	it('drops only `coupon`, keeping the other parameters and the fragment', () => {
		expect(
			addressWithoutCoupon(
				'https://acme.test/menu?coupon=SAVE-10&utm_source=print#table=abc',
			),
		).toBe('/menu?utm_source=print#table=abc')
		expect(
			addressWithoutCoupon('https://acme.test/menu/checkout?coupon=X1'),
		).toBe('/menu/checkout')
	})

	it('changes nothing without a coupon parameter', () => {
		expect(
			addressWithoutCoupon('https://acme.test/menu?utm_source=print'),
		).toBeNull()
		expect(addressWithoutCoupon('not a url')).toBeNull()
	})

	it('replaces the history entry, keeping its state', () => {
		const calls: unknown[][] = []
		const win = {
			location: { href: 'https://acme.test/menu?coupon=SAVE-10' },
			history: {
				state: { from: 'scan' },
				replaceState: (...args: unknown[]) => void calls.push(args),
			},
		}
		stripCouponFromAddress(win)
		expect(calls).toEqual([[{ from: 'scan' }, '', '/menu']])
	})

	it('does nothing when there is no link, and survives a refusing history', () => {
		const calls: unknown[][] = []
		stripCouponFromAddress({
			location: { href: 'https://acme.test/menu' },
			history: {
				state: null,
				replaceState: (...args: unknown[]) => void calls.push(args),
			},
		})
		expect(calls).toEqual([])
		expect(() =>
			stripCouponFromAddress({
				location: { href: 'https://acme.test/menu?coupon=A1' },
				history: {
					state: null,
					replaceState: () => {
						throw new Error('SecurityError')
					},
				},
			}),
		).not.toThrow()
	})
})
