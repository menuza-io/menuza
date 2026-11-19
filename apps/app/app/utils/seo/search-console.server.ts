/**
 * Google Search Console (#138, flag `seo.search_console`). Connecting signs
 * the operator in with Google (OAuth, `@repo/integrations`), then Menuza:
 *
 *  1. asks the Site Verification API for a META token and puts it on the home
 *     page (the public site payload carries it),
 *  2. adds the site's primary origin as a property and verifies it,
 *  3. submits the existing `/sitemap.xml`.
 *
 * A daily job (`/resources/jobs/search-console-sync`) finishes a setup that
 * could not verify yet, re-runs it when the primary host changed, and stores
 * 28-day totals and top queries and pages. Aggregate search data only, never
 * guest data. Every Google call goes through `SearchConsoleClient`, which a
 * test replaces (`setSearchConsoleClientFactory`); without Google credentials
 * outside production the mock client answers.
 */
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	and,
	db,
	desc,
	eq,
	gte,
	Integration,
	Organization,
	SearchConsoleDaily,
	SearchConsoleTop,
} from '@repo/database'
import {
	isSearchConsoleMockMode,
	providerRegistry,
	SEARCH_CONSOLE_PROVIDER,
	tokenManager,
} from '@repo/integrations'
import { ENV } from 'varlock/env'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { resolveSitesOrigin } from '#app/utils/sites/sites-origin.server.ts'

export const SEARCH_CONSOLE_FLAG = 'seo.search_console'
/** Days of totals the SEO screen shows. */
export const SEARCH_CONSOLE_DAYS = 28
/** Search Console data is about two days late. */
export const SEARCH_CONSOLE_LAG_DAYS = 2
const TOP_ROWS = 10

export type SearchConsoleErrorCode =
	| 'gsc_not_owner'
	| 'gsc_verification_failed'
	| 'gsc_api_error'
	| 'gsc_not_connected'

export class SearchConsoleError extends Error {
	constructor(
		readonly code: SearchConsoleErrorCode,
		readonly status?: number,
	) {
		super(code)
	}
}

export type SitemapStatus = {
	submitted: number
	indexed: number
	errors: number
	warnings: number
	lastDownloaded: string | null
}

export type SearchConsoleConfig = {
	/** The property: the site's primary origin with a trailing slash. */
	siteUrl?: string
	/** META token rendered on the home page. */
	verificationToken?: string
	status?: 'verifying' | 'ready' | 'error'
	error?: SearchConsoleErrorCode | null
	verifiedAt?: string
	sitemapSubmittedAt?: string
	sitemap?: SitemapStatus | null
	lastSyncAt?: string
}

export type SearchAnalyticsRow = {
	keys: string[]
	clicks: number
	impressions: number
	position: number
}

export interface SearchConsoleClient {
	getVerificationToken(siteUrl: string): Promise<string>
	verifySite(siteUrl: string): Promise<void>
	addSite(siteUrl: string): Promise<void>
	submitSitemap(siteUrl: string, sitemapUrl: string): Promise<void>
	getSitemap(siteUrl: string, sitemapUrl: string): Promise<SitemapStatus>
	query(
		siteUrl: string,
		body: {
			startDate: string
			endDate: string
			dimensions: Array<'date' | 'query' | 'page'>
			rowLimit: number
		},
	): Promise<SearchAnalyticsRow[]>
}

function errorFor(status: number): SearchConsoleError {
	return new SearchConsoleError(
		status === 403 ? 'gsc_not_owner' : 'gsc_api_error',
		status,
	)
}

