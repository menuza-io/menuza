/**
 * Third-party embeds for website pages (#259): a booking widget (OpenTable,
 * Resy), a beer list (Untappd), a map, a video or playlist, a ticketing page,
 * an Instagram post. Pure: the App parses what the operator pastes, Sites
 * builds the frame, and both read the same table.
 *
 * Pasted code is NEVER rendered. `parseEmbed` finds the web addresses and
 * attributes inside whatever was pasted (a link, an `<iframe>`, a `<script>`),
 * keeps only the ids of an allowlisted provider, and discards everything else.
 * What is stored is `{ provider, ids, height }`; the renderer rebuilds the
 * frame from those ids with `buildEmbedFrame`, which checks every id again, so
 * even a hand-written config cannot put an address, a script or markup on a
 * page. Anything not recognised is `embed_unsupported`.
 *
 * Every provider here can set marketing cookies, so in the cookie banner's
 * Required mode (#89) a frame waits for the guest's consent.
 */

export const EMBED_PROVIDERS = [
	'opentable',
	'resy',
	'untappd',
	'google_maps',
	'youtube',
	'vimeo',
	'eventbrite',
	'instagram',
] as const
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number]

export type EmbedIds = Record<string, string>

export type EmbedHeight = 'auto' | number

/** What the section stores in `WebsitePageSection.config`. */
export type EmbedConfig = {
	provider: EmbedProvider
	ids: EmbedIds
	height: EmbedHeight
}

export type EmbedError = 'embed_unsupported'

export const MAX_EMBED_INPUT = 4000
export const MIN_EMBED_HEIGHT = 200
export const MAX_EMBED_HEIGHT = 1600

export function isEmbedProvider(value: unknown): value is EmbedProvider {
	return (
		typeof value === 'string' &&
		(EMBED_PROVIDERS as readonly string[]).includes(value)
	)
}

type ProviderSpec = {
	label: string
	/** A booking widget: the editor warns when the page also has our own. */
	booking: boolean
	/** The frame is a 16:9 player, so its height can follow its width. */
	autoHeight: boolean
	defaultHeight: number
	/** Origins the page's `frame-src` allows while a page uses this provider. */
	frameOrigins: readonly string[]
	/** Ids found in one address (already parsed, host lower-cased), or null. */
	fromUrl: (url: URL) => EmbedIds | null
	/** Ids found in an attribute pasted in an embed snippet, or null. */
	fromAttributes?: (attributes: Map<string, string>) => EmbedIds | null
	/** The frame address, from ids that passed `validIds`. */
	frameSrc: (ids: EmbedIds) => string
	/** A plain link to the same thing, for the fallback and for no-script. */
	pageUrl: (ids: EmbedIds) => string
	/** Strict shape of every id; anything else is refused. */
	idPatterns: Record<string, RegExp>
	/** Short human line: "Detected: venue 12345". */
	detected: (ids: EmbedIds) => string
}

const DIGITS = /^\d{1,12}$/u
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/iu
const CODE = /^[A-Za-z0-9_-]{5,64}$/u

/** True when `host` is `domain` or one of its sub-domains (never `evil-domain`). */
function hostIs(host: string, ...domains: string[]) {
	return domains.some(
		(domain) => host === domain || host.endsWith(`.${domain}`),
	)
}

/** The domain with any country ending: `opentable.com`, `opentable.co.uk`. */
function hostIsCountry(host: string, name: string) {
	return new RegExp(
		`(^|\\.)${name}\\.(com|co\\.uk|ca|de|jp|com\\.au|ie|es|nl|mx|ae|sg|com\\.mx|it|fr)$`,
		'u',
	).test(host)
}

