import { z } from 'zod'

/**
 * The one list of link types every sender uses (#195): order and reservation
 * messages, marketing emails and texts, push notifications, printed QR codes,
 * and the operator's notification links. A link is built by `buildLink()` and
 * read back by `resolveLink()`, so it is built the same way everywhere and a
 * phone with the restaurant's app opens the matching screen while any other
 * device opens the website.
 *
 * No I/O, no UI strings. Rules this module keeps:
 *  - A guest link is an https address on the restaurant's own site. The same
 *    address works on the web and, through universal links (iOS) and app links
 *    (Android), opens the app when it is installed. Nothing else is invented.
 *  - A capability token (an order link, a reservation, a cart) rides in the URL
 *    FRAGMENT only. The fragment never reaches a server, an app-association
 *    file, a log or an analytics call; `resolveLink` hands it to the app
 *    screen in memory and `associationPaths()` has no fragments at all.
 *  - A white-label app claims only its own restaurant's host. A link to any
 *    other host (another organization's content, a custom domain it does not
 *    own) resolves to the website, never to the app.
 *  - A link the installed app version does not know (a newer link type, or one
 *    that does not work on this platform) falls back to the website.
 */

export const LINK_PLATFORMS = ['web', 'ios', 'android'] as const
export type LinkPlatform = (typeof LINK_PLATFORMS)[number]

/** The link protocol version the customer app ships with. Bumped when a type is added. */
export const APP_LINK_VERSION = 1

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/
const CAPABILITY = /^[A-Za-z0-9._~-]{8,512}$/
const HEX64 = /^[0-9a-f]{64}$/
/** A typed code may hold spaces or symbols; it is encoded in the query. */
const COUPON = /^[^\u0000-\u001f\u007f]{1,64}$/

/**
 * A merge tag a marketing template fills in when it is sent, such as
 * `{{couponCode}}` or `{{couponCode|WELCOME}}`. Only `buildLinkTemplate` lets
 * one through; `buildLink` never does.
 */
const PLACEHOLDER = /^\{\{[A-Za-z][A-Za-z0-9_]{0,40}(\|[^{}|]{0,40})?\}\}$/

const id = z.string().regex(OPAQUE_ID)
const capability = z.string().regex(CAPABILITY)

type ParamSpec = {
	/** Where the parameter travels. `fragment` is never sent to a server. */
	in: 'query' | 'fragment'
	/** The key in the URL. */
	key: string
	required: boolean
	schema: z.ZodType<string>
}

type GuestLinkDef = {
	audience: 'guest'
	/** The website path (before any language prefix). */
	path: string
	params: Record<string, ParamSpec>
	/** Where the link works. `web` is always on: it is the fallback. */
	platforms: readonly LinkPlatform[]
	/** What opening it needs, for the docs and the association files. */
	needs: 'nothing' | 'capability_token' | 'sign_in_or_token'
	/** The first app link version that knows this type. */
	since: number
	/** The screen in the customer app (expo-router path); null when web only. */
	appRoute: string | null
}

type OperatorLinkDef = {
	audience: 'operator'
	/** Path under `/<orgSlug>` in the operator App. */
	path: string
	params: Record<string, ParamSpec>
	platforms: readonly LinkPlatform[]
	needs: 'nothing'
	since: number
	/** The screen in the operator mobile app; null when web only. */
	appRoute: string | null
}

const q = (
	key: string,
	required: boolean,
	schema: z.ZodType<string> = id,
): ParamSpec => ({
	in: 'query',
	key,
	required,
	schema,
})
const f = (
	key: string,
	required: boolean,
	schema: z.ZodType<string> = capability,
): ParamSpec => ({
	in: 'fragment',
	key,
	required,
	schema,
})

