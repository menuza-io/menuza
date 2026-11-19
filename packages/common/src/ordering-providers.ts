/**
 * Third-party ordering and delivery-app domains (#199). `classifyOrderLink`
 * sorts a link found on a Google profile (or a website) into Direct (the
 * restaurant's own ordering page), Delivery app, or Other provider.
 *
 * Pure: no I/O. The list is maintained by hand; an unknown domain is "Other".
 * Matching is by host: `order.toasttab.com` and `www.ubereats.com` match their
 * registrable domain, `notubereats.com` does not.
 */

export type OrderingProviderKind =
	'delivery_app' | 'ordering_provider' | 'reservation_provider' | 'short_link'

export type OrderingProvider = {
	/** Stable id, shown as the provider name. */
	id: string
	name: string
	kind: OrderingProviderKind
	/** Registrable domains; every sub-domain matches too. */
	domains: readonly string[]
}

export const ORDERING_PROVIDERS: readonly OrderingProvider[] = [
	{
		id: 'ubereats',
		name: 'Uber Eats',
		kind: 'delivery_app',
		domains: ['ubereats.com'],
	},
	{
		id: 'doordash',
		name: 'DoorDash',
		kind: 'delivery_app',
		domains: ['doordash.com', 'doordash.link'],
	},
	{
		id: 'grubhub',
		name: 'Grubhub',
		kind: 'delivery_app',
		domains: ['grubhub.com', 'seamless.com', 'eatstreet.com'],
	},
	{
		id: 'postmates',
		name: 'Postmates',
		kind: 'delivery_app',
		domains: ['postmates.com'],
	},
	{
		id: 'caviar',
		name: 'Caviar',
		kind: 'delivery_app',
		domains: ['trycaviar.com'],
	},
	{
		id: 'deliveroo',
		name: 'Deliveroo',
		kind: 'delivery_app',
		domains: ['deliveroo.com', 'deliveroo.co.uk', 'deliveroo.ae'],
	},
	{
		id: 'justeat',
		name: 'Just Eat',
		kind: 'delivery_app',
		domains: ['just-eat.com', 'just-eat.co.uk', 'justeat.com', 'takeaway.com'],
	},
	{
		id: 'skipthedishes',
		name: 'SkipTheDishes',
		kind: 'delivery_app',
		domains: ['skipthedishes.com'],
	},
	{
		id: 'menulog',
		name: 'Menulog',
		kind: 'delivery_app',
		domains: ['menulog.com.au'],
	},
	{
		id: 'foodpanda',
		name: 'foodpanda',
		kind: 'delivery_app',
		domains: ['foodpanda.com', 'foodpanda.pk'],
	},
	{
		id: 'zomato',
		name: 'Zomato',
		kind: 'delivery_app',
		domains: ['zomato.com'],
	},
	{
		id: 'swiggy',
		name: 'Swiggy',
		kind: 'delivery_app',
		domains: ['swiggy.com'],
	},
	{
		id: 'talabat',
		name: 'Talabat',
		kind: 'delivery_app',
		domains: ['talabat.com'],
	},
	{
		id: 'hungerstation',
		name: 'HungerStation',
		kind: 'delivery_app',
		domains: ['hungerstation.com'],
	},
	{
		id: 'jahez',
		name: 'Jahez',
		kind: 'delivery_app',
		domains: ['jahez.net', 'jahez.com'],
	},
	{
		id: 'toyou',
		name: 'ToYou',
		kind: 'delivery_app',
		domains: ['toyou.io'],
	},
	{
		id: 'mrsool',
		name: 'Mrsool',
		kind: 'delivery_app',
		domains: ['mrsool.co'],
	},
	{
		id: 'keeta',
		name: 'Keeta',
		kind: 'delivery_app',
		domains: ['keeta.com'],
	},
	{
		id: 'careem',
		name: 'Careem',
		kind: 'delivery_app',
		domains: ['careem.com'],
	},
	{
		id: 'wolt',
		name: 'Wolt',
		kind: 'delivery_app',
		domains: ['wolt.com'],
	},
	{
		id: 'glovo',
		name: 'Glovo',
		kind: 'delivery_app',
		domains: ['glovoapp.com'],
	},
	{
		id: 'ifood',
		name: 'iFood',
		kind: 'delivery_app',
		domains: ['ifood.com.br'],
	},
	{
		id: 'rappi',
		name: 'Rappi',
		kind: 'delivery_app',
		domains: ['rappi.com'],
	},
	{
		id: 'toast',
		name: 'Toast',
		kind: 'ordering_provider',
		domains: ['toasttab.com', 'toast.site'],
	},
	{
		id: 'chownow',
		name: 'ChowNow',
		kind: 'ordering_provider',
		domains: ['chownow.com', 'ordering.chownow.com'],
	},
	{
		id: 'square',
		name: 'Square Online',
		kind: 'ordering_provider',
		domains: ['square.site', 'squareup.com'],
	},
	{
		id: 'clover',
		name: 'Clover',
		kind: 'ordering_provider',
		domains: ['clover.com'],
	},
	{
		id: 'olo',
		name: 'Olo',
		kind: 'ordering_provider',
		domains: ['olo.com'],
	},
	{
		id: 'beyondmenu',
		name: 'BeyondMenu',
		kind: 'ordering_provider',
		domains: ['beyondmenu.com'],
	},
	{
		id: 'menufy',
		name: 'Menufy',
		kind: 'ordering_provider',
		domains: ['menufy.com'],
	},
	{
		id: 'gloriafood',
		name: 'GloriaFood',
		kind: 'ordering_provider',
		domains: ['gloriafood.com', 'fbgcdn.com', 'foodbooking.com'],
	},
	{
		id: 'owner',
		name: 'Owner.com',
		kind: 'ordering_provider',
		domains: ['owner.com'],
	},
	{
		id: 'slice',
		name: 'Slice',
		kind: 'ordering_provider',
		domains: ['slicelife.com'],
	},
	{
		id: 'bentobox',
		name: 'BentoBox',
		kind: 'ordering_provider',
		domains: ['getbento.com'],
	},
	{
		id: 'popmenu',
		name: 'Popmenu',
		kind: 'ordering_provider',
		domains: ['popmenu.com'],
	},
	{
		id: 'opentable',
		name: 'OpenTable',
		kind: 'reservation_provider',
		domains: ['opentable.com', 'opentable.co.uk', 'opentable.ae'],
	},
	{
		id: 'resy',
		name: 'Resy',
		kind: 'reservation_provider',
		domains: ['resy.com'],
	},
	{
		id: 'sevenrooms',
		name: 'SevenRooms',
		kind: 'reservation_provider',
		domains: ['sevenrooms.com'],
	},
	{
		id: 'tock',
		name: 'Tock',
		kind: 'reservation_provider',
		domains: ['exploretock.com', 'tock.com'],
	},
	{
		id: 'thefork',
		name: 'TheFork',
		kind: 'reservation_provider',
		domains: ['thefork.com', 'lafourchette.com'],
	},
	{
		id: 'bitly',
		name: 'Short link',
		kind: 'short_link',
		domains: ['bit.ly', 'goo.gl', 'ow.ly', 'tinyurl.com', 'rebrand.ly', 't.co'],
	},
]