/** The live Google client for one access token. */
export function googleSearchConsoleClient(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): SearchConsoleClient {
	const call = async (url: string, init: RequestInit = {}) => {
		const response = await fetchImpl(url, {
			...init,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
				...init.headers,
			},
			signal: AbortSignal.timeout(15_000),
		})
		if (!response.ok) throw errorFor(response.status)
		const text = await response.text()
		return text ? (JSON.parse(text) as unknown) : null
	}
	const site = (siteUrl: string) =>
		`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`
	return {
		async getVerificationToken(siteUrl) {
			const data = (await call(
				'https://www.googleapis.com/siteVerification/v1/token',
				{
					method: 'POST',
					body: JSON.stringify({
						site: { type: 'SITE', identifier: siteUrl },
						verificationMethod: 'META',
					}),
				},
			)) as { token?: string } | null
			const content = /content\s*=\s*["']([^"']+)["']/i.exec(data?.token ?? '')
			const token = content?.[1] ?? data?.token
			if (!token) throw new SearchConsoleError('gsc_api_error')
			return token
		},
		async verifySite(siteUrl) {
			try {
				await call(
					'https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=META',
					{
						method: 'POST',
						body: JSON.stringify({
							site: { type: 'SITE', identifier: siteUrl },
						}),
					},
				)
			} catch (error) {
				if (error instanceof SearchConsoleError && error.status === 400) {
					throw new SearchConsoleError('gsc_verification_failed', 400)
				}
				throw error
			}
		},
		async addSite(siteUrl) {
			await call(site(siteUrl), { method: 'PUT' })
		},
		async submitSitemap(siteUrl, sitemapUrl) {
			await call(
				`${site(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
				{
					method: 'PUT',
				},
			)
		},
		async getSitemap(siteUrl, sitemapUrl) {
			const data = (await call(
				`${site(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
			)) as {
				errors?: string
				warnings?: string
				lastDownloaded?: string
				contents?: Array<{ submitted?: string; indexed?: string }>
			} | null
			const contents = data?.contents ?? []
			return {
				submitted: contents.reduce((n, c) => n + Number(c.submitted ?? 0), 0),
				indexed: contents.reduce((n, c) => n + Number(c.indexed ?? 0), 0),
				errors: Number(data?.errors ?? 0),
				warnings: Number(data?.warnings ?? 0),
				lastDownloaded: data?.lastDownloaded ?? null,
			}
		},
		async query(siteUrl, body) {
			const data = (await call(`${site(siteUrl)}/searchAnalytics/query`, {
				method: 'POST',
				body: JSON.stringify(body),
			})) as { rows?: SearchAnalyticsRow[] } | null
			return data?.rows ?? []
		},
	}
}

/** Deterministic data for local development without Google credentials. */
export function mockSearchConsoleClient(): SearchConsoleClient {
	return {
		async getVerificationToken(siteUrl) {
			let hash = 0
			for (const char of siteUrl) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
			return `mock-gsc-${hash.toString(36)}`
		},
		async verifySite() {},
		async addSite() {},
		async submitSitemap() {},
		async getSitemap() {
			return {
				submitted: 12,
				indexed: 10,
				errors: 0,
				warnings: 1,
				lastDownloaded: new Date().toISOString(),
			}
		},
		async query(_siteUrl, body) {
			if (body.dimensions[0] === 'date') {
				const rows: SearchAnalyticsRow[] = []
				for (
					let day = new Date(`${body.startDate}T00:00:00Z`);
					day <= new Date(`${body.endDate}T00:00:00Z`);
					day = new Date(day.getTime() + 86_400_000)
				) {
					const n = day.getUTCDate()
					rows.push({
						keys: [day.toISOString().slice(0, 10)],
						clicks: 5 + (n % 7),
						impressions: 120 + n * 3,
						position: 8 + (n % 5),
					})
				}
				return rows
			}
			const values =
				body.dimensions[0] === 'query'
					? [
							'shawarma near me',
							'lebanese restaurant',
							'best falafel',
							'brunch olaya',
						]
					: ['/', '/menu', '/locations', '/reserve']
			return values.map((value, index) => ({
				keys: [value],
				clicks: 40 - index * 8,
				impressions: 600 - index * 90,
				position: 3 + index * 2,
			}))
		},
	}
}

type ClientFactory = (
	integration: typeof Integration.$inferSelect,
) => Promise<SearchConsoleClient>

let clientFactoryOverride: ClientFactory | null = null

/** Tests replace the Google client; `null` restores the default. */
export function setSearchConsoleClientFactory(factory: ClientFactory | null) {
	clientFactoryOverride = factory
}

