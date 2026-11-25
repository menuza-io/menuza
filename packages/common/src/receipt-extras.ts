/**
 * Marketing codes on the guest receipt (#263): the logo, a review code and an
 * app or rewards code. One pure model decides what a receipt shows, so the
 * Station receipt, the App's live preview and a cloud printer's ticket agree.
 * The fiscal QR code on a KSA receipt always comes first and is never touched.
 */

/** Hosts a Google review link may point to. */
const REVIEW_HOSTS = [
	'google.com',
	'g.page',
	'goo.gl',
	'maps.app.goo.gl',
	'g.co',
] as const

export const REVIEW_URL_MAX_LENGTH = 500

/** The cleaned https review link, or null when it is empty or not a Google review page. */
export function cleanGoogleReviewUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const text = value.trim()
	if (!text || text.length > REVIEW_URL_MAX_LENGTH) return null
	let url: URL
	try {
		url = new URL(text)
	} catch {
		return null
	}
	if (url.protocol !== 'https:' || url.username || url.password) return null
	const host = url.hostname.toLowerCase()
	const ok = REVIEW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
	return ok ? url.toString() : null
}