export const ORDER_LINK_CLASSIFICATIONS = [
	'direct',
	'delivery_app',
	'other',
] as const
export type OrderLinkClassification =
	(typeof ORDER_LINK_CLASSIFICATIONS)[number]

export type OrderLinkClass = {
	classification: OrderLinkClassification
	/** Provider name for a known domain, else the host (or empty when no URL). */
	provider: string
	providerId: string | null
	/** Short links hide where they lead; the card says so. */
	isShortLink: boolean
}

/** Lower-case host of a URL, without `www.`; null when it is not an http(s) URL. */
export function hostOf(url: string): string | null {
	try {
		const parsed = new URL(url.trim())
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
		return parsed.hostname.toLowerCase().replace(/^www\./, '')
	} catch {
		return null
	}
}

function hostMatches(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`)
}

/** The known provider a host belongs to, if any. */
export function findOrderingProvider(host: string): OrderingProvider | null {
	// The most specific (longest) domain wins, so `ordering.chownow.com` is
	// matched before a shorter entry could shadow it.
	let best: { provider: OrderingProvider; length: number } | null = null
	for (const provider of ORDERING_PROVIDERS) {
		for (const domain of provider.domains) {
			if (hostMatches(host, domain) && (!best || domain.length > best.length)) {
				best = { provider, length: domain.length }
			}
		}
	}
	return best?.provider ?? null
}

/**
 * Classifies one link. `ownOrigins` are the restaurant's own site origins
 * (the Menuza site, its custom domain): a link on one of those hosts is
 * Direct. Nothing is Direct without a matching host, so a link to an unknown
 * ordering page is "Other".
 */
export function classifyOrderLink(
	url: string,
	ownOrigins: readonly string[] = [],
): OrderLinkClass {
	const host = hostOf(url)
	if (!host) {
		return {
			classification: 'other',
			provider: '',
			providerId: null,
			isShortLink: false,
		}
	}
	for (const origin of ownOrigins) {
		const own = hostOf(origin)
		if (own && host === own) {
			return {
				classification: 'direct',
				provider: own,
				providerId: null,
				isShortLink: false,
			}
		}
	}
	const known = findOrderingProvider(host)
	if (!known) {
		return {
			classification: 'other',
			provider: host,
			providerId: null,
			isShortLink: false,
		}
	}
	return {
		classification: known.kind === 'delivery_app' ? 'delivery_app' : 'other',
		provider: known.name,
		providerId: known.id,
		isShortLink: known.kind === 'short_link',
	}
}

/** Google Place Action types, and the Menuza link kind each belongs to. */
export const PLACE_ACTION_KINDS = {
	FOOD_ORDERING: 'order',
	FOOD_TAKEOUT: 'pickup',
	FOOD_DELIVERY: 'delivery',
	DINING_RESERVATION: 'reservation',
} as const
export type PlaceActionType = keyof typeof PLACE_ACTION_KINDS
export type OrderLinkKind = (typeof PLACE_ACTION_KINDS)[PlaceActionType]

export const ORDER_LINK_KINDS = [
	'order',
	'pickup',
	'delivery',
	'reservation',
] as const

export function placeActionKind(type: string): OrderLinkKind | null {
	return (PLACE_ACTION_KINDS as Record<string, OrderLinkKind>)[type] ?? null
}

export function placeActionTypeFor(kind: OrderLinkKind): PlaceActionType {
	switch (kind) {
		case 'order':
			return 'FOOD_ORDERING'
		case 'pickup':
			return 'FOOD_TAKEOUT'
		case 'delivery':
			return 'FOOD_DELIVERY'
		case 'reservation':
			return 'DINING_RESERVATION'
	}
}
