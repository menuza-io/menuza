import { parseTestOrderCode } from '@repo/common/test-orders'

/**
 * A free test order (#119) is opened from the App with a one-time code in the
 * URL fragment (`/menu?location=…#test=<code>`). The fragment never reaches a
 * server: this page takes the code into this tab's session storage, removes it
 * from the address bar, and checkout sends it in the `X-Test-Order` header.
 * It lives until it expires (30 minutes) or the order is placed; the region
 * decides whether it is valid, this only keeps the test banner honest.
 */

export type StoredTestCode = { code: string; exp: number; locationId: string }

type Reader = Pick<Storage, 'getItem' | 'removeItem'>
type Writer = Pick<Storage, 'setItem'>

export const testCodeKey = (orgId: string) => `menuza_test_order_${orgId}`

/**
 * Where the layout's inline script leaves a `#test=` code it moved out of the
 * address bar before analytics loads; `adoptPendingTestCode` takes it from there.
 */
export const PENDING_TEST_KEY = 'menuza_pending_test'

/** Takes a code the layout parked in storage, validating it like a fragment one. */
export function adoptPendingTestCode(
	storage: Writer & Reader,
	orgId: string,
	now = Date.now(),
): StoredTestCode | null {
	let pending: string | null = null
	try {
		pending = storage.getItem(PENDING_TEST_KEY)
		storage.removeItem(PENDING_TEST_KEY)
	} catch {
		return null
	}
	if (!pending) return null
	return adoptTestCode(storage, orgId, `#test=${pending}`, now)
}

/** The code in a URL fragment (`#test=…`, alone or with other parameters). */
export function testCodeFromHash(hash: string): string | null {
	const params = new URLSearchParams(hash.replace(/^#/, ''))
	const code = params.get('test')
	return code && parseTestOrderCode(code) ? code : null
}

/** Takes the code from the fragment into storage; null when there is none, or it is spent. */
export function adoptTestCode(
	storage: Writer & Reader,
	orgId: string,
	hash: string,
	now = Date.now(),
): StoredTestCode | null {
	const code = testCodeFromHash(hash)
	const parsed = code ? parseTestOrderCode(code) : null
	if (!code || !parsed || parsed.exp <= now) return null
	const stored: StoredTestCode = {
		code,
		exp: parsed.exp,
		locationId: parsed.locationId,
	}
	try {
		storage.setItem(testCodeKey(orgId), JSON.stringify(stored))
	} catch {
		// Private mode: the test order is simply not available in this tab.
		return null
	}
	return stored
}

/** The stored code while it can still be used; an expired or unreadable one is forgotten. */
export function readTestCode(
	storage: Reader,
	orgId: string,
	now = Date.now(),
): StoredTestCode | null {
	let raw: string | null = null
	try {
		raw = storage.getItem(testCodeKey(orgId))
	} catch {
		return null
	}
	if (!raw) return null
	try {
		const value = JSON.parse(raw) as Partial<StoredTestCode>
		if (
			typeof value.code === 'string' &&
			typeof value.exp === 'number' &&
			typeof value.locationId === 'string' &&
			parseTestOrderCode(value.code) &&
			value.exp > now
		) {
			return { code: value.code, exp: value.exp, locationId: value.locationId }
		}
	} catch {
		// Fall through: forget it.
	}
	clearTestCode(storage, orgId)
	return null
}

export function clearTestCode(storage: Reader, orgId: string): void {
	try {
		storage.removeItem(testCodeKey(orgId))
	} catch {
		// Nothing to forget.
	}
}

/** The address without its `#test=` fragment, other fragment parameters kept. */
export function withoutTestFragment(href: string): string {
	const url = new URL(href)
	const params = new URLSearchParams(url.hash.replace(/^#/, ''))
	params.delete('test')
	const rest = params.toString()
	url.hash = rest
	return url.toString()
}
