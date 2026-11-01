import { type PublicOrganization } from '../api/public-site'
import { isTransportSafe } from '../config/configuration'
import { type SiteAddress } from '../support/site-address'

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`)
const SLUG = new RegExp(`^${LABEL}$`)
const BRAND_DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`)

const ORDER_PATH = '/menu'
const CHECKOUT_PATH = '/menu/checkout'
const DROPS_PATH = '/drops'
const DROP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type WebsitePage =
	| { page: 'menu' }
	| { page: 'checkout' }
	| { page: 'drops' }
	| { page: 'drop'; slug: string }

function hostnameOf(value: string | null | undefined): string | null {
	const host = value?.trim().toLowerCase().replace(/\.$/, '')
	return host && HOSTNAME.test(host) ? host : null
}

function safeOrigin(value: string | null | undefined): string | null {
	const text = value?.trim()
	if (!text || !isTransportSafe(text)) return null
	try {
		return new URL(text).origin
	} catch {
		return null
	}
}

/**
 * Where the customer orders on the organization's website (the app has no
 * checkout of its own). Plain: never a token, phone, id or any query or
 * fragment, since the link opens in a browser outside the app.
 */
export function websiteOrderUrl(input: {
	organization: Pick<PublicOrganization, 'slug' | 'customDomain'>
	siteAddress: SiteAddress
	brandDomain: string
}): string | null {
	const custom = hostnameOf(input.organization.customDomain)
	if (custom) return `https://${custom}${ORDER_PATH}`
	const origin = safeOrigin(input.siteAddress.origin)
	if (origin) return `${origin}${ORDER_PATH}`
	const slug = input.organization.slug.trim().toLowerCase()
	const brand = input.brandDomain.trim().toLowerCase()
	if (SLUG.test(slug) && BRAND_DOMAIN.test(brand))
		return `https://${slug}.${brand}${ORDER_PATH}`
	return null
}

/**
 * A public page on the same site as {@link websiteOrderUrl}. Menu and drops
 * open here, and checkout is the website's `/menu/checkout`. The path is the
 * only thing that changes: still no token, phone, query, or fragment.
 */
export function websitePageUrl(
	input: {
		organization: Pick<PublicOrganization, 'slug' | 'customDomain'>
		siteAddress: SiteAddress
		brandDomain: string
	} & WebsitePage,
): string | null {
	const path = websitePagePath(input)
	const menu = websiteOrderUrl(input)
	if (!path || !menu?.endsWith(ORDER_PATH)) return null
	return `${menu.slice(0, -ORDER_PATH.length)}${path}`
}

function websitePagePath(page: WebsitePage): string | null {
	if (page.page === 'menu') return ORDER_PATH
	if (page.page === 'checkout') return CHECKOUT_PATH
	if (page.page === 'drops') return DROPS_PATH
	const slug = page.slug.trim().toLowerCase()
	return DROP_SLUG.test(slug) ? `/drop/${slug}` : null
}