async function clientFor(
	integration: typeof Integration.$inferSelect,
): Promise<SearchConsoleClient> {
	if (clientFactoryOverride) return clientFactoryOverride(integration)
	if (isSearchConsoleMockMode()) return mockSearchConsoleClient()
	const token = await tokenManager.getValidAccessToken(
		integration as never,
		providerRegistry.get(SEARCH_CONSOLE_PROVIDER),
	)
	if (!token) throw new SearchConsoleError('gsc_not_connected')
	return googleSearchConsoleClient(token)
}

export async function isSearchConsoleEnabled(organizationId: string) {
	return (
		(await getFeatureFlag(SEARCH_CONSOLE_FLAG, { organizationId })) === true
	)
}

function parseConfig(value: string | null | undefined): SearchConsoleConfig {
	if (!value) return {}
	try {
		const parsed: unknown = JSON.parse(value)
		return parsed && typeof parsed === 'object'
			? (parsed as SearchConsoleConfig)
			: {}
	} catch {
		return {}
	}
}

export async function loadSearchConsoleIntegration(organizationId: string) {
	const [integration] = await db
		.select()
		.from(Integration)
		.where(
			and(
				eq(Integration.organizationId, organizationId),
				eq(Integration.providerName, SEARCH_CONSOLE_PROVIDER),
				eq(Integration.isActive, true),
			),
		)
		.orderBy(desc(Integration.updatedAt))
		.limit(1)
	if (!integration) return null
	return { integration, config: parseConfig(integration.config) }
}

/** The META token the home page carries while connected (public payload). */
export async function readSearchConsoleVerificationToken(
	organizationId: string,
): Promise<string | null> {
	const loaded = await loadSearchConsoleIntegration(organizationId)
	return loaded?.config.verificationToken ?? null
}

async function saveConfig(integrationId: string, config: SearchConsoleConfig) {
	await db
		.update(Integration)
		.set({ config: JSON.stringify(config), updatedAt: new Date() })
		.where(eq(Integration.id, integrationId))
}

type SiteOrganization = {
	id: string
	slug: string
	customDomain: string | null
	customDomainStatus: string | null
}

/**
 * The property URL: the custom domain once it is live, otherwise the Menuza
 * subdomain. With a trailing slash, as Search Console URL-prefix properties
 * are written.
 */
export function primarySiteUrl(organization: SiteOrganization): string {
	const origin = resolveSitesOrigin({
		slug: organization.slug,
		customDomain:
			organization.customDomain && organization.customDomainStatus === 'active'
				? organization.customDomain
				: null,
		baseUrl: ENV.BASE_URL ?? '',
		hostSuffixes: (ENV as { PUBLIC_SITE_HOST_SUFFIXES?: string })
			.PUBLIC_SITE_HOST_SUFFIXES,
	})
	return `${origin.replace(/\/$/, '')}/`
}

export type SetupResult =
	| { ok: true; config: SearchConsoleConfig }
	| { ok: false; error: SearchConsoleErrorCode; config: SearchConsoleConfig }

/**
 * Adds and verifies the property and submits the sitemap. Safe to repeat:
 * a ready property on the same host is left alone; a new primary host gets a
 * new token, a new property and the sitemap again.
 */
export async function setupSearchConsole(
	organization: SiteOrganization,
	options: { now?: Date } = {},
): Promise<SetupResult> {
	const loaded = await loadSearchConsoleIntegration(organization.id)
	if (!loaded) return { ok: false, error: 'gsc_not_connected', config: {} }
	const now = options.now ?? new Date()
	const siteUrl = primarySiteUrl(organization)
	let config: SearchConsoleConfig = { ...loaded.config }
	if (config.siteUrl === siteUrl && config.status === 'ready') {
		return { ok: true, config }
	}
	if (config.siteUrl !== siteUrl) {
		config = { siteUrl, status: 'verifying' }
	}
	try {
		const client = await clientFor(loaded.integration)
		if (!config.verificationToken) {
			config.verificationToken = await client.getVerificationToken(siteUrl)
			config.status = 'verifying'
			await saveConfig(loaded.integration.id, config)
			// The token goes on the home page through the public site payload.
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
		}
		await client.addSite(siteUrl)
		await client.verifySite(siteUrl)
		config.verifiedAt = now.toISOString()
		await client.submitSitemap(siteUrl, `${siteUrl}sitemap.xml`)
		config.sitemapSubmittedAt = now.toISOString()
		config.status = 'ready'
		config.error = null
		await saveConfig(loaded.integration.id, config)
		return { ok: true, config }
	} catch (error) {
		const code =
			error instanceof SearchConsoleError ? error.code : 'gsc_api_error'
		config.status = code === 'gsc_verification_failed' ? 'verifying' : 'error'
		config.error = code
		await saveConfig(loaded.integration.id, config)
		return { ok: false, error: code, config }
	}
}