export const GUEST_LINK_TYPES = {
	menu_home: {
		audience: 'guest',
		path: '/menu',
		params: { location: q('location', false), src: q('src', false) },
		platforms: ['web', 'ios', 'android'],
		needs: 'nothing',
		since: 1,
		appRoute: '/menu',
	},
	dish: {
		audience: 'guest',
		path: '/menu',
		params: { item: q('item', true), location: q('location', false) },
		platforms: ['web', 'ios', 'android'],
		needs: 'nothing',
		since: 1,
		appRoute: '/menu',
	},
	coupon: {
		audience: 'guest',
		path: '/menu',
		params: {
			coupon: q('coupon', true, z.string().regex(COUPON)),
			location: q('location', false),
		},
		platforms: ['web', 'ios', 'android'],
		needs: 'nothing',
		since: 1,
		appRoute: '/menu',
	},
	order: {
		audience: 'guest',
		path: '/menu/success',
		params: {
			order: q('order', true),
			link: f('link', false, z.string().regex(HEX64)),
		},
		platforms: ['web', 'ios', 'android'],
		needs: 'sign_in_or_token',
		since: 1,
		appRoute: '/orders/[id]',
	},
	cart: {
		audience: 'guest',
		path: '/menu',
		params: { cart: f('cart', true) },
		// The app has no cart: it is on the website (checkout opens the site).
		platforms: ['web'],
		needs: 'capability_token',
		since: 1,
		appRoute: null,
	},
	table: {
		audience: 'guest',
		path: '/menu',
		params: { location: q('location', true), table: f('table', true) },
		platforms: ['web'],
		needs: 'capability_token',
		since: 1,
		appRoute: null,
	},
	order_ahead: {
		audience: 'guest',
		path: '/menu',
		params: { location: q('location', true), src: q('src', true) },
		platforms: ['web', 'ios', 'android'],
		needs: 'nothing',
		since: 1,
		appRoute: '/menu',
	},
	reserve: {
		audience: 'guest',
		path: '/reserve',
		// A notify-me message opens the slot it offered; a voice call's text opens
		// the table it held (`#h=`).
		params: {
			hold: f('h', false),
			location: q('location', false),
			party: q('party', false, z.string().regex(/^\d{1,2}$/)),
			date: q('date', false, z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
			time: q('time', false, z.string().regex(/^\d{2}:\d{2}$/)),
		},
		platforms: ['web', 'ios', 'android'],
		needs: 'nothing',
		since: 1,
		appRoute: '/reservations',
	},
	reservation: {
		audience: 'guest',
		path: '/reserve/manage',
		params: { reservation: q('r', false), token: f('t', true) },
		platforms: ['web', 'ios', 'android'],
		needs: 'sign_in_or_token',
		since: 1,
		appRoute: '/reservations/[id]',
	},
	waitlist: {
		audience: 'guest',
		path: '/reserve/waitlist',
		params: { token: f('t', true) },
		platforms: ['web', 'ios', 'android'],
		needs: 'capability_token',
		since: 1,
		appRoute: '/reservations/waitlist',
	},
	reservation_pay: {
		audience: 'guest',
		path: '/reserve/pay',
		params: {
			reservation: f('r', false, id),
			fee: f('f', false, id),
			token: f('t', true),
		},
		platforms: ['web'],
		needs: 'capability_token',
		since: 1,
		appRoute: null,
	},
	// Catering (#124, #361): a quote the guest pays and the balance of a deposit
	// order. The token is `{id}.{version}.{mac}` and rides in the fragment only;
	// editing the quote or voiding the balance burns it. Web only: the customer
	// app has no catering screen.
	catering_quote: {
		audience: 'guest',
		path: '/catering/quote',
		params: { quote: f('q', true) },
		platforms: ['web'],
		needs: 'capability_token',
		since: 1,
		appRoute: null,
	},
	catering_balance: {
		audience: 'guest',
		path: '/catering/balance',
		params: { balance: f('b', true) },
		platforms: ['web'],
		needs: 'capability_token',
		since: 1,
		appRoute: null,
	},
	order_pay: {
		audience: 'guest',
		// Pay-what-you-owe link for an order (#163): capability token in fragment.
		path: '/menu/pay',
		params: { pay: f('p', true) },
		platforms: ['web'],
		needs: 'capability_token',
		since: 1,
		appRoute: null,
	},
	get_app: {
		audience: 'guest',
		// The site's own store redirect (#196): it counts the tap per placement and
		// sends the visitor to the live store. Web only: the app never claims it.
		path: '/get-app',
		params: {
			store: q('store', false, z.enum(['app_store', 'play_store'])),
			p: q(
				'p',
				false,
				z.enum(['banner', 'confirmation', 'email', 'footer', 'block', 'print']),
			),
		},
		platforms: ['web'],
		needs: 'nothing',
		since: 1,
		appRoute: null,
	},
	loyalty: {
		audience: 'guest',
		path: '/profile/rewards',
		params: {},
		platforms: ['web', 'ios', 'android'],
		needs: 'sign_in_or_token',
		since: 1,
		appRoute: '/rewards',
	},
	gift_cards: {
		audience: 'guest',
		path: '/profile/gift-cards',
		// A purchased card's code: "Add to my account" (never in the query).
		params: { add: f('add', false) },
		platforms: ['web', 'ios', 'android'],
		needs: 'sign_in_or_token',
		since: 1,
		appRoute: '/gift-cards',
	},
} as const satisfies Record<string, GuestLinkDef>

export const OPERATOR_LINK_TYPES = {
	operator_order: {
		audience: 'operator',
		path: '/orders/[order]',
		params: {
			order: { in: 'query', key: 'order', required: true, schema: id },
		},
		platforms: ['web', 'ios', 'android'],
		needs: 'nothing',
		since: 1,
		appRoute: '/orders/[id]',
	},
	operator_mailbox_thread: {
		audience: 'operator',
		path: '/mailbox',
		params: { thread: q('thread', true) },
		platforms: ['web', 'ios', 'android'],
		needs: 'nothing',
		since: 1,
		appRoute: '/mailbox/[id]',
	},
	operator_form_response: {
		audience: 'operator',
		path: '/mailbox',
		params: {
			source: {
				in: 'query',
				key: 'source',
				required: true,
				schema: z.literal('forms'),
			},
			form: q('form', true),
		},
		platforms: ['web', 'ios', 'android'],
		needs: 'nothing',
		since: 1,
		appRoute: '/mailbox/forms/[form]',
	},
} as const satisfies Record<string, OperatorLinkDef>

export type GuestLinkType = keyof typeof GUEST_LINK_TYPES
export type OperatorLinkType = keyof typeof OPERATOR_LINK_TYPES
export type LinkType = GuestLinkType | OperatorLinkType

export const LINK_TYPES = { ...GUEST_LINK_TYPES, ...OPERATOR_LINK_TYPES }

export class LinkParamError extends Error {
	// No parameter properties: `apps/customer/app.config.ts` imports this file and
	// Node loads it in strip-only TypeScript mode.
	readonly type: string
	readonly param: string
	constructor(type: string, param: string) {
		super(`Invalid link parameter "${param}" for "${type}"`)
		this.type = type
		this.param = param
		this.name = 'LinkParamError'
	}
}

export type LinkParams = Record<string, string | undefined | null>

function checkParams(
	type: string,
	def: GuestLinkDef | OperatorLinkDef,
	input: LinkParams,
	allowPlaceholders = false,
) {
	const out: Array<{ spec: ParamSpec; name: string; value: string }> = []
	for (const [name, spec] of Object.entries(def.params)) {
		const raw = input[name]
		if (raw === undefined || raw === null || raw === '') {
			if (spec.required) throw new LinkParamError(type, name)
			continue
		}
		if (PLACEHOLDER.test(raw)) {
			// A merge tag is only for a template; a real link never carries one.
			if (!allowPlaceholders || spec.in !== 'query') {
				throw new LinkParamError(type, name)
			}
			out.push({ spec, name, value: raw })
			continue
		}
		const parsed = spec.schema.safeParse(raw)
		if (!parsed.success) throw new LinkParamError(type, name)
		out.push({ spec, name, value: parsed.data })
	}
	for (const name of Object.keys(input)) {
		if (
			!(name in def.params) &&
			input[name] !== undefined &&
			input[name] !== null
		) {
			throw new LinkParamError(type, name)
		}
	}
	return out
}

export type GuestLinkContext = {
	/** The restaurant's public site origin, as the control plane resolves it. */
	origin: string | null | undefined
	/** A language prefix such as `/ar`, or empty for the default language. */
	localePrefix?: string
}

function cleanOrigin(origin: string | null | undefined): URL | null {
	if (!origin) return null
	try {
		const url = new URL(origin)
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
		if (url.username || url.password) return null
		return url
	} catch {
		return null
	}
}

function cleanPrefix(prefix: string | undefined): string {
	if (!prefix) return ''
	return /^\/[a-z]{2}(?:-[A-Za-z]{2,4})?$/.test(prefix) ? prefix : ''
}

/**
 * The address for a guest link, or null when the site origin is missing or not
 * http(s) (a sender then sends no link, as before). Throws `LinkParamError`
 * for a parameter that does not belong to the type or does not validate: that
 * is a bug in the sender, never user input.
 */
export function buildLink(
	type: GuestLinkType,
	params: LinkParams,
	context: GuestLinkContext,
): string | null {
	const def: GuestLinkDef = GUEST_LINK_TYPES[type]
	const checked = checkParams(type, def, params)
	const origin = cleanOrigin(context.origin)
	if (!origin) return null
	return assemble(def, checked, origin, context.localePrefix)
}

function assemble(
	def: GuestLinkDef,
	checked: ReturnType<typeof checkParams>,
	origin: URL,
	localePrefix: string | undefined,
): string {
	// A site base that already carries its language (`https://x.com/ar`) is fine.
	const prefix =
		cleanPrefix(localePrefix) || cleanPrefix(origin.pathname.replace(/\/$/, ''))
	const url = new URL(`${prefix}${def.path}`, origin.origin)
	const fragment: string[] = []
	for (const { spec, value } of checked) {
		if (spec.in === 'query') url.searchParams.set(spec.key, value)
		else fragment.push(`${spec.key}=${value}`)
	}
	if (fragment.length > 0) url.hash = fragment.join('&')
	// A merge tag is not URL-safe text; keep its braces readable for the template.
	// `+` is how URLSearchParams writes a space; `%20` is what the sites read and
	// what every printed code has always used.
	url.search = url.search.replace(/\+/g, '%20')
	return url
		.toString()
		.replace(/%7B%7B/gi, '{{')
		.replace(/%7D%7D/gi, '}}')
		.replace(/%7C/gi, '|')
}

/**
 * Like `buildLink`, for a template that is filled in at send time: a query
 * parameter may be a merge tag (`{{couponCode}}`). The result is a template,
 * not a usable address, until the merge tags are replaced.
 */
export function buildLinkTemplate(
	type: GuestLinkType,
	params: LinkParams,
	context: GuestLinkContext,
): string | null {
	const def: GuestLinkDef = GUEST_LINK_TYPES[type]
	const checked = checkParams(type, def, params, true)
	const origin = cleanOrigin(context.origin)
	if (!origin) return null
	return assemble(def, checked, origin, context.localePrefix)
}

/** A concrete link as a path relative to the site origin (`/menu?item=abc`). */
export function buildLinkPath(type: GuestLinkType, params: LinkParams): string {
	const url = buildLink(type, params, { origin: 'https://path.invalid' })!
	return url.replace('https://path.invalid', '')
}

/** A path with merge tags, relative to the site origin (`/menu?coupon={{couponCode}}`). */
export function buildLinkTemplatePath(
	type: GuestLinkType,
	params: LinkParams,
): string {
	const url = buildLinkTemplate(type, params, {
		origin: 'https://template.invalid',
	})!
	return url.replace('https://template.invalid', '')
}

/**
 * An operator notification link: `<base>/<orgSlug><path>` in the operator App
 * (or its mobile app through app links). Same rules: validated parameters, no
 * secrets.
 */
export function buildOperatorLink(
	type: OperatorLinkType,
	params: LinkParams,
	context: { baseUrl: string | null | undefined; orgSlug: string },
): string | null {
	const def: OperatorLinkDef = OPERATOR_LINK_TYPES[type]
	const checked = checkParams(type, def, params)
	const base = cleanOrigin(context.baseUrl)
	if (!base || !OPAQUE_ID.test(context.orgSlug)) return null
	const values = Object.fromEntries(
		checked.map((entry) => [entry.name, entry.value]),
	)
	let path = def.path
	const query = new URLSearchParams()
	for (const { spec, name, value } of checked) {
		if (path.includes(`[${name}]`)) {
			path = path.replace(`[${name}]`, encodeURIComponent(values[name]!))
		} else if (spec.in === 'query') {
			query.set(spec.key, value)
		}
	}
	const url = new URL(`/${context.orgSlug}${path}`, base.origin)
	url.search = query.toString()
	return url.toString()
}

export type ResolveContext = {
	/**
	 * The host the installed app is bound to (a white-label app: its own
	 * restaurant). Null for the shared app, which claims no restaurant domain.
	 */
	appHost: string | null | undefined
	platform: LinkPlatform
	/** The link version the installed app knows; defaults to the current one. */
	appLinkVersion?: number
}

export type ResolvedLink =
	| {
			kind: 'app'
			type: GuestLinkType
			/** The screen, with `[id]` style placeholders replaced. */
			route: string
			/** Query parameters for the screen. */
			query: Record<string, string>
			/** Capability tokens from the fragment: in memory only, never forwarded. */
			fragment: Record<string, string>
			/** The same address on the website, for "open in browser". */
			web: string
	  }
	| {
			kind: 'web'
			url: string
			reason:
				| 'invalid'
				| 'other_host'
				| 'unknown_type'
				| 'not_in_app'
				| 'app_too_old'
				| 'not_this_platform'
	  }

const LOCALE_PREFIX = /^\/([a-z]{2}(?:-[A-Za-z]{2,4})?)(?=\/|$)/

function normalizeHost(host: string | null | undefined): string {
	return (host ?? '').trim().toLowerCase().replace(/\.$/, '')
}

/** Most specific first: a path with more required parameters wins. */
const GUEST_TYPES_BY_SPECIFICITY = (
	Object.keys(GUEST_LINK_TYPES) as GuestLinkType[]
).sort(
	(a, b) =>
		Object.values(GUEST_LINK_TYPES[b].params).filter((p) => p.required).length -
		Object.values(GUEST_LINK_TYPES[a].params).filter((p) => p.required).length,
)

function parseFragment(hash: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const part of hash.replace(/^#/, '').split('&')) {
		const [key, ...rest] = part.split('=')
		if (key && rest.length > 0) out[key] = rest.join('=')
	}
	return out
}

/**
 * Reads an address an installed app was opened with. Returns an app screen when
 * the host is the app's own restaurant, the type is known, it works in apps and
 * the installed version knows it; otherwise the website address, with the
 * reason. Never throws. A URL with credentials, or any other scheme, is
 * `invalid` and is returned unchanged only when it is an http(s) URL (a caller
 * decides whether to open it).
 */
export function resolveLink(
	rawUrl: string,
	context: ResolveContext,
): ResolvedLink {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return { kind: 'web', url: rawUrl, reason: 'invalid' }
	}
	if (
		(url.protocol !== 'https:' && url.protocol !== 'http:') ||
		url.username ||
		url.password
	) {
		return { kind: 'web', url: rawUrl, reason: 'invalid' }
	}
	const appHost = normalizeHost(context.appHost)
	if (!appHost || normalizeHost(url.host) !== appHost) {
		// Another organization's content, a host the app does not own, or the
		// shared app: the website.
		return { kind: 'web', url: url.toString(), reason: 'other_host' }
	}
	const fragment = parseFragment(url.hash)
	const candidates = [
		url.pathname,
		url.pathname.replace(LOCALE_PREFIX, '') || '/',
	]
	for (const type of GUEST_TYPES_BY_SPECIFICITY) {
		const def: GuestLinkDef = GUEST_LINK_TYPES[type]
		if (!candidates.includes(def.path)) continue
		const found: Record<string, string> = {}
		const queryOut: Record<string, string> = {}
		const fragmentOut: Record<string, string> = {}
		let ok = true
		for (const [name, spec] of Object.entries(def.params)) {
			const raw =
				spec.in === 'query'
					? url.searchParams.get(spec.key)
					: fragment[spec.key]
			if (raw === null || raw === undefined || raw === '') {
				if (spec.required) ok = false
				continue
			}
			if (!spec.schema.safeParse(raw).success) {
				ok = false
				continue
			}
			found[name] = raw
			if (spec.in === 'query') queryOut[name] = raw
			else fragmentOut[name] = raw
		}
		if (!ok) continue
		// Parameters the type does not know mean this is not that type (a
		// `/menu?foo=1` page is menu_home only when no other key is present).
		const knownKeys = new Set(
			Object.values(def.params)
				.filter((spec) => spec.in === 'query')
				.map((spec) => spec.key),
		)
		const stray = [...url.searchParams.keys()].some(
			(key) => !knownKeys.has(key),
		)
		if (stray && type !== 'menu_home') continue
		const web = url.toString()
		if (!def.platforms.includes(context.platform) || def.appRoute === null) {
			return {
				kind: 'web',
				url: web,
				reason: def.appRoute === null ? 'not_in_app' : 'not_this_platform',
			}
		}
		if (def.since > (context.appLinkVersion ?? APP_LINK_VERSION)) {
			return { kind: 'web', url: web, reason: 'app_too_old' }
		}
		let route: string = def.appRoute
		if (route === '/orders/[id]' && found.order) {
			route = `/orders/${encodeURIComponent(found.order)}`
			delete queryOut.order
		} else if (route === '/reservations/[id]') {
			if (found.reservation) {
				route = `/reservations/${encodeURIComponent(found.reservation)}`
				delete queryOut.reservation
			} else {
				route = '/reservations'
			}
		}
		return {
			kind: 'app',
			type,
			route,
			query: queryOut,
			fragment: fragmentOut,
			web,
		}
	}
	return { kind: 'web', url: url.toString(), reason: 'unknown_type' }
}