const PROVIDERS: Record<EmbedProvider, ProviderSpec> = {
	opentable: {
		label: 'OpenTable',
		booking: true,
		autoHeight: false,
		defaultHeight: 320,
		frameOrigins: ['https://www.opentable.com'],
		fromUrl: (url): EmbedIds | null => {
			if (!hostIsCountry(url.hostname, 'opentable')) return null
			const rid = url.searchParams.get('rid') ?? url.searchParams.get('restref')
			return rid && DIGITS.test(rid) ? { restaurantId: rid } : null
		},
		frameSrc: (ids) =>
			`https://www.opentable.com/widget/reservation/canvas?rid=${ids.restaurantId}&type=standard&theme=standard&iframe=true&domain=com&lang=en-US&newtab=false&cfe=true`,
		pageUrl: (ids) =>
			`https://www.opentable.com/restref/client/?rid=${ids.restaurantId}`,
		idPatterns: { restaurantId: DIGITS },
		detected: (ids) => `restaurant ${ids.restaurantId}`,
	},
	resy: {
		label: 'Resy',
		booking: true,
		autoHeight: false,
		defaultHeight: 560,
		frameOrigins: ['https://widgets.resy.com', 'https://resy.com'],
		fromUrl: (url): EmbedIds | null => {
			if (url.hostname === 'widgets.resy.com') {
				// widgets.resy.com/#/reservations?venueId=1234&apiKey=...
				const query = new URLSearchParams(url.hash.split('?')[1] ?? url.search)
				const venueId = query.get('venueId')
				const apiKey = query.get('apiKey')
				return venueId &&
					apiKey &&
					DIGITS.test(venueId) &&
					/^[A-Za-z0-9]{8,64}$/u.test(apiKey)
					? { venueId, apiKey }
					: null
			}
			if (url.hostname === 'resy.com' || url.hostname === 'www.resy.com') {
				const match =
					/^\/cities\/([a-z0-9-]{2,40})\/(?:venues\/)?([a-z0-9-]{2,100})\/?$/iu.exec(
						url.pathname,
					)
				return match
					? { city: match[1]!.toLowerCase(), venue: match[2]!.toLowerCase() }
					: null
			}
			return null
		},
		fromAttributes: (attributes): EmbedIds | null => {
			const venueId = attributes.get('data-venue-id')
			const apiKey = attributes.get('data-api-key')
			return venueId &&
				apiKey &&
				DIGITS.test(venueId) &&
				/^[A-Za-z0-9]{8,64}$/u.test(apiKey)
				? { venueId, apiKey }
				: null
		},
		frameSrc: (ids) =>
			ids.venueId
				? `https://widgets.resy.com/#/reservations?venueId=${ids.venueId}&apiKey=${ids.apiKey}`
				: `https://resy.com/cities/${ids.city}/venues/${ids.venue}`,
		pageUrl: (ids) =>
			ids.venueId
				? 'https://resy.com/'
				: `https://resy.com/cities/${ids.city}/venues/${ids.venue}`,
		idPatterns: {
			venueId: DIGITS,
			apiKey: /^[A-Za-z0-9]{8,64}$/u,
			city: /^[a-z0-9-]{2,40}$/u,
			venue: /^[a-z0-9-]{2,100}$/u,
		},
		detected: (ids) =>
			ids.venueId ? `venue ${ids.venueId}` : `${ids.venue} (${ids.city})`,
	},
	untappd: {
		label: 'Untappd',
		booking: false,
		autoHeight: false,
		defaultHeight: 700,
		frameOrigins: ['https://embed.untappdmenus.com'],
		fromUrl: (url): EmbedIds | null => {
			if (url.hostname === 'embed.untappdmenus.com') {
				const id = url.searchParams.get('id') ?? url.searchParams.get('menu')
				return id && DIGITS.test(id) ? { menuId: id } : null
			}
			if (hostIs(url.hostname, 'untappd.com')) {
				const match =
					/^\/(?:locations|venue|v\/[a-z0-9-]+)\/(\d{1,12})(?:\/|$)/iu.exec(
						url.pathname,
					) ?? /^\/v\/[a-z0-9-]+\/(\d{1,12})\/?$/iu.exec(url.pathname)
				return match ? { menuId: match[1]! } : null
			}
			return null
		},
		fromAttributes: (attributes): EmbedIds | null => {
			const id =
				attributes.get('data-embed-id') ?? attributes.get('data-menu-id')
			return id && DIGITS.test(id) ? { menuId: id } : null
		},
		frameSrc: (ids) => `https://embed.untappdmenus.com/embed?id=${ids.menuId}`,
		pageUrl: (ids) => `https://untappd.com/venue/${ids.menuId}`,
		idPatterns: { menuId: DIGITS },
		detected: (ids) => `menu ${ids.menuId}`,
	},
	google_maps: {
		label: 'Google Maps',
		booking: false,
		autoHeight: false,
		defaultHeight: 450,
		frameOrigins: ['https://www.google.com'],
		fromUrl: (url): EmbedIds | null => {
			if (url.hostname !== 'www.google.com' && url.hostname !== 'google.com') {
				return null
			}
			if (url.pathname !== '/maps/embed') return null
			const pb = url.searchParams.get('pb')
			return pb && /^[A-Za-z0-9!_\-.,%:;=+/ ]{20,2000}$/u.test(pb)
				? { pb }
				: null
		},
		frameSrc: (ids) =>
			`https://www.google.com/maps/embed?pb=${encodeURIComponent(ids.pb!)}`,
		pageUrl: () => 'https://www.google.com/maps',
		idPatterns: { pb: /^[A-Za-z0-9!_\-.,%:;=+/ ]{20,2000}$/u },
		detected: () => 'map',
	},
	youtube: {
		label: 'YouTube',
		booking: false,
		autoHeight: true,
		defaultHeight: 450,
		frameOrigins: ['https://www.youtube-nocookie.com'],
		fromUrl: (url): EmbedIds | null => {
			if (url.hostname === 'youtu.be') {
				const id = url.pathname.slice(1).split('/')[0] ?? ''
				return CODE.test(id) && id.length === 11 ? { video: id } : null
			}
			if (!hostIs(url.hostname, 'youtube.com', 'youtube-nocookie.com'))
				return null
			const list = url.searchParams.get('list')
			if (list && /^[A-Za-z0-9_-]{10,64}$/u.test(list))
				return { playlist: list }
			const watch = url.searchParams.get('v')
			if (watch && /^[A-Za-z0-9_-]{11}$/u.test(watch)) return { video: watch }
			const embed = /^\/embed\/([A-Za-z0-9_-]{11})$/u.exec(url.pathname)
			return embed ? { video: embed[1]! } : null
		},
		frameSrc: (ids) =>
			ids.playlist
				? `https://www.youtube-nocookie.com/embed/videoseries?list=${ids.playlist}`
				: `https://www.youtube-nocookie.com/embed/${ids.video}`,
		pageUrl: (ids) =>
			ids.playlist
				? `https://www.youtube.com/playlist?list=${ids.playlist}`
				: `https://www.youtube.com/watch?v=${ids.video}`,
		idPatterns: {
			video: /^[A-Za-z0-9_-]{11}$/u,
			playlist: /^[A-Za-z0-9_-]{10,64}$/u,
		},
		detected: (ids) =>
			ids.playlist ? `playlist ${ids.playlist}` : `video ${ids.video}`,
	},
	vimeo: {
		label: 'Vimeo',
		booking: false,
		autoHeight: true,
		defaultHeight: 450,
		frameOrigins: ['https://player.vimeo.com', 'https://vimeo.com'],
		fromUrl: (url): EmbedIds | null => {
			if (!hostIs(url.hostname, 'vimeo.com')) return null
			const showcase = /^\/(?:showcase|album)\/(\d{3,12})(?:\/|$)/u.exec(
				url.pathname,
			)
			if (showcase) return { showcase: showcase[1]! }
			const video =
				/^\/video\/(\d{3,12})$/u.exec(url.pathname) ??
				/^\/(?:channels\/[a-z0-9_-]+\/)?(\d{3,12})$/iu.exec(url.pathname)
			return video ? { video: video[1]! } : null
		},
		frameSrc: (ids) =>
			ids.showcase
				? `https://vimeo.com/showcase/${ids.showcase}/embed`
				: `https://player.vimeo.com/video/${ids.video}?dnt=1`,
		pageUrl: (ids) =>
			ids.showcase
				? `https://vimeo.com/showcase/${ids.showcase}`
				: `https://vimeo.com/${ids.video}`,
		idPatterns: { video: /^\d{3,12}$/u, showcase: /^\d{3,12}$/u },
		detected: (ids) =>
			ids.showcase ? `showcase ${ids.showcase}` : `video ${ids.video}`,
	},
	eventbrite: {
		label: 'Eventbrite',
		booking: false,
		autoHeight: false,
		defaultHeight: 560,
		frameOrigins: ['https://www.eventbrite.com'],
		fromUrl: (url): EmbedIds | null => {
			if (!hostIsCountry(url.hostname, 'eventbrite')) return null
			const eid = url.searchParams.get('eid')
			if (
				url.pathname === '/tickets-external' &&
				eid &&
				/^\d{8,14}$/u.test(eid)
			) {
				return { eventId: eid }
			}
			const slug = /^\/e\/[a-z0-9-]*?-?(\d{8,14})\/?$/iu.exec(url.pathname)
			return slug ? { eventId: slug[1]! } : null
		},
		frameSrc: (ids) =>
			`https://www.eventbrite.com/tickets-external?eid=${ids.eventId}&ref=etckt`,
		pageUrl: (ids) => `https://www.eventbrite.com/e/${ids.eventId}`,
		idPatterns: { eventId: /^\d{8,14}$/u },
		detected: (ids) => `event ${ids.eventId}`,
	},
	instagram: {
		label: 'Instagram post',
		booking: false,
		autoHeight: false,
		defaultHeight: 640,
		frameOrigins: ['https://www.instagram.com'],
		fromUrl: (url): EmbedIds | null => {
			if (!hostIs(url.hostname, 'instagram.com')) return null
			const match = /^\/(p|reel|tv)\/([A-Za-z0-9_-]{5,32})\/?$/u.exec(
				url.pathname,
			)
			return match ? { kind: match[1]!, code: match[2]! } : null
		},
		frameSrc: (ids) =>
			`https://www.instagram.com/${ids.kind}/${ids.code}/embed/`,
		pageUrl: (ids) => `https://www.instagram.com/${ids.kind}/${ids.code}/`,
		idPatterns: {
			kind: /^(p|reel|tv)$/u,
			code: /^[A-Za-z0-9_-]{5,32}$/u,
		},
		detected: (ids) => `${ids.kind === 'p' ? 'post' : ids.kind} ${ids.code}`,
	},
}

