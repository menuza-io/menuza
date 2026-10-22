import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'
import { z } from 'zod'

import { getBrandDomain, getLocalDomain } from '@repo/config/brand'
import { and, db, eq, or, Organization } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'

import { orgMatchesNodeRegion } from './region.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

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
	/** Display name; older App versions do not send it. */
	name?: string | null
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
				name: Organization.name,
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

/** How long an App lookup answer is reused. A rename or publish shows within a minute. */
export const APP_LOOKUP_POSITIVE_TTL_MS = 45_000
export const APP_LOOKUP_NEGATIVE_TTL_MS = 15_000
/** The App must answer within this, or the request falls through as unresolved. */
export const APP_LOOKUP_TIMEOUT_MS = 3_000
const APP_LOOKUP_CACHE_MAX = 500

const appLookupCache = new Map<
	string,
	{ value: PublishedOrganization | null; expiresAt: number }
>()

export function clearAppLookupCacheForTest() {
	appLookupCache.clear()
}

async function lookupOrganizationFromApp(query: {
	slug?: string
	host?: string
}): Promise<PublishedOrganization | null> {
	const appUrl = appBaseUrl()
	if (!appUrl || (!query.slug && !query.host)) return null

	// Every public request resolves its organization, and an unknown origin is
	// anonymous traffic: one lookup to the US App each would turn a flood into a
	// flood on the control plane. Answers are cached briefly; errors are not.
	const cacheKey = `${query.slug ?? ''}|${query.host ?? ''}`
	const now = Date.now()
	const cached = appLookupCache.get(cacheKey)
	if (cached && cached.expiresAt > now) return cached.value

	const remember = (value: PublishedOrganization | null) => {
		if (appLookupCache.size >= APP_LOOKUP_CACHE_MAX) {
			appLookupCache.delete(appLookupCache.keys().next().value!)
		}
		appLookupCache.set(cacheKey, {
			value,
			expiresAt:
				now + (value ? APP_LOOKUP_POSITIVE_TTL_MS : APP_LOOKUP_NEGATIVE_TTL_MS),
		})
		return value
	}

	const params = new URLSearchParams()
	if (query.slug) params.set('slug', query.slug)
	if (query.host) params.set('host', query.host)

	try {
		const response = await fetch(`${appUrl}/resources/sites?${params}`, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(APP_LOOKUP_TIMEOUT_MS),
		})
		if (response.status === 404) return remember(null)
		if (!response.ok) return null
		const data = (await response.json()) as {
			id?: string
			slug?: string
			customDomain?: string | null
			dataRegion?: string | null
		}
		if (!data.id || !data.slug) return remember(null)
		return remember({
			id: data.id,
			slug: data.slug,
			customDomain: data.customDomain ?? null,
			hasProvisionedDb: true,
			dataRegion: data.dataRegion || 'us',
		})
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

export type OrganizationLookup =
	| {
			status: 'found'
			organization:
				z.infer<typeof activeOrganizationSchema> | PublishedOrganization
	  }
	| { status: 'missing' }
	/** The control plane could not be asked (timeout, 5xx, misconfiguration). Says nothing about the org. */
	| { status: 'unavailable' }

/**
 * Like `findActiveOrganizationById`, but keeps "this organization is not active
 * here" apart from "we could not find out". Callers that sign a client out on a
 * negative answer must use this one: a brief control-plane outage is not a
 * revocation.
 */
export async function lookupActiveOrganization(
	orgId: string,
): Promise<OrganizationLookup> {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return { status: 'missing' }

	const token = getInternalCommandToken()
	const appUrl = appBaseUrl()
	if (appUrl) {
		// App owns the current org flags. A node-local control-plane copy may be
		// missing or stale, especially when App uses D1 or the org changes region.
		if (token.length < 16) return { status: 'unavailable' }
		try {
			const params = new URLSearchParams({ orgId })
			const response = await fetch(
				`${appUrl}/resources/tenant-organization?${params}`,
				{
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${token}`,
					},
					redirect: 'error',
					signal: AbortSignal.timeout(5_000),
				},
			)
			if (response.status === 404) return { status: 'missing' }
			if (!response.ok) return { status: 'unavailable' }
			const parsed = activeOrganizationSchema.safeParse(await response.json())
			if (!parsed.success) return { status: 'unavailable' }
			return parsed.data.id === orgId
				? { status: 'found', organization: parsed.data }
				: { status: 'missing' }
		} catch {
			// Fail closed for authorization, but say we could not tell.
			return { status: 'unavailable' }
		}
	}

	const found = await lookupOrganizationFromDatabase({ id: orgId })
	return found
		? { status: 'found', organization: found }
		: { status: 'missing' }
}

export async function findActiveOrganizationById(orgId: string) {
	const result = await lookupActiveOrganization(orgId)
	return result.status === 'found' ? result.organization : null
}

const activeOrganizationSchema = z.object({
	id: z.string().regex(TENANT_ORG_ID_PATTERN),
	slug: z.string().min(1),
	customDomain: z.string().nullable(),
	hasProvisionedDb: z.boolean(),
	dataRegion: z.enum(['us', 'ksa']),
	name: z.string().nullable().optional(),
})

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

/**
 * Resolve the organization for a public guest route strictly from the browser
 * `Origin`. Only a tenant subdomain or custom domain names an organization; the
 * platform's own App and Admin origins, a missing Origin and an unknown
 * subdomain all resolve nothing. `slug` / `host` hints are honored only outside
 * production for an origin that names no tenant (local tools and tests), and a
 * hint that disagrees with a real Origin is refused.
 */
export async function resolveOrganizationForPublicOrigin(
	origin: string | undefined,
	hint: { slug?: string; host?: string } = {},
): Promise<PublishedOrganization | null> {
	const binding = resolveOriginBinding(origin)
	if (binding.kind === 'slug' || binding.kind === 'custom') {
		const organization = await resolveOrganizationFromBinding(binding)
		if (!organization) return null
		if (hint.slug && hint.slug.toLowerCase() !== organization.slug) return null
		if (
			hint.host &&
			(!organization.customDomain ||
				hint.host.toLowerCase() !== organization.customDomain)
		) {
			return null
		}
		return organization
	}
	if (ENV.NODE_ENV === 'production') return null
	if (!hint.slug && !hint.host) return null
	return resolvePublishedOrganization(
		hint.slug ? { slug: hint.slug } : { host: hint.host },
	)
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
			(!isProd && url.hostname === 'localhost') ||
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

/**
 * Origins that host the POS web app (`POS_ORIGINS`, comma separated, exact
 * origins). Local development also allows localhost and `*.test` hosts. Used
 * only for `/pos/*` CORS: a terminal authenticates with its bearer secret, and
 * being listed here grants nothing else.
 */
export function isPosOrigin(origin: string) {
	// `POS_ORIGINS` is operational config: read the live environment so a change
	// takes effect without a restart.
	syncEnvFromProcess()
	const url = parseOrigin(origin)
	if (!url) return false
	const isProd = ENV.NODE_ENV === 'production'
	if (isProd && url.protocol !== 'https:') return false
	const listed = String((ENV as { POS_ORIGINS?: unknown }).POS_ORIGINS ?? '')
		.split(',')
		.map((entry) => parseOrigin(entry.trim()))
		.filter((entry): entry is URL => entry !== null)
	if (listed.some((entry) => entry.origin === url.origin)) return true
	if (isProd) return false
	const hostname = url.hostname.toLowerCase()
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === getLocalDomain() ||
		hostname.endsWith(`.${getLocalDomain()}`)
	)
}

export async function isAllowedAnalyticsOrigin(origin: string) {
	if (isOperatorControlPlaneOrigin(origin)) return true
	return isAllowedBrowserOrigin(origin)
}
