/**
 * Where the guest came from (#115). A visit that lands with `utm_*` values or
 * the `mzc` / `mzs` / `mzl` values a Menuza short link adds (#159) is kept in
 * this browser (`localStorage`, mirrored in `sessionStorage` when that is all
 * the browser lets us use), with the time of the visit. Checkout sends it with
 * the order, and the region credits the order to it for up to 7 days.
 *
 * - Last non-direct touch wins: a later visit with values replaces the kept
 *   one; a visit with none (a direct one) leaves it alone.
 * - No cookie, no visitor id, nothing sent until the order is placed.
 * - Every value is cut to 100 characters and loses control characters, like
 *   the region does (`orderAttributionInputSchema`).
 */
export const ATTRIBUTION_STORAGE_KEY = 'menuza_attribution'
export const ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const MAX_VALUE_LENGTH = 100

export type AttributionTouch = {
	utmSource?: string
	utmMedium?: string
	utmCampaign?: string
	utmContent?: string
	campaignId?: string
	stepId?: string
	shortLinkId?: string
	touchedAt: number
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const PARAMS = [
	['utm_source', 'utmSource'],
	['utm_medium', 'utmMedium'],
	['utm_campaign', 'utmCampaign'],
	['utm_content', 'utmContent'],
	['mzc', 'campaignId'],
	['mzs', 'stepId'],
	['mzl', 'shortLinkId'],
] as const

function clean(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	let text = ''
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0
		if (code < 32 || (code >= 127 && code < 160)) continue
		text += char
	}
	const trimmed = text.trim().slice(0, MAX_VALUE_LENGTH)
	return trimmed || undefined
}

/** The touch a landing URL carries, or null for a direct visit. */
export function touchFromSearch(
	search: string,
	now: number,
): AttributionTouch | null {
	const params = new URLSearchParams(search)
	const touch: AttributionTouch = { touchedAt: now }
	let found = false
	for (const [param, field] of PARAMS) {
		const value = clean(params.get(param))
		if (!value) continue
		touch[field as Exclude<keyof AttributionTouch, 'touchedAt'>] = value
		found = true
	}
	// A step or short link alone says nothing about the source worth keeping,
	// but it is still a touch: the region decides what it means.
	return found ? touch : null
}

function stores(): StorageLike[] {
	const found: StorageLike[] = []
	for (const name of ['localStorage', 'sessionStorage'] as const) {
		try {
			const store = (globalThis as Record<string, unknown>)[name] as
				StorageLike | undefined
			if (store) found.push(store)
		} catch {
			// A browser that blocks storage throws on access.
		}
	}
	return found
}

function parse(raw: string | null, now: number): AttributionTouch | null {
	if (!raw) return null
	try {
		const value = JSON.parse(raw) as Record<string, unknown>
		const touchedAt = value.touchedAt
		if (typeof touchedAt !== 'number' || !Number.isFinite(touchedAt)) {
			return null
		}
		// From the future (a wrong clock) or older than 7 days: not credited.
		if (touchedAt > now + 5 * 60 * 1000) return null
		if (now - touchedAt > ATTRIBUTION_WINDOW_MS) return null
		const touch: AttributionTouch = { touchedAt: Math.floor(touchedAt) }
		for (const [, field] of PARAMS) {
			const text = clean(value[field])
			if (text)
				touch[field as Exclude<keyof AttributionTouch, 'touchedAt'>] = text
		}
		return touch
	} catch {
		return null
	}
}

/** Keeps the touch of the current landing URL, if it has one. */
export function captureAttribution(
	search: string,
	now: number = Date.now(),
): AttributionTouch | null {
	const touch = touchFromSearch(search, now)
	if (!touch) return null
	const raw = JSON.stringify(touch)
	for (const store of stores()) {
		try {
			store.setItem(ATTRIBUTION_STORAGE_KEY, raw)
		} catch {
			// Full or blocked storage: this order simply has no attribution.
		}
	}
	return touch
}

/** The touch to send with an order: the freshest kept one within 7 days. */
export function currentAttribution(
	now: number = Date.now(),
): AttributionTouch | null {
	let best: AttributionTouch | null = null
	for (const store of stores()) {
		try {
			const raw = store.getItem(ATTRIBUTION_STORAGE_KEY)
			const touch = parse(raw, now)
			if (!touch && raw) store.removeItem(ATTRIBUTION_STORAGE_KEY)
			if (touch && (!best || touch.touchedAt > best.touchedAt)) best = touch
		} catch {
			// Unreadable storage counts as nothing kept.
		}
	}
	return best
}

/** Called on every page of the site. */
export function captureAttributionFromPage(): void {
	try {
		captureAttribution(window.location.search)
	} catch {
		// Never break a page for reporting.
	}
}