export function embedProviderLabel(provider: EmbedProvider) {
	return PROVIDERS[provider].label
}

export function embedProviderInfo(provider: EmbedProvider) {
	const spec = PROVIDERS[provider]
	return {
		label: spec.label,
		booking: spec.booking,
		autoHeight: spec.autoHeight,
		defaultHeight: spec.defaultHeight,
	}
}

/** OpenTable and Resy embeds book tables, like our own reservation section. */
export function isBookingEmbed(provider: unknown) {
	return isEmbedProvider(provider) && PROVIDERS[provider].booking
}

const URL_IN_TEXT = /(?:https?:)?\/\/[^\s"'<>`\\)]+/giu
const ATTRIBUTE =
	/\b(data-[a-z0-9-]{2,40})\s*=\s*(?:"([^"]{0,200})"|'([^']{0,200})')/giu

/** Every address in the pasted text, parsed; unparsable ones are dropped. */
function addressesIn(input: string): URL[] {
	const out: URL[] = []
	for (const match of input.match(URL_IN_TEXT) ?? []) {
		const raw = match.startsWith('//') ? `https:${match}` : match
		// `http:` is upgraded: a frame is only ever built as https.
		const secured = raw.replace(/^http:/iu, 'https:')
		try {
			const url = new URL(secured)
			if (url.protocol === 'https:' && !url.username && !url.password) {
				url.hostname = url.hostname.toLowerCase()
				out.push(url)
			}
		} catch {
			// not an address
		}
	}
	return out
}

