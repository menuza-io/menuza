import { describe, expect, it } from 'vitest'
import {
	captureReferral,
	clearPendingReferral,
	readPendingReferral,
	referralDeviceId,
	REFERRAL_TTL_MS,
} from './referral-storage'

function memory() {
	const data = new Map<string, string>()
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
		removeItem: (k: string) => void data.delete(k),
	}
}

describe('referral link memory', () => {
	it('stores a valid code and strips it from the query', () => {
		const storage = memory()
		const rest = captureReferral({
			search: '?ref=ref-abcd1234&x=1',
			host: 'a.test',
			storage,
			now: 1000,
		})
		expect(rest).toBe('?x=1')
		expect(readPendingReferral({ host: 'a.test', storage, now: 2000 })).toBe(
			'REF-ABCD1234',
		)
	})

	it('ignores junk codes and forgets old or cleared ones', () => {
		const storage = memory()
		captureReferral({ search: '?ref=nope', host: 'a.test', storage })
		expect(readPendingReferral({ host: 'a.test', storage })).toBeNull()
		captureReferral({
			search: '?ref=REF-ABCD1234',
			host: 'a.test',
			storage,
			now: 0,
		})
		expect(
			readPendingReferral({
				host: 'a.test',
				storage,
				now: REFERRAL_TTL_MS + 1,
			}),
		).toBeNull()
		captureReferral({ search: '?ref=REF-ABCD1234', host: 'a.test', storage })
		clearPendingReferral({ host: 'a.test', storage })
		expect(readPendingReferral({ host: 'a.test', storage })).toBeNull()
	})

	it('returns null when there is no ref and keeps one device id', () => {
		const storage = memory()
		expect(captureReferral({ search: '?a=1', host: 'h', storage })).toBeNull()
		const first = referralDeviceId(storage, () => 'dev-1')
		expect(referralDeviceId(storage, () => 'dev-2')).toBe(first)
	})
})
