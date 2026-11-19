/**
 * Search engine settings for a restaurant website (#138): site verification
 * codes and IndexNow. Pure rules shared by the App (which stores and sends)
 * and Sites (which renders the meta tags and serves the key file).
 */

/** Google tokens are base64-like, up to 100 characters. */
const GOOGLE_VERIFICATION = /^[A-Za-z0-9_-]{10,100}$/
/** Bing (`msvalidate.01`) codes are 32 hex characters. */
const BING_VERIFICATION = /^[A-Fa-f0-9]{32}$/

/**
 * Accept either the bare code or the whole meta tag an operator pasted from
 * the search engine; return the code, or null when it is not one.
 */
export function parseVerificationCode(
	engine: 'google' | 'bing',
	input: string,
): string | null {
	let value = input.trim()
	if (!value) return null
	const content = /content\s*=\s*["']([^"']*)["']/i.exec(value)
	if (content) value = content[1]!.trim()
	const pattern = engine === 'google' ? GOOGLE_VERIFICATION : BING_VERIFICATION
	return pattern.test(value) ? value : null
}

/** IndexNow keys: 8 to 128 characters of letters, digits and dashes. */
const INDEXNOW_KEY = /^[A-Za-z0-9-]{8,128}$/

export function isIndexNowKey(value: unknown): value is string {
	return typeof value === 'string' && INDEXNOW_KEY.test(value)
}

/** A new random key (32 hex characters). */
export function generateIndexNowKey(): string {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** At most one ping per URL per hour. */
export const INDEXNOW_URL_INTERVAL_MS = 60 * 60_000
/** IndexNow takes up to 10,000 URLs per request. */
export const INDEXNOW_MAX_URLS = 10_000

/**
 * The URLs of one publish that may be sent now: unique, on the site's host,
 * and not sent in the last hour (`lastPinged` maps a URL to its last ping).
 */
export function selectIndexNowUrls(
	urls: readonly string[],
	host: string,
	lastPinged: ReadonlyMap<string, number>,
	nowMs: number,
): string[] {
	const out: string[] = []
	for (const url of urls) {
		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			continue
		}
		if (parsed.host !== host || out.includes(parsed.toString())) continue
		const last = lastPinged.get(parsed.toString())
		if (last !== undefined && nowMs - last < INDEXNOW_URL_INTERVAL_MS) continue
		out.push(parsed.toString())
		if (out.length >= INDEXNOW_MAX_URLS) break
	}
	return out
}

/** The JSON body IndexNow takes (https://www.indexnow.org/documentation). */
export function indexNowBody(input: {
	host: string
	key: string
	origin: string
	urls: readonly string[]
}) {
	return {
		host: input.host,
		key: input.key,
		keyLocation: `${input.origin}/${input.key}.txt`,
		urlList: [...input.urls],
	}
}