function attributesIn(input: string) {
	const map = new Map<string, string>()
	for (const match of input.matchAll(ATTRIBUTE)) {
		const name = match[1]!.toLowerCase()
		if (!map.has(name)) map.set(name, (match[2] ?? match[3] ?? '').trim())
	}
	return map
}

/** `ids` all present and strictly shaped for the provider. */
function validIds(spec: ProviderSpec, ids: unknown): ids is EmbedIds {
	if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return false
	const entries = Object.entries(ids as Record<string, unknown>)
	if (entries.length === 0 || entries.length > 4) return false
	return entries.every(([key, value]) => {
		const pattern = spec.idPatterns[key]
		return (
			pattern !== undefined && typeof value === 'string' && pattern.test(value)
		)
	})
}

export type ParsedEmbed =
	| { ok: true; provider: EmbedProvider; ids: EmbedIds; detected: string }
	| { ok: false; error: EmbedError }

/**
 * Finds the ids of `provider` in what the operator pasted: a link, an
 * `<iframe>` or `<script>` snippet, or an address on its own. Nothing of the
 * input is kept besides the ids. A different provider's link, an unknown host,
 * an `http:` or `javascript:` address, or text without an id is
 * `embed_unsupported`.
 */
export function parseEmbed(provider: unknown, input: unknown): ParsedEmbed {
	const fail: ParsedEmbed = { ok: false, error: 'embed_unsupported' }
	if (!isEmbedProvider(provider) || typeof input !== 'string') return fail
	if (input.length === 0 || input.length > MAX_EMBED_INPUT) return fail
	const spec = PROVIDERS[provider]
	const candidates: Array<EmbedIds | null> = []
	for (const url of addressesIn(input)) candidates.push(spec.fromUrl(url))
	if (spec.fromAttributes)
		candidates.push(spec.fromAttributes(attributesIn(input)))
	for (const ids of candidates) {
		if (ids && validIds(spec, ids)) {
			return { ok: true, provider, ids, detected: spec.detected(ids) }
		}
	}
	return fail
}

