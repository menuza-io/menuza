import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'

import { getBrandDomain, getLocalDomain } from '@repo/config/brand'
import { and, db, eq, or, Organization } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'

import { orgMatchesNodeRegion } from './region.ts'

const RESERVED_SUBDOMAINS = new Set([
	'app',
	'admin',
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
])

export const publishedOrgSelect = {
	id: true,
	slug: true,
	customDomain: true,
	hasProvisionedDb: true,
	dataRegion: true,
} as const

export type PublishedOrganization = {
	id: string
	slug: string
	customDomain: string | null
	hasProvisionedDb: boolean
	dataRegion: string
}

const corsCache = new LRUCache<string, boolean>({
	max: 500,
	ttl: 30_000,
})

function appBaseUrl() {
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

async function lookupOrganizationFromDatabase(where: {
	id?: string
	slug?: string
	host?: string
}): Promise<PublishedOrganization | null> {
	if (ENV.TENANT_API_RUNTIME === 'workers') {
		return null
	}

	try {
		const identity = where.id
			? eq(Organization.id, where.id)
			: or(
					where.slug
						? eq(Organization.slug, where.slug.toLowerCase())
						: undefined,
					where.host
						? eq(Organization.customDomain, where.host.toLowerCase())
						: undefined,
				)
		if (!identity) return null

		const [organization] = await db
			.select({
				id: Organization.id,
				slug: Organization.slug,
				customDomain: Organization.customDomain,
				hasProvisionedDb: Organization.hasProvisionedDb,
				dataRegion: Organization.dataRegion,
			})
			.from(Organization)
			.where(
				and(
					eq(Organization.active, true),
					identity,
					where.id ? undefined : eq(Organization.sitePublished, true),
				),
			)
			.limit(1)
		return organization ?? null
	} catch (error) {
		console.warn('Database org lookup failed; trying APP_URL', error)
	}
	return null
}

async function lookupOrganizationFromApp(query: {
	slug?: string
	host?: string
}): Promise<PublishedOrganization | null> {
	const appUrl = appBaseUrl()
	if (!appUrl || (!query.slug && !query.host)) return null

	const params = new URLSearchParams()
	if (query.slug) params.set('slug', query.slug)
	if (query.host) params.set('host', query.host)

	try {
		const response = await fetch(`${appUrl}/resources/sites?${params}`, {
			headers: { Accept: 'application/json' },
		})
		if (!response.ok) return null
		const data = (await response.json()) as {
			id?: string
			slug?: string
			customDomain?: string | null
			dataRegion?: string | null
		}
		if (!data.id || !data.slug) return null
		return {
			id: data.id,
			slug: data.slug,
			customDomain: data.customDomain ?? null,
			hasProvisionedDb: true,
			dataRegion: data.dataRegion || 'us',
		}
	} catch (error) {
		console.warn('APP_URL org lookup failed', error)
		return null
	}
}

function brandDomain() {
	return (ENV.ROOT_APP || getBrandDomain()).toLowerCase()
}

function parseOrigin(origin: string): URL | null {
	try {
		return new URL(origin)
	} catch {
		return null
	}
}

function isLocalDevHost(hostname: string) {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname.endsWith('.localhost')
	)
}

export type OriginBinding =
	| { kind: 'slug'; slug: string }
	| { kind: 'custom'; host: string }
	| { kind: 'local-unbound' }
	| { kind: 'none' }

export function resolveOriginBinding(
	origin: string | undefined,
): OriginBinding {
	if (!origin) return { kind: 'none' }
	const url = parseOrigin(origin)
	if (!url) return { kind: 'none' }

	const isProd = ENV.NODE_ENV === 'production'
	if (isProd && url.protocol !== 'https:') return { kind: 'none' }
	if (!isProd && url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { kind: 'none' }
	}

	const hostname = url.hostname.toLowerCase()
	if (isLocalDevHost(hostname)) {
		return { kind: 'local-unbound' }
	}

	const suffix = `.${brandDomain()}`
	if (hostname === brandDomain()) return { kind: 'none' }
	if (hostname.endsWith(suffix)) {
		const subdomain = hostname.slice(0, -suffix.length)
		if (
			!subdomain ||
			subdomain.includes('.') ||
			RESERVED_SUBDOMAINS.has(subdomain)
		) {
			return { kind: 'none' }
		}
		return { kind: 'slug', slug: subdomain }
	}

	return { kind: 'custom', host: hostname }
}