function isoDate(date: Date) {
	return date.toISOString().slice(0, 10)
}

/** The 28 days the screen shows, ending two days ago (Search Console lag). */
export function searchConsoleRange(now: Date) {
	const end = new Date(now.getTime() - SEARCH_CONSOLE_LAG_DAYS * 86_400_000)
	const start = new Date(end.getTime() - (SEARCH_CONSOLE_DAYS - 1) * 86_400_000)
	return { startDate: isoDate(start), endDate: isoDate(end) }
}

/**
 * The daily fetch: finish or redo the setup when needed, then store 28 days
 * of totals, the top queries and pages, and the sitemap's status.
 */
export async function syncSearchConsole(
	organization: SiteOrganization,
	now = new Date(),
): Promise<{ ok: boolean; error?: SearchConsoleErrorCode }> {
	const setup = await setupSearchConsole(organization, { now })
	if (!setup.ok) return { ok: false, error: setup.error }
	const loaded = await loadSearchConsoleIntegration(organization.id)
	if (!loaded) return { ok: false, error: 'gsc_not_connected' }
	const siteUrl = setup.config.siteUrl!
	try {
		const client = await clientFor(loaded.integration)
		const range = searchConsoleRange(now)
		const [days, queries, pages, sitemap] = await Promise.all([
			client.query(siteUrl, { ...range, dimensions: ['date'], rowLimit: 100 }),
			client.query(siteUrl, {
				...range,
				dimensions: ['query'],
				rowLimit: TOP_ROWS,
			}),
			client.query(siteUrl, {
				...range,
				dimensions: ['page'],
				rowLimit: TOP_ROWS,
			}),
			client.getSitemap(siteUrl, `${siteUrl}sitemap.xml`),
		])
		const statements = []
		for (const row of days) {
			const date = row.keys[0]
			if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
			statements.push(
				db
					.insert(SearchConsoleDaily)
					.values({
						organizationId: organization.id,
						date,
						clicks: Math.round(row.clicks),
						impressions: Math.round(row.impressions),
						position: row.position,
					})
					.onConflictDoUpdate({
						target: [
							SearchConsoleDaily.organizationId,
							SearchConsoleDaily.date,
						],
						set: {
							clicks: Math.round(row.clicks),
							impressions: Math.round(row.impressions),
							position: row.position,
						},
					}),
			)
		}
		statements.push(
			db
				.delete(SearchConsoleTop)
				.where(eq(SearchConsoleTop.organizationId, organization.id)),
		)
		const fetchedAt = now
		for (const [kind, rows] of [
			['query', queries],
			['page', pages],
		] as const) {
			for (const row of rows.slice(0, TOP_ROWS)) {
				const value = row.keys[0]?.slice(0, 500)
				if (!value) continue
				statements.push(
					db.insert(SearchConsoleTop).values({
						organizationId: organization.id,
						kind,
						value,
						clicks: Math.round(row.clicks),
						impressions: Math.round(row.impressions),
						position: row.position,
						fetchedAt,
					}),
				)
			}
		}
		const [first, ...rest] = statements
		if (first) await db.batch([first, ...rest])
		await saveConfig(loaded.integration.id, {
			...setup.config,
			sitemap,
			lastSyncAt: now.toISOString(),
		})
		return { ok: true }
	} catch (error) {
		return {
			ok: false,
			error: error instanceof SearchConsoleError ? error.code : 'gsc_api_error',
		}
	}
}

