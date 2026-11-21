/**
 * Where a site's Order online, Gift cards and Reservations buttons go (#318):
 * Menuza (the default, our own pages) or another site, per organization and,
 * where the brand has several locations, per location.
 *
 * One resolver for everything that shows such a button or link: the header
 * call to action, hero, section and footer buttons, location and dish pages,
 * structured data (the Order and Reserve actions) and the links pushed to
 * Google. Pure: the App stores and validates the setting and sends it in the
 * public site payload; Sites calls `resolveActionHref` per link.
 *
 * - A link to another site must be https and cannot lead back to one of the
 *   site's own domains (`https_required`, `own_domain`, `invalid_url`).
 * - With "Another site", the buttons for that action open the link in a new
 *   tab, and our own pages for it are not linked (removed from navigation and
 *   the sitemap) and not indexed (`noindex`). They stay reachable, so a guest
 *   with an order in progress can finish it.
 * - Outbound clicks are counted (event names below), counts only.
 */

export const ACTION_KINDS = ['order', 'gift_cards', 'reservations'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export type ActionTarget =
	{ mode: 'menuza' } | { mode: 'external'; url: string }

export type ActionTargets = Partial<Record<ActionKind, ActionTarget>>

/** The setting as Sites receives it: the organization's, then each location's. */
export type PublicActionTargets = {
	organization: ActionTargets
	locations: Record<string, ActionTargets>
}

export const EMPTY_ACTION_TARGETS: PublicActionTargets = {
	organization: {},
	locations: {},
}

export const MAX_ACTION_URL_LENGTH = 2000

export type ActionUrlError = 'invalid_url' | 'https_required' | 'own_domain'

/**
 * A host as the address bar sends it: lower case, no scheme, path or port, and
 * punycode for a name written in its own script, so `bücher.de` and
 * `xn--bcher-kva.de` are one name.
 */
function plainHost(value: string) {
	const clean = value
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//u, '')
		.replace(/[/?#].*$/u, '')
		.replace(/:\d+$/u, '')
		.replace(/\.$/u, '')
	if (!clean) return ''
	try {
		return new URL(`https://${clean}`).hostname.replace(/\.$/u, '')
	} catch {
		return clean
	}
}

function hostMatches(host: string, domain: string) {
	const clean = plainHost(domain)
	return clean !== '' && (host === clean || host.endsWith(`.${clean}`))
}

/** Whether a link points at one of the given hosts or a sub-domain of one. */
export function linkIsOwnDomain(url: string, ownHosts: readonly string[]) {
	let host: string
	try {
		host = new URL(url).hostname.toLowerCase().replace(/\.$/u, '')
	} catch {
		return false
	}
	return ownHosts.some((own) => hostMatches(host, own))
}

/**
 * Checks a link to another site: https, no credentials, and not one of the
 * site's own domains or their sub-domains. Returns the normalized address.
 */
export function validateActionUrl(
	input: unknown,
	ownHosts: readonly string[],
): { ok: true; url: string } | { ok: false; error: ActionUrlError } {
	if (typeof input !== 'string') return { ok: false, error: 'invalid_url' }
	const raw = input.trim()
	if (!raw || raw.length > MAX_ACTION_URL_LENGTH) {
		return { ok: false, error: 'invalid_url' }
	}
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return { ok: false, error: 'invalid_url' }
	}
	if (url.protocol !== 'https:') return { ok: false, error: 'https_required' }
	if (url.username || url.password || !url.hostname.includes('.')) {
		return { ok: false, error: 'invalid_url' }
	}
	const host = url.hostname.toLowerCase().replace(/\.$/u, '')
	if (ownHosts.some((own) => hostMatches(host, own))) {
		return { ok: false, error: 'own_domain' }
	}
	return { ok: true, url: url.toString() }
}

/** A stored value, read defensively: anything unreadable means Menuza. */
export function parseActionTargets(raw: unknown): ActionTargets {
	let value: unknown = raw
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw)
		} catch {
			return {}
		}
	}
	if (!value || typeof value !== 'object') return {}
	const out: ActionTargets = {}
	for (const kind of ACTION_KINDS) {
		const entry = (value as Record<string, unknown>)[kind]
		if (!entry || typeof entry !== 'object') continue
		const target = entry as { mode?: unknown; url?: unknown }
		if (target.mode === 'external' && typeof target.url === 'string') {
			// Re-check on every read: a stored address that is not https never
			// reaches a visitor.
			const checked = validateActionUrl(target.url, [])
			if (checked.ok) out[kind] = { mode: 'external', url: checked.url }
		} else if (target.mode === 'menuza') {
			out[kind] = { mode: 'menuza' }
		}
	}
	return out
}

export function serializeActionTargets(targets: ActionTargets): string | null {
	const entries = ACTION_KINDS.flatMap((kind) => {
		const target = targets[kind]
		return target ? ([[kind, target]] as const) : []
	})
	return entries.length ? JSON.stringify(Object.fromEntries(entries)) : null
}

/**
 * The target of one action for a place: the location's own choice wins, else
 * the organization's, else Menuza.
 */
export function targetFor(
	targets: PublicActionTargets,
	kind: ActionKind,
	locationId?: string | null,
): ActionTarget {
	const own = locationId ? targets.locations[locationId]?.[kind] : undefined
	return own ?? targets.organization[kind] ?? { mode: 'menuza' }
}