export async function resolvePublishedOrganization(data: {
	slug?: string
	host?: string
}) {
	if (data.slug) {
		return (
			(await lookupOrganizationFromDatabase({ slug: data.slug })) ||
			lookupOrganizationFromApp({ slug: data.slug })
		)
	}

	if (data.host) {
		return (
			(await lookupOrganizationFromDatabase({ host: data.host })) ||
			lookupOrganizationFromApp({ host: data.host })
		)
	}

	return null
}

export async function findActiveOrganizationById(orgId: string) {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) {
		return null
	}

	return lookupOrganizationFromDatabase({ id: orgId })
}

export function organizationFromProvisionPayload(data: {
	orgId: string
	slug?: string
	customDomain?: string | null
	dataRegion?: string
}): PublishedOrganization | null {
	if (!data.slug || !data.dataRegion) return null
	return {
		id: data.orgId,
		slug: data.slug,
		customDomain: data.customDomain ?? null,
		hasProvisionedDb: true,
		dataRegion: data.dataRegion,
	}
}

export async function resolveOrganizationFromBinding(binding: OriginBinding) {
	if (binding.kind === 'slug') {
		return resolvePublishedOrganization({ slug: binding.slug })
	}
	if (binding.kind === 'custom') {
		return resolvePublishedOrganization({ host: binding.host })
	}
	return null
}

export async function resolveOrganizationFromOrigin(
	origin: string | undefined,
) {
	return resolveOrganizationFromBinding(resolveOriginBinding(origin))
}

/**
 * Bind send-code / verify to the browser Origin so a client cannot pick
 * another org's slug. Localhost (no subdomain) may fall back to body slug/host.
 */
export async function resolveOrganizationForBrowserAuth(
	origin: string | undefined,
	body: { slug?: string; host?: string },
) {
	if (origin && !(await isAllowedBrowserOrigin(origin))) {
		return null
	}

	const fromOrigin = await resolveOrganizationFromOrigin(origin)
	if (fromOrigin) {
		if (body.slug && body.slug.toLowerCase() !== fromOrigin.slug) {
			return null
		}
		if (
			body.host &&
			fromOrigin.customDomain &&
			body.host.toLowerCase() !== fromOrigin.customDomain
		) {
			return null
		}
		return fromOrigin
	}

	const isProd = ENV.NODE_ENV === 'production'
	if (!isProd && (body.slug || body.host)) {
		return resolvePublishedOrganization(body)
	}

	return null
}

export async function isAllowedBrowserOrigin(origin: string): Promise<boolean> {
	const cached = corsCache.get(origin)
	if (cached !== undefined) return cached

	const url = parseOrigin(origin)
	const isProd = ENV.NODE_ENV === 'production'
	const appHostname = `app.${brandDomain()}`
	const appUrl = parseOrigin(appBaseUrl())
	const isAppOrigin = Boolean(
		url &&
		(url.hostname === appHostname ||
			url.hostname === `admin.${brandDomain()}` ||
			(!isProd && url.hostname === `app.${getLocalDomain()}`) ||
			(!isProd && url.hostname === `admin.${getLocalDomain()}`) ||
			url.hostname === 'localhost' ||
			(appUrl && url.origin === appUrl.origin)),
	)

	if (isAppOrigin) {
		corsCache.set(origin, true)
		return true
	}

	const binding = resolveOriginBinding(origin)
	let allowed = false

	if (binding.kind === 'local-unbound') {
		allowed = ENV.NODE_ENV !== 'production'
	} else if (binding.kind === 'slug' || binding.kind === 'custom') {
		const organization = await resolveOrganizationFromBinding(binding)
		allowed = Boolean(
			organization && orgMatchesNodeRegion(organization.dataRegion),
		)
	}

	corsCache.set(origin, allowed)
	return allowed
}

export function isOperatorControlPlaneOrigin(origin: string) {
	const url = parseOrigin(origin)
	if (!url) return false
	const isProd = ENV.NODE_ENV === 'production'
	if (isProd && url.protocol !== 'https:') return false
	if (!isProd && url.protocol !== 'http:' && url.protocol !== 'https:') {
		return false
	}
	const hostname = url.hostname.toLowerCase()
	const domain = brandDomain()
	return (
		hostname === `app.${domain}` ||
		hostname === `admin.${domain}` ||
		(!isProd && hostname === `app.${getLocalDomain()}`) ||
		(!isProd && hostname === `admin.${getLocalDomain()}`)
	)
}

export async function isAllowedAnalyticsOrigin(origin: string) {
	if (isOperatorControlPlaneOrigin(origin)) return true
	return isAllowedBrowserOrigin(origin)
}