/** "Detected: venue 12345" for a stored config, or null when it is not valid. */
export function embedDetectedLabel(config: unknown): string | null {
	const checked = readEmbedConfig(config)
	return checked ? PROVIDERS[checked.provider].detected(checked.ids) : null
}

/** A stored height: `auto` where the provider allows it, else a bounded number. */
export function normalizeEmbedHeight(
	provider: EmbedProvider,
	value: unknown,
): EmbedHeight {
	const spec = PROVIDERS[provider]
	if (
		value === 'auto' ||
		value === undefined ||
		value === null ||
		value === ''
	) {
		return spec.autoHeight ? 'auto' : spec.defaultHeight
	}
	const number = typeof value === 'number' ? value : Number(value)
	if (!Number.isFinite(number))
		return spec.autoHeight ? 'auto' : spec.defaultHeight
	return Math.min(
		MAX_EMBED_HEIGHT,
		Math.max(MIN_EMBED_HEIGHT, Math.round(number)),
	)
}

/**
 * The config of a section, checked: the provider is on the allowlist and every
 * id has its strict shape. Anything else is null, and the page shows nothing.
 */
export function readEmbedConfig(value: unknown): EmbedConfig | null {
	if (!value || typeof value !== 'object') return null
	const raw = value as Record<string, unknown>
	if (!isEmbedProvider(raw.provider)) return null
	const spec = PROVIDERS[raw.provider]
	if (!validIds(spec, raw.ids)) return null
	// Rebuild the ids from the known keys only.
	const ids: EmbedIds = {}
	for (const key of Object.keys(spec.idPatterns)) {
		const id = (raw.ids as Record<string, unknown>)[key]
		if (typeof id === 'string') ids[key] = id
	}
	return {
		provider: raw.provider,
		ids,
		height: normalizeEmbedHeight(raw.provider, raw.height),
	}
}

/** Sandbox flags every frame gets: no top-level navigation, no downloads. */
export const EMBED_SANDBOX =
	'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation'

export type EmbedFrame = {
	/** Always `https:`, on one of the provider's origins. */
	src: string
	/** The provider's page, as the link that stays when the frame cannot load. */
	fallbackUrl: string
	label: string
	provider: EmbedProvider
	sandbox: string
	allow: string
	/** `px` for a fixed height, `aspect` for a 16:9 player. */
	size: { kind: 'px'; px: number } | { kind: 'aspect'; ratio: '16/9' }
	/** All embeds may set marketing cookies. */
	consent: 'marketing'
}

export function buildEmbedFrame(config: unknown): EmbedFrame | null {
	const checked = readEmbedConfig(config)
	if (!checked) return null
	const spec = PROVIDERS[checked.provider]
	const src = spec.frameSrc(checked.ids)
	// The address is built here, never copied: keep it on the provider's origins.
	const origin = new URL(src).origin
	if (!spec.frameOrigins.includes(origin)) return null
	const video = checked.provider === 'youtube' || checked.provider === 'vimeo'
	return {
		src,
		fallbackUrl: spec.pageUrl(checked.ids),
		label: spec.label,
		provider: checked.provider,
		sandbox: EMBED_SANDBOX,
		allow: video ? 'encrypted-media; picture-in-picture; fullscreen' : '',
		size:
			checked.height === 'auto' && spec.autoHeight
				? { kind: 'aspect', ratio: '16/9' }
				: {
						kind: 'px',
						px:
							typeof checked.height === 'number'
								? checked.height
								: spec.defaultHeight,
					},
		consent: 'marketing',
	}
}

/** Providers a page's embed sections use, once each, valid ones only. */
export function embedProvidersOf(
	sections: ReadonlyArray<{ type: string; config: unknown }>,
): EmbedProvider[] {
	const providers = new Set<EmbedProvider>()
	for (const section of sections) {
		if (section.type !== 'embed') continue
		const config = readEmbedConfig(parseJson(section.config))
		if (config) providers.add(config.provider)
	}
	return [...providers]
}

function parseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value
	try {
		return JSON.parse(value)
	} catch {
		return null
	}
}

/**
 * The origins a page's `frame-src` needs for its embeds, and no others: a
 * page with no embed adds nothing, a page with one OpenTable section adds
 * OpenTable only.
 */
export function embedFrameOrigins(
	sections: ReadonlyArray<{ type: string; config: unknown }>,
): string[] {
	const origins = new Set<string>()
	for (const provider of embedProvidersOf(sections)) {
		for (const origin of PROVIDERS[provider].frameOrigins) origins.add(origin)
	}
	return [...origins].sort()
}