/** Whether any action of the organization or a location goes to another site. */
export function hasExternalTarget(targets: PublicActionTargets) {
	const external = (set: ActionTargets) =>
		ACTION_KINDS.some((kind) => set[kind]?.mode === 'external')
	return (
		external(targets.organization) ||
		Object.values(targets.locations).some(external)
	)
}

/**
 * Our own pages for each action, as path prefixes without a language. Checkout
 * and the order confirmation are not here: a guest with an order in progress
 * finishes it whatever the setting.
 */
const OWN_PAGES: Record<ActionKind, { exact: string[]; prefixes: string[] }> = {
	order: { exact: ['/menu', '/drops'], prefixes: ['/drop/', '/delivery/'] },
	gift_cards: { exact: ['/gift-cards'], prefixes: ['/gift-cards/'] },
	reservations: {
		exact: ['/reserve', '/experiences'],
		prefixes: ['/reserve/', '/experiences/'],
	},
}

/** `/menu/<dish>` is a dish page, `/menu/checkout` and `/menu/success` are not. */
const ORDER_FLOW_PAGES = new Set(['checkout', 'success'])

const LOCALE_PREFIX = /^\/[a-z]{2}(?:-[a-z]{2})?(?=\/|$)/iu

/** A path without its language prefix, query or fragment. */
export function stripLocale(pathname: string, locales: readonly string[] = []) {
	const match = LOCALE_PREFIX.exec(pathname)
	if (!match) return pathname
	const code = match[0].slice(1).toLowerCase()
	// Only a language the site offers is a prefix; `/ar` alone is the home page.
	const known =
		locales.length === 0 || locales.map((l) => l.toLowerCase()).includes(code)
	if (!known) return pathname
	const rest = pathname.slice(match[0].length)
	return rest === '' ? '/' : rest
}

/** Which action, if any, a path of our site belongs to. */
export function actionForPath(
	pathname: string,
	locales: readonly string[] = [],
): ActionKind | null {
	const path = stripLocale(pathname, locales).replace(/\/+$/u, '') || '/'
	for (const kind of ACTION_KINDS) {
		const pages = OWN_PAGES[kind]
		if (
			pages.exact.includes(path) ||
			pages.prefixes.some((p) => path.startsWith(p))
		) {
			return kind
		}
	}
	if (path.startsWith('/menu/')) {
		const second = path.split('/')[2] ?? ''
		return ORDER_FLOW_PAGES.has(second) ? null : 'order'
	}
	return null
}

export type ActionLink = {
	href: string
	/** `_blank` for another site. */
	target?: '_blank'
	rel?: string
	external: boolean
	kind: ActionKind | null
}

/**
 * The address a button or link should use. A link to one of our own pages for
 * an action that goes to another site becomes that site's link, in a new tab,
 * marked for the outbound count; everything else is returned as it was.
 * `href` may carry a query (`/menu?location=<id>` picks that location's
 * setting) and a language prefix.
 */
export function resolveActionHref(
	href: string,
	targets: PublicActionTargets,
	options: { locales?: readonly string[]; locationId?: string | null } = {},
): ActionLink {
	const plain: ActionLink = { href, external: false, kind: null }
	if (!href.startsWith('/') || href.startsWith('//')) return plain
	let url: URL
	try {
		url = new URL(href, 'https://site.invalid')
	} catch {
		return plain
	}
	const kind = actionForPath(url.pathname, options.locales)
	if (!kind) return plain
	const locationId = options.locationId ?? url.searchParams.get('location')
	const target = targetFor(targets, kind, locationId)
	if (target.mode !== 'external') return { ...plain, kind }
	return {
		href: target.url,
		target: '_blank',
		rel: 'noopener noreferrer',
		external: true,
		kind,
	}
}

/**
 * Whether our own pages for an action are replaced everywhere (the whole
 * organization sends it to another site and no location is the exception):
 * only then are they `noindex`, out of the sitemap and out of the navigation.
 */
export function actionReplacedEverywhere(
	targets: PublicActionTargets,
	kind: ActionKind,
	locationIds: readonly string[] = [],
) {
	if (targets.organization[kind]?.mode !== 'external') return false
	return !locationIds.some(
		(id) => targets.locations[id]?.[kind]?.mode === 'menuza',
	)
}

/** Whether a page of our site should be left out of search and the sitemap. */
export function pageIsReplaced(
	pathname: string,
	targets: PublicActionTargets,
	options: {
		locales?: readonly string[]
		locationIds?: readonly string[]
	} = {},
) {
	const kind = actionForPath(pathname, options.locales)
	return kind
		? actionReplacedEverywhere(targets, kind, options.locationIds)
		: false
}

/** The outbound counts of the funnel (#179): a click, never a visitor. */
export const OUTBOUND_EVENT_NAMES = [
	'outbound_order',
	'outbound_gift_cards',
	'outbound_reservations',
] as const
export type OutboundEventName = (typeof OUTBOUND_EVENT_NAMES)[number]

export function outboundEventFor(kind: ActionKind): OutboundEventName {
	return `outbound_${kind}` as OutboundEventName
}

export function kindFromOutboundEvent(event: string): ActionKind | null {
	return ACTION_KINDS.find((kind) => event === `outbound_${kind}`) ?? null
}
