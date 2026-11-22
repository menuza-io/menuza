import { z } from 'zod'

/**
 * Short links on an organization's own site (#159): `<site>/l/<code>` answers a
 * 302 to a path of the same site with UTM values and opaque ids, and counts the
 * click per day. Pure rules shared by tenant-api (create, resolve), Sites (the
 * redirect), the App (Links screen, print QR) and the campaign senders.
 *
 * Never an external URL: a target is a path that starts with a single `/`.
 */

/** No look-alikes (0/o, 1/l/i): a code is read aloud and typed from print. */
export const SHORT_LINK_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
export const SHORT_LINK_CODE_LENGTH = 7
const CODE_PATTERN = new RegExp(
	`^[${SHORT_LINK_CODE_ALPHABET}]{${SHORT_LINK_CODE_LENGTH}}$`,
)

export function isShortLinkCode(value: unknown): value is string {
	return typeof value === 'string' && CODE_PATTERN.test(value)
}

/** A path on the organization's own site: never an external URL. */
export const siteTargetPathSchema = z
	.string()
	.trim()
	.max(200)
	.regex(/^\/(?!\/)[A-Za-z0-9\-._~/%?=&]*$/, 'Use a path on your site')

/** The query parameters the platform adds to a link a guest follows. */
export const ATTRIBUTION_PARAMS = {
	/** The Menuza campaign (a broadcast or an automation) that carried the link. */
	campaign: 'mzc',
	/** The automation step (or node) within that campaign. */
	step: 'mzs',
	/** The short link that was followed. */
	shortLink: 'mzl',
} as const

/** Values the platform reads back from a URL are capped and stripped (#115). */
export const ATTRIBUTION_VALUE_MAX = 100

/** C0 and C1 controls, plus the line and paragraph separators, removed. */
function stripControlCharacters(value: string): string {
	let out = ''
	for (const char of value) {
		const code = char.codePointAt(0)!
		if (
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x2028 ||
			code === 0x2029
		) {
			continue
		}
		out += char
	}
	return out
}

/** A reporting value: control characters removed, trimmed, at most 100 characters. */
export function sanitizeAttributionValue(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const cleaned = stripControlCharacters(value)
	const trimmed = cleaned.trim().slice(0, ATTRIBUTION_VALUE_MAX)
	return trimmed.length > 0 ? trimmed : null
}

/** A UTM value built from a name: lower-case words joined by `-`, at most 60 characters. */
export function utmSlug(value: string | null | undefined): string | null {
	if (!value) return null
	const slug = value
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/g, '')
	return slug.length > 0 ? slug : null
}

export type ShortLinkParts = {
	targetPath: string
	utmSource?: string | null
	utmMedium?: string | null
	utmCampaign?: string | null
	utmContent?: string | null
	campaignId?: string | null
	stepId?: string | null
	linkId: string
}

/**
 * Where a click goes: the stored path with the link's UTM values (never over a
 * value the path already has) and the opaque ids. Returns null for a path that
 * is not a path on the own site, so a bad row can never redirect elsewhere.
 */
export function shortLinkLocation(parts: ShortLinkParts): string | null {
	const parsed = siteTargetPathSchema.safeParse(parts.targetPath)
	if (!parsed.success) return null
	const [path = '/', query = ''] = parsed.data.split('?', 2)
	const params = new URLSearchParams(query)
	const add = (key: string, value: string | null | undefined) => {
		const clean = sanitizeAttributionValue(value)
		if (clean && !params.has(key)) params.set(key, clean)
	}
	add('utm_source', parts.utmSource)
	add('utm_medium', parts.utmMedium)
	add('utm_campaign', parts.utmCampaign)
	add('utm_content', parts.utmContent)
	add(ATTRIBUTION_PARAMS.campaign, parts.campaignId)
	add(ATTRIBUTION_PARAMS.step, parts.stepId)
	params.set(ATTRIBUTION_PARAMS.shortLink, parts.linkId)
	const text = params.toString()
	return text ? `${path}?${text}` : path
}

/** The public short URL, optionally carrying the opaque message id of one recipient. */
export function shortLinkUrl(
	siteOrigin: string,
	code: string,
	messageId?: string | null,
): string {
	const base = `${siteOrigin.replace(/\/$/, '')}/l/${code}`
	return messageId ? `${base}?m=${encodeURIComponent(messageId)}` : base
}

/** An opaque message id as it travels in `?m=`: the id of a `marketing_messages` row. */
export function isMessageId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value)
}

/**
 * A URL that points at the own site, as a path with its query, or null for
 * anything else (another origin, another scheme, a protocol-relative URL).
 */
export function ownSitePath(url: string, siteOrigin: string): string | null {
	let parsed: URL
	let site: URL
	try {
		parsed = new URL(url)
		site = new URL(siteOrigin)
	} catch {
		return null
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
	if (parsed.origin !== site.origin) return null
	const path = `${parsed.pathname}${parsed.search}`
	return siteTargetPathSchema.safeParse(path).success ? path : null
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"')]+/g

/** Every URL of a text that points at the own site, with its path. */
export function findOwnSiteLinks(
	text: string,
	siteOrigin: string,
): Array<{ url: string; path: string }> {
	const found: Array<{ url: string; path: string }> = []
	for (const match of text.matchAll(URL_IN_TEXT)) {
		// A sentence's closing punctuation is not part of the URL.
		const url = match[0].replace(/[.,;:!?]+$/, '')
		const path = ownSitePath(url, siteOrigin)
		if (path) found.push({ url, path })
	}
	return found
}

/** Adds query parameters to an own-site URL, never over a value it already has. */
export function withQueryParams(
	url: string,
	params: Record<string, string | null | undefined>,
): string {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return url
	}
	for (const [key, value] of Object.entries(params)) {
		const clean = sanitizeAttributionValue(value)
		if (clean && !parsed.searchParams.has(key))
			parsed.searchParams.set(key, clean)
	}
	return parsed.toString()
}

/** Adds the parameters to every own-site URL in a text (an SMS or a plain-text email). */
export function tagOwnSiteLinksInText(
	text: string,
	siteOrigin: string,
	params: Record<string, string | null | undefined>,
): string {
	return text.replace(URL_IN_TEXT, (raw) => {
		const trailing = /[.,;:!?]+$/.exec(raw)?.[0] ?? ''
		const url = trailing ? raw.slice(0, -trailing.length) : raw
		return ownSitePath(url, siteOrigin)
			? `${withQueryParams(url, params)}${trailing}`
			: raw
	})
}

/** Adds the parameters to every own-site `href` of an HTML email. */
export function tagOwnSiteLinksInHtml(
	html: string,
	siteOrigin: string,
	params: Record<string, string | null | undefined>,
): string {
	return html.replace(
		/(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi,
		(whole, before: string, quote: string, href: string) => {
			// `&amp;` in an attribute is `&` to a browser.
			const decoded = href.replace(/&amp;/g, '&')
			if (!ownSitePath(decoded, siteOrigin)) return whole
			const tagged = withQueryParams(decoded, params).replace(/&/g, '&amp;')
			return `${before}${quote}${tagged}${quote}`
		},
	)
}
