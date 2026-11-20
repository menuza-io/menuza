import { brand, getBrandDomain, getLocalDomain } from '@repo/config/brand'
import { isLocalUrl } from '@repo/security/local-host'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { getCustomHostnameCnameTarget } from '#app/utils/sites/cloudflare-custom-hostnames.server.ts'

/**
 * Settings the domain features read (#139, #313, #283, #183, #276, #103).
 * Read live, so a rotated token or a changed address applies without a deploy.
 */

const ON = new Set(['1', 'true', 'yes', 'on'])

function list(value: string): string[] {
	return value
		.split(/[\s,]+/u)
		.map((part) => part.trim())
		.filter(Boolean)
}

/** The platform's own domains: nobody may connect them or a host under them. */
export function platformDomains(): string[] {
	return [
		...new Set(
			[
				getBrandDomain(),
				getLocalDomain(),
				brand.domain,
				readLiveEnv('ROOT_APP'),
			]
				.map((domain) => domain.toLowerCase())
				.filter(Boolean),
		),
	]
}

export function siteCnameTarget(): string {
	return getCustomHostnameCnameTarget()
}

/** Addresses for the root domain when the DNS host has no ALIAS or flattening. */
export function siteApexIps(): { a: string[]; aaaa: string[] } {
	return {
		a: list(readLiveEnv('SITES_APEX_IPV4')),
		aaaa: list(readLiveEnv('SITES_APEX_IPV6')),
	}
}

/**
 * The emulators (DNS zones, registrar, email routing, Domain Connect, sending
 * domains) run only on a local deployment: with a public BASE_URL a stray
 * `DOMAINS_MOCK=true` is ignored, so nothing real is ever faked.
 */
export function isDomainsMock(): boolean {
	const requested =
		ON.has(readLiveEnv('DOMAINS_MOCK').toLowerCase()) ||
		ON.has(readLiveEnv('MOCKS').toLowerCase())
	return requested && isLocalUrl(readLiveEnv('BASE_URL'))
}

/** The nameservers a Menuza-hosted zone gets when the provider names none. */
export function fallbackNameservers(): string[] {
	const configured = list(readLiveEnv('DOMAINS_NAMESERVERS'))
	return configured.length
		? configured
		: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']
}

/** Top-level domains the registrar sells. `.com` to start with. */
export function supportedTlds(): string[] {
	const configured = list(readLiveEnv('DOMAIN_SUPPORTED_TLDS')).map((tld) =>
		tld.toLowerCase().replace(/^\./u, ''),
	)
	return configured.length ? configured : ['com']
}

/** Our markup over the registrar's price, in percent. */
export function domainMarkupPercent(): number {
	const raw = readLiveEnv('DOMAIN_PRICE_MARKUP_PERCENT')
	const value = raw === '' ? Number.NaN : Number(raw)
	return Number.isFinite(value) && value >= 0 ? value : 20
}
