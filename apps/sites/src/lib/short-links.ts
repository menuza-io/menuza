import {
	isMessageId,
	isShortLinkCode,
	siteTargetPathSchema,
} from '@repo/common/short-links'

/**
 * `/l/<code>` on Sites (#159): the server asks the organization's regional
 * tenant-api where a short link goes, and answers a 302. The lookup carries
 * the site's own origin (how tenant-api finds the organization) and the code;
 * it carries nothing about the visitor. Whether to COUNT the click is decided
 * here from the user agent and a per-address limit that lives in this isolate's
 * memory only: neither the address nor the agent is sent on or stored.
 */

const BOT_PATTERN =
	/bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|linkedin|skype|curl|wget|python-requests|httpclient|headless|lighthouse|monitor|uptime/i

export function isLikelyBot(userAgent: string | null | undefined): boolean {
	// No user agent at all is not a browser.
	if (!userAgent) return true
	return BOT_PATTERN.test(userAgent)
}

/** A sliding count per key held in memory; nothing is persisted. */
export function createClickLimiter(options: {
	limit: number
	windowMs: number
	maxKeys?: number
	now?: () => number
}) {
	const now = options.now ?? Date.now
	const maxKeys = options.maxKeys ?? 5000
	const hits = new Map<string, number[]>()
	return {
		/** Whether this visit is within the limit (and records it). */
		allow(key: string | null | undefined): boolean {
			if (!key) return true
			const at = now()
			const recent = (hits.get(key) ?? []).filter(
				(time) => at - time < options.windowMs,
			)
			const allowed = recent.length < options.limit
			if (allowed) recent.push(at)
			hits.delete(key)
			hits.set(key, recent)
			// The oldest keys go first; the map never grows without bound.
			while (hits.size > maxKeys) {
				const oldest = hits.keys().next().value
				if (oldest === undefined) break
				hits.delete(oldest)
			}
			return allowed
		},
	}
}

export type ShortLinkAnswer =
	| { status: 'ok'; location: string }
	| { status: 'disabled' }
	| { status: 'not_found' }
	| { status: 'unavailable' }

/** A redirect target only ever stays on this site: a path with a single leading slash. */
export function safeLocation(value: unknown): string | null {
	if (typeof value !== 'string') return null
	return siteTargetPathSchema.safeParse(value).success ? value : null
}

export async function lookupShortLink(options: {
	tenantApiUrl: string
	/** The site's own origin: tenant-api resolves the organization from it. */
	origin: string
	code: string
	messageId?: string | null
	count: boolean
	slug?: string | null
	host?: string | null
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<ShortLinkAnswer> {
	if (!isShortLinkCode(options.code)) return { status: 'not_found' }
	const query = new URLSearchParams({ code: options.code })
	if (isMessageId(options.messageId)) query.set('m', options.messageId)
	if (!options.count) query.set('count', '0')
	if (options.slug) query.set('slug', options.slug)
	if (options.host) query.set('host', options.host)
	const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
	try {
		const response = await fetchImpl(
			`${options.tenantApiUrl.replace(/\/$/, '')}/short-links/resolve?${query}`,
			{
				headers: { Accept: 'application/json', Origin: options.origin },
				signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
				redirect: 'manual',
			},
		)
		if (response.status === 404) return { status: 'not_found' }
		if (!response.ok) return { status: 'unavailable' }
		const body = (await response.json()) as {
			status?: string
			location?: unknown
		}
		if (body.status === 'disabled') return { status: 'disabled' }
		const location = safeLocation(body.location)
		return body.status === 'ok' && location
			? { status: 'ok', location }
			: { status: 'unavailable' }
	} catch {
		return { status: 'unavailable' }
	}
}

/**
 * Visits counted per address per minute in this isolate. Past it a visit still
 * redirects, it just is not counted. Held in memory only.
 */
export const clickLimiter = createClickLimiter({ limit: 20, windowMs: 60_000 })