export type ResolvedOperatorLink = {
	type: OperatorLinkType
	orgSlug: string
	/** The screen in the operator mobile app. */
	route: string
	query: Record<string, string>
}

/**
 * Reads an operator notification link (`<base>/<orgSlug>/orders/<id>`,
 * `/mailbox?thread=`, `/mailbox?source=forms&form=`) for the operator mobile
 * app. Only hosts the caller names are accepted; anything else is null and
 * opens in the browser.
 */
export function resolveOperatorLink(
	rawUrl: string,
	context: { hosts: readonly string[]; platform: LinkPlatform },
): ResolvedOperatorLink | null {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return null
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
	if (url.username || url.password) return null
	if (!context.hosts.map(normalizeHost).includes(normalizeHost(url.host))) {
		return null
	}
	const match = /^\/([A-Za-z0-9_-]{1,128})(\/.*)$/.exec(url.pathname)
	if (!match) return null
	const orgSlug = match[1]!
	const rest = match[2]!
	const order = /^\/orders\/([A-Za-z0-9_-]{1,128})$/.exec(rest)
	if (order && context.platform !== 'web') {
		return {
			type: 'operator_order',
			orgSlug,
			route: `/orders/${order[1]}`,
			query: {},
		}
	}
	if (rest === '/mailbox') {
		const thread = url.searchParams.get('thread')
		if (thread && OPAQUE_ID.test(thread)) {
			return {
				type: 'operator_mailbox_thread',
				orgSlug,
				route: `/mailbox/${thread}`,
				query: {},
			}
		}
		const form = url.searchParams.get('form')
		if (
			url.searchParams.get('source') === 'forms' &&
			form &&
			OPAQUE_ID.test(form)
		) {
			return {
				type: 'operator_form_response',
				orgSlug,
				route: `/mailbox/forms/${form}`,
				query: {},
			}
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// App association files (#195): served by Sites per site, from the app binding
// ---------------------------------------------------------------------------

export type AppBinding = {
	appleTeamId: string | null
	iosBundleId: string
	androidPackage: string
	androidSha256: readonly string[]
}

/**
 * The paths a white-label app claims on its own host. Paths only: never a
 * fragment, a query value or a token. The `/*` form covers a language prefix.
 */
export function associationPaths(): string[] {
	const paths = new Set<string>()
	for (const def of Object.values(GUEST_LINK_TYPES) as GuestLinkDef[]) {
		if (def.appRoute === null || !def.platforms.includes('ios')) continue
		paths.add(def.path)
		paths.add(`/*${def.path}`)
	}
	return [...paths].sort()
}

/** `apple-app-site-association` for one site's app. Null without a team id. */
export function buildAppleAppSiteAssociation(binding: AppBinding) {
	if (!binding.appleTeamId) return null
	return {
		applinks: {
			details: [
				{
					appIDs: [`${binding.appleTeamId}.${binding.iosBundleId}`],
					components: associationPaths().map((path) => ({ '/': path })),
				},
			],
		},
	}
}

/** `assetlinks.json` for one site's app. Null without a signing fingerprint. */
export function buildAssetLinks(binding: AppBinding) {
	if (binding.androidSha256.length === 0) return null
	return [
		{
			relation: ['delegate_permission/common.handle_all_urls'],
			target: {
				namespace: 'android_app',
				package_name: binding.androidPackage,
				sha256_cert_fingerprints: [...binding.androidSha256],
			},
		},
	]
}

/** The Android intent filter paths (`pathPrefix`) for the app's own host. */
export function androidIntentPaths(): string[] {
	return [
		...new Set(
			(Object.values(GUEST_LINK_TYPES) as GuestLinkDef[])
				.filter(
					(def) => def.appRoute !== null && def.platforms.includes('android'),
				)
				.map((def) => def.path),
		),
	].sort()
}

/** Which link types a sender may use for a platform, for the docs and a diagnostics screen. */
export function linkTypesFor(platform: LinkPlatform): LinkType[] {
	return (Object.keys(LINK_TYPES) as LinkType[]).filter((type) =>
		(LINK_TYPES[type].platforms as readonly LinkPlatform[]).includes(platform),
	)
}
