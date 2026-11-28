import { TEST_ORDER_CODE_PREFIX } from '@repo/common/test-orders'
import { describe, expect, it } from 'vitest'
import {
	adoptPendingTestCode,
	adoptTestCode,
	PENDING_TEST_KEY,
	clearTestCode,
	readTestCode,
	testCodeFromHash,
	testCodeKey,
	withoutTestFragment,
} from './test-order'

const NOW = Date.UTC(2026, 10, 27, 12)
const nonce = 'A'.repeat(24)
const mac = 'a'.repeat(64)
const code = (exp = NOW + 30 * 60_000, location = 'loc_1') =>
	`${TEST_ORDER_CODE_PREFIX}.${location}.${nonce}.${exp}.${mac}`

function memory() {
	const data = new Map<string, string>()
	return {
		data,
		setItem: (key: string, value: string) => void data.set(key, value),
		getItem: (key: string) => data.get(key) ?? null,
		removeItem: (key: string) => void data.delete(key),
	}
}

describe('the test order code in the URL fragment (#119)', () => {
	it('reads it from the fragment, alone or beside other parameters, and rejects junk', () => {
		expect(testCodeFromHash(`#test=${code()}`)).toBe(code())
		expect(testCodeFromHash(`#a=1&test=${code()}`)).toBe(code())
		expect(testCodeFromHash('#test=junk')).toBeNull()
		expect(testCodeFromHash('')).toBeNull()
		expect(testCodeFromHash('#link=abc')).toBeNull()
	})

	it('keeps an unexpired code in the tab and forgets it once spent or expired', () => {
		const storage = memory()
		const stored = adoptTestCode(storage, 'org', `#test=${code()}`, NOW)
		expect(stored).toMatchObject({ code: code(), locationId: 'loc_1' })
		expect(readTestCode(storage, 'org', NOW + 60_000)).toEqual(stored)
		// 30 minutes later it is gone, and so is the stored value.
		expect(readTestCode(storage, 'org', NOW + 31 * 60_000)).toBeNull()
		expect(storage.data.has(testCodeKey('org'))).toBe(false)
		adoptTestCode(storage, 'org', `#test=${code()}`, NOW)
		clearTestCode(storage, 'org')
		expect(readTestCode(storage, 'org', NOW)).toBeNull()
	})

	it('adopts nothing from an expired code or a fragment without one', () => {
		const storage = memory()
		expect(
			adoptTestCode(storage, 'org', `#test=${code(NOW - 1)}`, NOW),
		).toBeNull()
		expect(adoptTestCode(storage, 'org', '#nothing', NOW)).toBeNull()
		expect(storage.data.size).toBe(0)
	})

	it('is per organization, and drops a damaged stored value', () => {
		const storage = memory()
		adoptTestCode(storage, 'org', `#test=${code()}`, NOW)
		expect(readTestCode(storage, 'other', NOW)).toBeNull()
		storage.setItem(testCodeKey('org'), '{not json')
		expect(readTestCode(storage, 'org', NOW)).toBeNull()
		expect(storage.data.has(testCodeKey('org'))).toBe(false)
	})

	it('takes a code the layout parked in storage before analytics loaded, once', () => {
		const storage = memory()
		storage.setItem(PENDING_TEST_KEY, code())
		expect(adoptPendingTestCode(storage, 'org', NOW)).toMatchObject({
			code: code(),
			locationId: 'loc_1',
		})
		expect(storage.data.has(PENDING_TEST_KEY)).toBe(false)
		expect(readTestCode(storage, 'org', NOW)).not.toBeNull()
		// Nothing parked, or junk parked: nothing adopted, and the junk is dropped.
		expect(adoptPendingTestCode(storage, 'org', NOW)).toBeNull()
		storage.setItem(PENDING_TEST_KEY, 'junk')
		expect(adoptPendingTestCode(storage, 'other', NOW)).toBeNull()
		expect(storage.data.has(PENDING_TEST_KEY)).toBe(false)
	})

	it('keeps the code out of the address bar, other fragment parameters kept', () => {
		expect(
			withoutTestFragment(`https://cafe.test/menu?location=l#test=${code()}`),
		).toBe('https://cafe.test/menu?location=l')
		expect(
			withoutTestFragment(`https://cafe.test/menu#a=1&test=${code()}`),
		).toBe('https://cafe.test/menu#a=1')
	})
})
