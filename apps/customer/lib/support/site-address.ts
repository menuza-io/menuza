/**
 * How the app is bound to one organization.
 *
 * Sites resolves the organization from the request `Host`; the app has no
 * host, so it sends `slug` or `host` to tenant-api, plus an `Origin` header
 * equal to the site's public https origin. tenant-api's origin-to-organization
 * rule then still holds: the app can only sign in customers of the site it
 * claims to be.
 */
export type SiteAddress = {
	slug: string | null
	host: string | null
	origin: string | null
}

export const UNBOUND_SITE: SiteAddress = {
	slug: null,
	host: null,
	origin: null,
}

const LABEL = '[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?'
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`)
const AUTHORITY = /^([^:]+)(?::(\d{1,5}))?$/
const SCHEMES = new Set(['http', 'https'])

function nonEmpty(value: string | null | undefined): string | null {
	const trimmed = value?.trim()
	return trimmed ? trimmed : null
}

export function makeSiteAddress(fields: Partial<SiteAddress>): SiteAddress {
	return {
		slug: nonEmpty(fields.slug),
		host: nonEmpty(fields.host),
		origin: nonEmpty(fields.origin),
	}
}

export function isSiteBound(address: SiteAddress): boolean {
	return Boolean(address.slug) || Boolean(address.host)
}

export function sameSiteAddress(a: SiteAddress, b: SiteAddress): boolean {
	return a.slug === b.slug && a.host === b.host && a.origin === b.origin
}

/**
 * A build bound to one organization (white-label) always wins: an address
 * typed into an earlier un-branded install must not re-point it at another
 * organization. Un-branded builds keep what the customer chose.
 */
export function resolveSiteAddress(
	build: SiteAddress,
	stored: SiteAddress | null,
): SiteAddress {
	if (isSiteBound(build)) return build
	return stored ?? build
}

export function siteQuery(
	address: SiteAddress,
): { name: 'host' | 'slug'; value: string } | null {
	if (address.host) return { name: 'host', value: address.host }
	if (address.slug) return { name: 'slug', value: address.slug }
	return null
}

/**
 * tenant-api accepts the `Origin` binding only for real https origins. Local
 * development relies on the slug or host binding, which tenant-api allows
 * outside production.
 */
export function authOriginHeader(address: SiteAddress): string | null {
	const origin = address.origin
	if (!origin || !origin.toLowerCase().startsWith('https://')) return null
	return origin.replace(/^\/+|\/+$/g, '')
}

function firstSegment(value: string, separator: string): string {
	return value.split(separator).find((part) => part.length > 0) ?? value
}

/**
 * Parses what a customer types to connect a site: `acme`,
 * `acme.epic-startup.com`, `https://www.acme.com/menu`,
 * `http://acme.epic-startup.test:3010`. A build that requires TLS turns a
 * typed `http://` into `https://`: the origin is what the app sends to
 * tenant-api, and only an https origin binds the site.
 */
export function parseSiteAddress(
	input: string,
	brandDomain: string,
	options: { requireTls?: boolean } = {},
): SiteAddress | null {
	let value = input.trim().toLowerCase()
	if (!value) return null

	let scheme = 'https'
	const separator = value.indexOf('://')
	if (separator >= 0) {
		scheme = value.slice(0, separator)
		value = value.slice(separator + 3)
	}
	value = firstSegment(value, '/')
	value = firstSegment(value, '?')
	value = firstSegment(value, '#').trim()
	if (!value) return null

	const authority = AUTHORITY.exec(value)
	const hostname = authority?.[1]
	if (!hostname || !HOSTNAME.test(hostname)) return null
	const brand = brandDomain.trim().toLowerCase()

	if (!hostname.includes('.')) {
		return {
			slug: hostname,
			host: null,
			origin: brand ? `https://${hostname}.${brand}` : null,
		}
	}

	if (!SCHEMES.has(scheme)) return null
	const origin = `${options.requireTls ? 'https' : scheme}://${value}`
	if (brand && hostname.endsWith(`.${brand}`)) {
		const slug = hostname.slice(0, -(brand.length + 1))
		if (!slug || slug.includes('.')) {
			return { slug: null, host: hostname, origin }
		}
		return { slug, host: null, origin }
	}
	return { slug: null, host: hostname, origin }
}