export type SearchConsoleSummary = {
	connected: boolean
	config: SearchConsoleConfig
	range: { startDate: string; endDate: string }
	totals: { clicks: number; impressions: number; position: number | null }
	daily: Array<{ date: string; clicks: number; impressions: number }>
	topQueries: Array<{
		value: string
		clicks: number
		impressions: number
		position: number | null
	}>
	topPages: Array<{
		value: string
		clicks: number
		impressions: number
		position: number | null
	}>
	/** Problems Search Console reports, as short codes the screen words. */
	warnings: Array<
		| 'sitemap_errors'
		| 'sitemap_warnings'
		| 'pages_not_indexed'
		| SearchConsoleErrorCode
	>
}

/** What Website, SEO shows: 28-day totals, top queries and pages, warnings. */
export async function readSearchConsoleSummary(
	organizationId: string,
	now = new Date(),
): Promise<SearchConsoleSummary> {
	const loaded = await loadSearchConsoleIntegration(organizationId)
	const range = searchConsoleRange(now)
	const config = loaded?.config ?? {}
	const [daily, top] = await Promise.all([
		db
			.select({
				date: SearchConsoleDaily.date,
				clicks: SearchConsoleDaily.clicks,
				impressions: SearchConsoleDaily.impressions,
				position: SearchConsoleDaily.position,
			})
			.from(SearchConsoleDaily)
			.where(
				and(
					eq(SearchConsoleDaily.organizationId, organizationId),
					gte(SearchConsoleDaily.date, range.startDate),
				),
			)
			.orderBy(SearchConsoleDaily.date),
		db
			.select({
				kind: SearchConsoleTop.kind,
				value: SearchConsoleTop.value,
				clicks: SearchConsoleTop.clicks,
				impressions: SearchConsoleTop.impressions,
				position: SearchConsoleTop.position,
			})
			.from(SearchConsoleTop)
			.where(eq(SearchConsoleTop.organizationId, organizationId))
			.orderBy(desc(SearchConsoleTop.clicks)),
	])
	const inRange = daily.filter((row) => row.date <= range.endDate)
	const clicks = inRange.reduce((n, row) => n + row.clicks, 0)
	const impressions = inRange.reduce((n, row) => n + row.impressions, 0)
	const weighted = inRange.reduce(
		(n, row) => n + (row.position ?? 0) * row.impressions,
		0,
	)
	const warnings: SearchConsoleSummary['warnings'] = []
	if (config.error) warnings.push(config.error)
	if (config.sitemap?.errors) warnings.push('sitemap_errors')
	if (config.sitemap?.warnings) warnings.push('sitemap_warnings')
	if (
		config.sitemap &&
		config.sitemap.submitted > 0 &&
		config.sitemap.indexed < config.sitemap.submitted
	) {
		warnings.push('pages_not_indexed')
	}
	const strip = ({ kind: _kind, ...row }: (typeof top)[number]) => row
	return {
		connected: Boolean(loaded),
		config,
		range,
		totals: {
			clicks,
			impressions,
			position: impressions
				? Math.round((weighted / impressions) * 10) / 10
				: null,
		},
		daily: inRange.map(({ date, clicks, impressions }) => ({
			date,
			clicks,
			impressions,
		})),
		topQueries: top.filter((row) => row.kind === 'query').map(strip),
		topPages: top.filter((row) => row.kind === 'page').map(strip),
		warnings,
	}
}

/** Organizations the daily job looks at: connected ones. Flag checked per org. */
export async function organizationsWithSearchConsole() {
	return db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			customDomain: Organization.customDomain,
			customDomainStatus: Organization.customDomainStatus,
		})
		.from(Integration)
		.innerJoin(Organization, eq(Organization.id, Integration.organizationId))
		.where(
			and(
				eq(Integration.providerName, SEARCH_CONSOLE_PROVIDER),
				eq(Integration.isActive, true),
				eq(Organization.active, true),
			),
		)
}
