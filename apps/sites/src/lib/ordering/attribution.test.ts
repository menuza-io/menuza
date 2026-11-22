import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	ATTRIBUTION_STORAGE_KEY,
	captureAttribution,
	currentAttribution,
	touchFromSearch,
} from './attribution.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-03-10T12:00:00.000Z').getTime()

function memoryStorage() {
	const data = new Map<string, string>()
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	}
}

describe('attribution kept in the browser (#115)', () => {
	let local: ReturnType<typeof memoryStorage>
	let session: ReturnType<typeof memoryStorage>
	beforeEach(() => {
		local = memoryStorage()
		session = memoryStorage()
		vi.stubGlobal('localStorage', local)
		vi.stubGlobal('sessionStorage', session)
	})
	afterEach(() => vi.unstubAllGlobals())

	it('reads the UTM values and the Menuza link values of a landing URL', () => {
		expect(
			touchFromSearch(
				'?utm_source=menuza&utm_medium=email&utm_campaign=spring&mzc=camp-1&mzs=step-2&mzl=abc1234&other=1',
				NOW,
			),
		).toEqual({
			utmSource: 'menuza',
			utmMedium: 'email',
			utmCampaign: 'spring',
			campaignId: 'camp-1',
			stepId: 'step-2',
			shortLinkId: 'abc1234',
			touchedAt: NOW,
		})
	})

	it('a direct visit is not a touch and leaves the kept one alone', () => {
		expect(touchFromSearch('', NOW)).toBeNull()
		expect(touchFromSearch('?item=burger', NOW)).toBeNull()
		captureAttribution('?utm_source=newsletter', NOW)
		captureAttribution('', NOW + 1000)
		expect(currentAttribution(NOW + 2000)?.utmSource).toBe('newsletter')
	})

	it('the last non-direct touch wins', () => {
		captureAttribution('?utm_source=newsletter', NOW - 3 * DAY)
		captureAttribution('?utm_source=menuza&utm_medium=sms&mzc=c9', NOW - DAY)
		expect(currentAttribution(NOW)).toMatchObject({
			utmSource: 'menuza',
			utmMedium: 'sms',
			campaignId: 'c9',
			touchedAt: NOW - DAY,
		})
	})

	it('a UTM visit two days earlier is still credited, one 8 days earlier is not', () => {
		captureAttribution('?utm_source=newsletter', NOW - 2 * DAY)
		expect(currentAttribution(NOW)).toMatchObject({ utmSource: 'newsletter' })
		local.setItem(
			ATTRIBUTION_STORAGE_KEY,
			JSON.stringify({ utmSource: 'old', touchedAt: NOW - 8 * DAY }),
		)
		session.removeItem(ATTRIBUTION_STORAGE_KEY)
		expect(currentAttribution(NOW)).toBeNull()
		// The stale value is dropped, not kept for later.
		expect(local.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull()
	})

	it('cuts values to 100 characters and drops control characters', () => {
		const touch = touchFromSearch(
			`?utm_source=${encodeURIComponent('news\u0007letter')}&utm_campaign=${'a'.repeat(300)}`,
			NOW,
		)
		expect(touch?.utmSource).toBe('newsletter')
		expect(touch?.utmCampaign).toHaveLength(100)
	})

	it('keeps working with only session storage, and with none', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('blocked')
			},
			setItem: () => {
				throw new Error('blocked')
			},
			removeItem: () => {
				throw new Error('blocked')
			},
		})
		captureAttribution('?utm_source=newsletter', NOW)
		expect(currentAttribution(NOW)?.utmSource).toBe('newsletter')
		vi.stubGlobal('sessionStorage', undefined)
		expect(() => captureAttribution('?utm_source=x', NOW)).not.toThrow()
		expect(currentAttribution(NOW)).toBeNull()
	})

	it('stores no visitor id, address or cookie', () => {
		captureAttribution('?utm_source=newsletter', NOW)
		const stored = JSON.parse(local.getItem(ATTRIBUTION_STORAGE_KEY)!)
		expect(Object.keys(stored).sort()).toEqual(['touchedAt', 'utmSource'])
	})
})
