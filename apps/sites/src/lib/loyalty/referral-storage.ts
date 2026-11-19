/**
 * Browser-only memory of a referral link (`?ref=REF-XXXXXXXX`). The code goes
 * to localStorage in the visitor's browser and from there straight to the
 * regional tenant-api; Sites SSR never sees it (docs/tenant-data-residency.md).
 */

const PENDING_KEY = 'menuza:ref'
const DEVICE_KEY = 'menuza:ref-device'
/** A link older than this is forgotten. */
export const REFERRAL_TTL_MS = 30 * 24 * 60 * 60 * 1000

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function normalizeReferralInput(value: string | null): string | null {
	const code = value?.trim().toUpperCase() ?? ''
	return /^REF-[A-Z0-9]{4,16}$/.test(code) ? code : null
}

function keyFor(host: string): string {
	return `${PENDING_KEY}:${host}`
}

/**
 * Stores `?ref=` from `search` when valid and returns the query string with it
 * removed (so the address bar and analytics stay clean), or null when absent.
 */
export function captureReferral(options: {
	search: string
	host: string
	storage: StorageLike
	now?: number
}): string | null {
	const params = new URLSearchParams(options.search)
	if (!params.has('ref')) return null
	const code = normalizeReferralInput(params.get('ref'))
	params.delete('ref')
	if (code) {
		try {
			options.storage.setItem(
				keyFor(options.host),
				JSON.stringify({ code, at: options.now ?? Date.now() }),
			)
		} catch {
			// Storage can be blocked; the link then simply does nothing.
		}
	}
	const rest = params.toString()
	return rest ? `?${rest}` : ''
}

export function readPendingReferral(options: {
	host: string
	storage: StorageLike
	now?: number
}): string | null {
	try {
		const raw = options.storage.getItem(keyFor(options.host))
		if (!raw) return null
		const parsed = JSON.parse(raw) as { code?: unknown; at?: unknown }
		const code =
			typeof parsed.code === 'string'
				? normalizeReferralInput(parsed.code)
				: null
		const at = typeof parsed.at === 'number' ? parsed.at : 0
		if (!code || (options.now ?? Date.now()) - at > REFERRAL_TTL_MS) {
			options.storage.removeItem(keyFor(options.host))
			return null
		}
		return code
	} catch {
		return null
	}
}

export function clearPendingReferral(options: {
	host: string
	storage: StorageLike
}): void {
	try {
		options.storage.removeItem(keyFor(options.host))
	} catch {
		// ignore
	}
}

/** A stable random id for this browser, used only to spot abuse (hashed in the region). */
export function referralDeviceId(
	storage: StorageLike,
	newId: () => string = () => crypto.randomUUID(),
): string {
	try {
		const existing = storage.getItem(DEVICE_KEY)
		if (existing) return existing
		const created = newId()
		storage.setItem(DEVICE_KEY, created)
		return created
	} catch {
		return newId()
	}
}

/** Capture from the live page. */
export function captureReferralFromPage(): void {
	if (typeof window === 'undefined') return
	const rest = captureReferral({
		search: window.location.search,
		host: window.location.host,
		storage: window.localStorage,
	})
	if (rest === null) return
	window.history.replaceState(
		window.history.state,
		'',
		window.location.pathname + rest + window.location.hash,
	)
}
