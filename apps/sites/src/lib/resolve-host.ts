import { getBrandDomain } from '@repo/config/brand'

const RESERVED_SUBDOMAINS = new Set([
	'app',
	'admin',
	'pos',
	'app-staging',
	'admin-staging',
	'cms',
	'docs',
	'studio',
	'api',
	'api-ksa',
	'www',
	'mail',
	'ftp',
	'sites',
	'status',
	'cdn',
	'static',
	'assets',
	'staging',
	'jobs',
	'jobs-staging',
	'tenant-us',
	'tenant-us-staging',
	'tenant-ksa',
	'tenant-ksa-staging',
])

export type HostResolution =
	| { kind: 'slug'; orgSlug: string }
	| { kind: 'custom'; host: string }
	| { kind: 'none' }

export type SiteHostEnv = {
	ROOT_APP?: string
	PUBLIC_SITE_HOST_SUFFIXES?: string
}

export function brandSiteDomain() {
	return getBrandDomain()
}

function splitHosts(value: string | undefined) {
	if (!value) return []
	return value
		.split(/[\s,]+/)
		.map((part) => part.trim().toLowerCase().replace(/^\./, ''))
		.filter((host) => host.length > 0 && host !== 'localhost')
}

/**
 * Apex domains whose first subdomain is an org slug.
 * `{org}.{brand domain}`, `{org}.{ROOT_APP}`, and extra Worker routes.
 */
export function getSiteHostSuffixes(env: SiteHostEnv = {}): string[] {
	const values = [
		brandSiteDomain(),
		...splitHosts(env.ROOT_APP),
		...splitHosts(env.PUBLIC_SITE_HOST_SUFFIXES),
	]
	return [...new Set(values)].sort((a, b) => b.length - a.length)
}

/**
 * Resolve Host / X-Forwarded-Host to either an org slug subdomain or a custom domain.
 */
export function resolveHost(
	hostHeader: string | null,
	env: SiteHostEnv = {},
): HostResolution {
	if (!hostHeader) return { kind: 'none' }

	const hostWithoutPort = hostHeader.split(':')[0]?.toLowerCase() ?? ''
	if (!hostWithoutPort) return { kind: 'none' }

	for (const parent of getSiteHostSuffixes(env)) {
		if (hostWithoutPort === parent) {
			return { kind: 'none' }
		}

		const suffix = `.${parent}`
		if (!hostWithoutPort.endsWith(suffix)) continue

		const subdomain = hostWithoutPort.slice(0, -suffix.length)
		if (
			!subdomain ||
			subdomain.includes('.') ||
			RESERVED_SUBDOMAINS.has(subdomain)
		) {
			return { kind: 'none' }
		}
		return { kind: 'slug', orgSlug: subdomain }
	}

	return { kind: 'custom', host: hostWithoutPort }
}

/** @deprecated Prefer resolveHost */
export function resolveOrgSlugFromHost(
	hostHeader: string | null,
	env: SiteHostEnv = {},
): string | null {
	const resolved = resolveHost(hostHeader, env)
	return resolved.kind === 'slug' ? resolved.orgSlug : null
}
