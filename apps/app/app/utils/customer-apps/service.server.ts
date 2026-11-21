import { randomUUID } from 'node:crypto'
import { getBrandDomain, getLocalDomain } from '@repo/config/brand'
import { resolveEmailTheme } from '@repo/common/email-theme'
import {
	type AccountSnapshot,
	androidPackageSchema,
	buildCustomerAppConfig,
	canBuildApp,
	canDeleteApp,
	type BuildOutcome,
	type CustomerAppBuildStatus,
	type CustomerAppPlatform,
	type CustomerAppPublisher,
	type CustomerAppStore,
	CUSTOMER_APP_PLATFORMS,
	CUSTOMER_APP_STORES,
	DISPLAY_NAME_MAX,
	iosBundleIdSchema,
	identifiersLocked,
	inviteSettingsSchema,
	liveStores,
	readStoreUrls,
	releaseSchema,
	storeUrlsSchema,
	summarizeRelease,
	marketingVersionSchema,
	displayNameSchema,
	customerAppSlugSchema,
	customerAppBuildCallbackToken,
	iconBackgroundSchema,
	APPLE_TEAM_ID,
	ANDROID_SHA256,
} from '@repo/common/customer-app'
import {
	and,
	CustomerApp,
	CustomerAppBuild,
	CustomerAppStoreHealth,
	CustomerAppStoreReview,
	CustomerAppTap,
	db,
	eq,
	inArray,
	Organization,
	sql,
} from '@repo/database'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { resolveSitesOrigin } from '#app/utils/sites/sites-origin.server.ts'
import { getCustomerAppAdapters } from './adapters.select.server.ts'
import { StoreUnreachableError } from './adapters.server.ts'
import { getUsableCustomerAppPipelineToken } from './pipeline-auth.server.ts'

/**
 * The branded customer app registry (#156): create from the organization's
 * published branding, edit, archive or delete, start builds one by one or as a
 * release, apply build status callbacks, read store health on a schedule, and
 * record the store account facts. Admin calls this through the App's internal
 * command route; everything here is control plane and holds no guest data.
 */

export type ServiceFailure = { ok: false; code: string; message: string }
export type ServiceResult<T> = ({ ok: true } & T) | ServiceFailure

const fail = (code: string, message: string): ServiceFailure => ({
	ok: false,
	code,
	message,
})

type AppRow = typeof CustomerApp.$inferSelect
type OrganizationRow = typeof Organization.$inferSelect

function reverseDomain(domain: string): string {
	return domain.split('.').filter(Boolean).reverse().join('.')
}

function compact(slug: string): string {
	return slug.replace(/[^a-z0-9]/g, '')
}

/** The site's own address, with and without the scheme (the `site` binding). */
export function organizationSiteAddress(
	organization: Pick<
		OrganizationRow,
		'slug' | 'customDomain' | 'customDomainStatus'
	>,
) {
	const origin = resolveSitesOrigin({
		slug: organization.slug,
		customDomain:
			organization.customDomain && organization.customDomainStatus === 'active'
				? organization.customDomain
				: null,
		baseUrl: readLiveEnv('BASE_URL'),
		hostSuffixes: readLiveEnv('PUBLIC_SITE_HOST_SUFFIXES'),
	}).replace(/\/$/, '')
	return { origin, host: new URL(origin).host }
}

/** Defaults taken from the published site: name, id suggestions, icon background. */
export function prefillFromOrganization(organization: OrganizationRow) {
	const slug = organization.slug
	const domain = reverseDomain(getBrandDomain())
	const theme = resolveEmailTheme({ siteTheme: organization.siteTheme })
	return {
		slug,
		displayName: organization.name.trim().slice(0, DISPLAY_NAME_MAX),
		iosBundleId: `${domain}.${compact(slug) || 'app'}`,
		androidPackage: `${domain}.${slug.replace(/[^a-z0-9]/g, '_').replace(/^[^a-z]+/, 'a') || 'app'}`,
		iconBackground: /^#[0-9a-fA-F]{6}$/.test(theme.primary)
			? theme.primary.toUpperCase()
			: '#0F172A',
		site: organizationSiteAddress(organization),
		siteIconKey: organization.siteIconKey,
	}
}

export type CreateAppInput = {
	organizationId: string
	actorId: string | null
	displayName?: string
	iosBundleId?: string
	androidPackage?: string
	slug?: string
	iconBackground?: string
	publisher?: CustomerAppPublisher
	listingText?: { subtitle?: string; description?: string }
}

async function bundleConflict(
	iosBundleId: string,
	androidPackage: string,
	slug: string,
	ignoreAppId?: string,
): Promise<ServiceFailure | null> {
	const rows = await db
		.select({
			id: CustomerApp.id,
			iosBundleId: CustomerApp.iosBundleId,
			androidPackage: CustomerApp.androidPackage,
			slug: CustomerApp.slug,
		})
		.from(CustomerApp)
		.where(
			sql`${CustomerApp.iosBundleId} = ${iosBundleId} OR ${CustomerApp.androidPackage} = ${androidPackage} OR ${CustomerApp.slug} = ${slug}`,
		)
	for (const row of rows) {
		if (row.id === ignoreAppId) continue
		if (row.iosBundleId === iosBundleId)
			return fail(
				'bundle_id_taken',
				'This iOS bundle id is already used by another app.',
			)
		if (row.androidPackage === androidPackage)
			return fail(
				'package_taken',
				'This Android package is already used by another app.',
			)
		if (row.slug === slug)
			return fail('slug_taken', 'This app slug is already used by another app.')
	}
	return null
}

export async function createCustomerApp(
	input: CreateAppInput,
): Promise<ServiceResult<{ appId: string }>> {
	const [organization] = await db
		.select()
		.from(Organization)
		.where(eq(Organization.id, input.organizationId))
		.limit(1)
	if (!organization)
		return fail('organization_not_found', 'Organization not found.')
	if (!organization.sitePublished) {
		return fail(
			'site_not_published',
			'Publish the organization’s website first: the app takes its branding and site binding from it.',
		)
	}
	const [existing] = await db
		.select({ id: CustomerApp.id })
		.from(CustomerApp)
		.where(eq(CustomerApp.organizationId, organization.id))
		.limit(1)
	if (existing)
		return fail('app_exists', 'This organization already has an app.')

	const defaults = prefillFromOrganization(organization)
	const parsed = {
		displayName: displayNameSchema.safeParse(
			input.displayName ?? defaults.displayName,
		),
		iosBundleId: iosBundleIdSchema.safeParse(
			input.iosBundleId ?? defaults.iosBundleId,
		),
		androidPackage: androidPackageSchema.safeParse(
			input.androidPackage ?? defaults.androidPackage,
		),
		slug: customerAppSlugSchema.safeParse(input.slug ?? defaults.slug),
		iconBackground: iconBackgroundSchema.safeParse(
			input.iconBackground ?? defaults.iconBackground,
		),
	}
	for (const [field, result] of Object.entries(parsed)) {
		if (!result.success) {
			return fail(
				'invalid',
				`${field}: ${result.error.issues[0]?.message ?? 'invalid'}`,
			)
		}
	}
	const values = {
		displayName: parsed.displayName.data!,
		iosBundleId: parsed.iosBundleId.data!,
		androidPackage: parsed.androidPackage.data!,
		slug: parsed.slug.data!,
		iconBackground: parsed.iconBackground.data!,
	}
	const conflict = await bundleConflict(
		values.iosBundleId,
		values.androidPackage,
		values.slug,
	)
	if (conflict) return conflict

	const appId = randomUUID()
	try {
		await db.insert(CustomerApp).values({
			id: appId,
			organizationId: organization.id,
			...values,
			publisher: input.publisher ?? 'menuza',
			listingText: input.listingText ? JSON.stringify(input.listingText) : null,
			createdById: input.actorId,
		})
	} catch {
		// A concurrent create hit the unique indexes.
		return fail('bundle_id_taken', 'These ids are already used by another app.')
	}
	return { ok: true, appId }
}

export type UpdateAppInput = {
	appId: string
	displayName?: string
	iosBundleId?: string
	androidPackage?: string
	marketingVersion?: string
	iconBackground?: string
	publisher?: CustomerAppPublisher
	appleTeamId?: string | null
	androidSha256?: string[]
	listingText?: { subtitle?: string; description?: string }
	storeUrls?: Partial<Record<CustomerAppStore, string | null>>
}

export async function updateCustomerApp(
	input: UpdateAppInput,
): Promise<ServiceResult<{ appId: string }>> {
	const [app] = await db
		.select()
		.from(CustomerApp)
		.where(eq(CustomerApp.id, input.appId))
		.limit(1)
	if (!app) return fail('not_found', 'App not found.')

	const set: Partial<typeof CustomerApp.$inferInsert> = {}
	const locked = identifiersLocked(app)
	if (
		input.iosBundleId !== undefined &&
		input.iosBundleId !== app.iosBundleId
	) {
		if (locked)
			return fail(
				'identifiers_locked',
				'Bundle ids cannot change after the app was published.',
			)
		const parsed = iosBundleIdSchema.safeParse(input.iosBundleId)
		if (!parsed.success)
			return fail('invalid', `iosBundleId: ${parsed.error.issues[0]?.message}`)
		set.iosBundleId = parsed.data
	}
	if (
		input.androidPackage !== undefined &&
		input.androidPackage !== app.androidPackage
	) {
		if (locked)
			return fail(
				'identifiers_locked',
				'Bundle ids cannot change after the app was published.',
			)
		const parsed = androidPackageSchema.safeParse(input.androidPackage)
		if (!parsed.success)
			return fail(
				'invalid',
				`androidPackage: ${parsed.error.issues[0]?.message}`,
			)
		set.androidPackage = parsed.data
	}
	if (set.iosBundleId || set.androidPackage) {
		const conflict = await bundleConflict(
			set.iosBundleId ?? app.iosBundleId,
			set.androidPackage ?? app.androidPackage,
			app.slug,
			app.id,
		)
		if (conflict) return conflict
	}
	if (input.displayName !== undefined) {
		const parsed = displayNameSchema.safeParse(input.displayName)
		if (!parsed.success)
			return fail('invalid', 'displayName: 1 to 30 characters.')
		set.displayName = parsed.data
	}
	if (input.marketingVersion !== undefined) {
		const parsed = marketingVersionSchema.safeParse(input.marketingVersion)
		if (!parsed.success) return fail('invalid', 'marketingVersion: use 1.2.0.')
		set.marketingVersion = parsed.data
	}
	if (input.iconBackground !== undefined) {
		const parsed = iconBackgroundSchema.safeParse(input.iconBackground)
		if (!parsed.success) return fail('invalid', 'iconBackground: use #RRGGBB.')
		set.iconBackground = parsed.data
	}
	if (input.publisher !== undefined) set.publisher = input.publisher
	if (input.appleTeamId !== undefined) {
		if (input.appleTeamId !== null && !APPLE_TEAM_ID.test(input.appleTeamId))
			return fail('invalid', 'appleTeamId: 10 uppercase letters or digits.')
		set.appleTeamId = input.appleTeamId
	}
	if (input.androidSha256 !== undefined) {
		const normalized = input.androidSha256.map((v) => v.trim().toUpperCase())
		if (normalized.some((v) => !ANDROID_SHA256.test(v)))
			return fail('invalid', 'androidSha256: use AA:BB:… fingerprints.')
		set.androidSha256 = JSON.stringify(normalized)
	}
	if (input.listingText !== undefined) {
		set.listingText = JSON.stringify({
			subtitle: (input.listingText.subtitle ?? '').slice(0, 80),
			description: (input.listingText.description ?? '').slice(0, 4_000),
		})
	}
	if (input.storeUrls !== undefined) {
		const merged: Record<string, string | null | undefined> = {
			...readStoreUrls(app.storeUrls),
			...input.storeUrls,
		}
		const parsed = storeUrlsSchema.safeParse(merged)
		if (!parsed.success)
			return fail('invalid_store_url', 'Not a valid store link.')
		set.storeUrls = JSON.stringify(parsed.data)
	}
	if (Object.keys(set).length > 0) {
		await db.update(CustomerApp).set(set).where(eq(CustomerApp.id, app.id))
		await purgeOrganizationSiteCache(app.organizationId).catch(() => {})
	}
	return { ok: true, appId: app.id }
}

/** Deleting is allowed only before the first publish; afterwards the app is archived. */
export async function deleteCustomerApp(
	appId: string,
): Promise<ServiceResult<{ archived: boolean }>> {
	const [app] = await db
		.select()
		.from(CustomerApp)
		.where(eq(CustomerApp.id, appId))
		.limit(1)
	if (!app) return fail('not_found', 'App not found.')
	if (!canDeleteApp(app)) {
		return fail(
			'already_published',
			'This app was published, so it cannot be deleted. Archive it instead.',
		)
	}
	await db.delete(CustomerApp).where(eq(CustomerApp.id, appId))
	await purgeOrganizationSiteCache(app.organizationId).catch(() => {})
	return { ok: true, archived: false }
}

export async function archiveCustomerApp(
	appId: string,
	archived: boolean,
): Promise<ServiceResult<{ appId: string }>> {
	const [app] = await db
		.select({ id: CustomerApp.id, organizationId: CustomerApp.organizationId })
		.from(CustomerApp)
		.where(eq(CustomerApp.id, appId))
		.limit(1)
	if (!app) return fail('not_found', 'App not found.')
	await db
		.update(CustomerApp)
		.set(
			archived
				? { status: 'archived', archivedAt: new Date() }
				: { status: 'draft', archivedAt: null },
		)
		.where(eq(CustomerApp.id, appId))
	// A restored app that was live goes back to published on the next health read.
	await purgeOrganizationSiteCache(app.organizationId).catch(() => {})
	return { ok: true, appId }
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

function internalBase(): string {
	return readLiveEnv('BASE_URL').replace(/\/$/, '')
}

async function dispatchBuild(
	app: AppRow,
	build: typeof CustomerAppBuild.$inferSelect,
): Promise<{ ok: true } | ServiceFailure> {
	try {
		const pipelineToken = getUsableCustomerAppPipelineToken()
		const callbackAuthorization = pipelineToken
			? `Bearer ${customerAppBuildCallbackToken(build.id, pipelineToken)}`
			: null
		const started = await getCustomerAppAdapters().build.start({
			appId: app.id,
			buildId: build.id,
			slug: app.slug,
			release: build.release,
			platform: build.platform,
			configUrl: `${internalBase()}/resources/customer-app/config?slug=${encodeURIComponent(app.slug)}`,
			callbackUrl: `${internalBase()}/resources/customer-app/build-callback`,
			callbackAuthorization,
		})
		await db
			.update(CustomerAppBuild)
			.set({
				externalBuildId: started.externalBuildId,
				logUrl: started.logUrl,
				status: 'queued',
				error: null,
			})
			.where(eq(CustomerAppBuild.id, build.id))
		return { ok: true }
	} catch (error) {
		const reason =
			error instanceof Error && /^[a-z0-9_]{1,60}$/.test(error.message)
				? error.message
				: 'pipeline_unreachable'
		await db
			.update(CustomerAppBuild)
			.set({ status: 'failed', error: reason, finishedAt: new Date() })
			.where(eq(CustomerAppBuild.id, build.id))
		return fail(reason, 'The build pipeline did not accept this build.')
	}
}

/** One app, one release, both platforms by default. Retries reuse the row. */
export async function startAppBuild(input: {
	appId: string
	release: string
	platforms?: CustomerAppPlatform[]
	actorId: string | null
}): Promise<ServiceResult<{ buildIds: string[] }>> {
	const release = releaseSchema.safeParse(input.release)
	if (!release.success)
		return fail('invalid_release', 'Use a release name such as 1.2.0-1.')
	const [app] = await db
		.select()
		.from(CustomerApp)
		.where(eq(CustomerApp.id, input.appId))
		.limit(1)
	if (!app) return fail('not_found', 'App not found.')
	if (!canBuildApp(app))
		return fail('archived', 'Archived apps cannot be built.')
	const [organization] = await db
		.select({ dataRegion: Organization.dataRegion })
		.from(Organization)
		.where(eq(Organization.id, app.organizationId))
		.limit(1)
	const platforms = input.platforms?.length
		? input.platforms
		: [...CUSTOMER_APP_PLATFORMS]

	const buildIds: string[] = []
	let failure: ServiceFailure | null = null
	for (const platform of platforms) {
		const [existing] = await db
			.select()
			.from(CustomerAppBuild)
			.where(
				and(
					eq(CustomerAppBuild.appId, app.id),
					eq(CustomerAppBuild.release, release.data),
					eq(CustomerAppBuild.platform, platform),
				),
			)
			.limit(1)
		if (
			existing &&
			(existing.status === 'queued' || existing.status === 'running')
		) {
			buildIds.push(existing.id)
			continue
		}
		if (existing && existing.status === 'succeeded') {
			buildIds.push(existing.id)
			continue
		}
		let build = existing
		if (build) {
			await db
				.update(CustomerAppBuild)
				.set({
					status: 'queued',
					attempts: build.attempts + 1,
					error: null,
					finishedAt: null,
					dataRegion: organization?.dataRegion ?? 'us',
					startedById: input.actorId,
				})
				.where(eq(CustomerAppBuild.id, build.id))
			build = { ...build, status: 'queued' }
		} else {
			const id = randomUUID()
			await db.insert(CustomerAppBuild).values({
				id,
				appId: app.id,
				release: release.data,
				platform,
				status: 'queued',
				dataRegion: organization?.dataRegion ?? 'us',
				startedById: input.actorId,
			})
			const [created] = await db
				.select()
				.from(CustomerAppBuild)
				.where(eq(CustomerAppBuild.id, id))
				.limit(1)
			build = created!
		}
		buildIds.push(build.id)
		const dispatched = await dispatchBuild(app, build)
		if (!dispatched.ok) failure = dispatched
	}
	if (failure) return failure
	return { ok: true, buildIds }
}

/**
 * A release across many apps. Every app is built on its own: one failure does
 * not stop the others, and the report says which apps failed so each is
 * retried by itself with `startAppBuild`.
 */
export async function startRelease(input: {
	appIds: string[]
	release: string
	actorId: string | null
}) {
	const outcomes: BuildOutcome[] = []
	for (const appId of [...new Set(input.appIds)]) {
		try {
			const result = await startAppBuild({
				appId,
				release: input.release,
				actorId: input.actorId,
			})
			outcomes.push(
				result.ok
					? { appId, ok: true, buildIds: result.buildIds }
					: { appId, ok: false, code: result.code, message: result.message },
			)
		} catch {
			outcomes.push({
				appId,
				ok: false,
				code: 'unexpected',
				message: 'This build could not be started.',
			})
		}
	}
	return { outcomes, summary: summarizeRelease(outcomes) }
}

/** Retry only the failed builds of a release, each app on its own. */
export async function retryFailedBuilds(input: {
	release: string
	appIds?: string[]
	actorId: string | null
}) {
	const failed = await db
		.select({
			appId: CustomerAppBuild.appId,
			platform: CustomerAppBuild.platform,
		})
		.from(CustomerAppBuild)
		.where(
			and(
				eq(CustomerAppBuild.release, input.release),
				inArray(CustomerAppBuild.status, ['failed', 'cancelled']),
			),
		)
	const byApp = new Map<string, CustomerAppPlatform[]>()
	for (const row of failed) {
		if (input.appIds && !input.appIds.includes(row.appId)) continue
		byApp.set(row.appId, [...(byApp.get(row.appId) ?? []), row.platform])
	}
	const outcomes: BuildOutcome[] = []
	for (const [appId, platforms] of byApp) {
		try {
			const result = await startAppBuild({
				appId,
				release: input.release,
				platforms,
				actorId: input.actorId,
			})
			outcomes.push(
				result.ok
					? { appId, ok: true, buildIds: result.buildIds }
					: { appId, ok: false, code: result.code, message: result.message },
			)
		} catch {
			outcomes.push({
				appId,
				ok: false,
				code: 'unexpected',
				message: 'This build could not be started.',
			})
		}
	}
	return { outcomes, summary: summarizeRelease(outcomes) }
}

const STATUS_RANK: Record<CustomerAppBuildStatus, number> = {
	queued: 0,
	running: 1,
	succeeded: 2,
	failed: 2,
	cancelled: 2,
}

/** Status callback from the pipeline. Never moves a finished build back. */
export async function applyBuildCallback(input: {
	buildId: string
	status: CustomerAppBuildStatus
	externalBuildId?: string | null
	logUrl?: string | null
	error?: string | null
}): Promise<ServiceResult<{ status: CustomerAppBuildStatus }>> {
	const [build] = await db
		.select()
		.from(CustomerAppBuild)
		.where(eq(CustomerAppBuild.id, input.buildId))
		.limit(1)
	if (!build) return fail('not_found', 'Build not found.')
	if (STATUS_RANK[build.status] === 2 && build.status !== input.status) {
		return { ok: true, status: build.status }
	}
	if (STATUS_RANK[input.status] < STATUS_RANK[build.status]) {
		return { ok: true, status: build.status }
	}
	const finished = STATUS_RANK[input.status] === 2
	await db
		.update(CustomerAppBuild)
		.set({
			status: input.status,
			externalBuildId: input.externalBuildId ?? build.externalBuildId,
			logUrl: safeLogUrl(input.logUrl) ?? build.logUrl,
			error:
				input.status === 'failed'
					? (input.error ?? 'build_failed').slice(0, 60)
					: null,
			finishedAt: finished ? new Date() : null,
		})
		.where(eq(CustomerAppBuild.id, build.id))
	return { ok: true, status: input.status }
}

function safeLogUrl(raw: string | null | undefined): string | null {
	if (!raw) return null
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return null
	}
	if (url.protocol !== 'https:') return null
	const host = url.hostname.toLowerCase()
	if (host === 'expo.dev' || host.endsWith('.expo.dev')) return url.toString()
	if (host !== 'github.com') return null
	const repo = readLiveEnv('CUSTOMER_APP_BUILD_REPO')
	if (/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		const [owner, name] = repo.split('/')
		const prefix = `/${owner}/${name}/`
		if (url.pathname.startsWith(prefix)) return url.toString()
	}
	if (/^\/[\w.-]+\/[\w.-]+\/actions\//.test(url.pathname)) {
		return url.toString()
	}
	return null
}

// ---------------------------------------------------------------------------
// Build config (what `tenants/<slug>.json` held)
// ---------------------------------------------------------------------------

function platformEndpoints() {
	const local = /localhost|127\.0\.0\.1/.test(readLiveEnv('BASE_URL'))
	const base = readLiveEnv('BASE_URL')
	const appUrl = (() => {
		try {
			return new URL(base).host
		} catch {
			return 'localhost:3001'
		}
	})()
	return {
		appUrl,
		brandDomain: local ? getLocalDomain() : getBrandDomain(),
		tenantApiUs: stripScheme(readLiveEnv('TENANT_API_URL')) || 'localhost:3007',
		tenantApiKsa:
			stripScheme(readLiveEnv('TENANT_API_URL_KSA')) || 'localhost:3009',
	}
}

function stripScheme(value: string) {
	return value.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** The build config for an app slug, or null. Public branding and endpoints only. */
export async function loadBuildConfig(slug: string) {
	const [app] = await db
		.select()
		.from(CustomerApp)
		.where(eq(CustomerApp.slug, slug))
		.limit(1)
	if (!app || app.status === 'archived') return null
	const [organization] = await db
		.select()
		.from(Organization)
		.where(eq(Organization.id, app.organizationId))
		.limit(1)
	if (!organization) return null
	const site = organizationSiteAddress(organization)
	const config = buildCustomerAppConfig(
		{
			slug: app.slug,
			displayName: app.displayName,
			iosBundleId: app.iosBundleId,
			androidPackage: app.androidPackage,
			marketingVersion: app.marketingVersion,
			iconBackground: app.iconBackground,
			appleTeamId: app.appleTeamId,
			androidSha256: parseJsonArray(app.androidSha256),
			status: app.status,
		},
		{
			slug: organization.slug,
			dataRegion: organization.dataRegion,
			siteHost: site.host,
			siteOrigin: site.origin,
			iconUrl: organization.siteIconKey
				? `${internalBase()}/resources/images?objectKey=${encodeURIComponent(organization.siteIconKey)}`
				: null,
		},
		platformEndpoints(),
	)
	return config
}

function parseJsonArray(raw: string | null): string[] {
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === 'string')
			: []
	} catch {
		return []
	}
}

// ---------------------------------------------------------------------------
// Store health
// ---------------------------------------------------------------------------

/** Stores are read at most once a day per app. */
export const STORE_HEALTH_INTERVAL_MS = 23 * 60 * 60 * 1000

/**
 * Reads one app's stores and keeps the last known state when a store cannot be
 * reached. The first time a store reports live, the app is marked published,
 * which locks its bundle ids.
 */
export async function refreshStoreHealth(
	appId: string,
	options: { now?: number; force?: boolean } = {},
): Promise<ServiceResult<{ checked: number; skipped: boolean }>> {
	const now = options.now ?? Date.now()
	const [app] = await db
		.select()
		.from(CustomerApp)
		.where(eq(CustomerApp.id, appId))
		.limit(1)
	if (!app) return fail('not_found', 'App not found.')
	if (app.status === 'archived') return { ok: true, checked: 0, skipped: true }

	const existing = await db
		.select()
		.from(CustomerAppStoreHealth)
		.where(eq(CustomerAppStoreHealth.appId, appId))
	if (!options.force) {
		const recent = existing.some(
			(row) =>
				row.lastCheckedAt &&
				now - row.lastCheckedAt.getTime() < STORE_HEALTH_INTERVAL_MS,
		)
		if (recent) return { ok: true, checked: 0, skipped: true }
	}

	const adapters = getCustomerAppAdapters()
	const lookup = {
		iosBundleId: app.iosBundleId,
		androidPackage: app.androidPackage,
		storeUrls: readStoreUrls(app.storeUrls),
	}
	let checked = 0
	let becameLive = false
	for (const store of CUSTOMER_APP_STORES) {
		const checkedAt = new Date(now)
		try {
			const snapshot = await adapters.store.fetch(lookup, store)
			checked += 1
			await db
				.insert(CustomerAppStoreHealth)
				.values({
					appId,
					store,
					status: snapshot.status,
					version: snapshot.version,
					ratingX100: snapshot.ratingX100,
					ratingCount: snapshot.ratingCount,
					lastCheckedAt: checkedAt,
					lastSuccessAt: checkedAt,
					lastError: null,
				})
				.onConflictDoUpdate({
					target: [CustomerAppStoreHealth.appId, CustomerAppStoreHealth.store],
					set: {
						status: snapshot.status,
						version: snapshot.version,
						ratingX100: snapshot.ratingX100,
						ratingCount: snapshot.ratingCount,
						lastCheckedAt: checkedAt,
						lastSuccessAt: checkedAt,
						lastError: null,
					},
				})
			if (snapshot.status === 'live') becameLive = true
			for (const review of snapshot.reviews) {
				await db
					.insert(CustomerAppStoreReview)
					.values({
						id: randomUUID(),
						appId,
						store,
						externalId: review.externalId,
						rating: review.rating,
						title: review.title,
						body: review.body,
						appVersion: review.appVersion,
						reviewedAt: new Date(review.reviewedAt),
					})
					.onConflictDoNothing()
			}
		} catch (error) {
			// Unreachable: keep the last known state, say when we last tried.
			const code =
				error instanceof StoreUnreachableError ? error.code : 'unreachable'
			await db
				.insert(CustomerAppStoreHealth)
				.values({
					appId,
					store,
					status: 'unknown',
					lastCheckedAt: checkedAt,
					lastError: code,
				})
				.onConflictDoUpdate({
					target: [CustomerAppStoreHealth.appId, CustomerAppStoreHealth.store],
					set: { lastCheckedAt: checkedAt, lastError: code },
				})
		}
	}

	// Account facts, when the adapter can read them (staff record them otherwise).
	try {
		const snapshot = await adapters.account.snapshot({
			id: app.id,
			iosBundleId: app.iosBundleId,
			publisher: app.publisher,
		})
		if (snapshot) await saveAccountSnapshot(app.id, snapshot, now)
	} catch {
		// The last recorded snapshot stays.
	}

	if (becameLive && app.status === 'draft') {
		await db
			.update(CustomerApp)
			.set({ status: 'published', publishedAt: new Date(now) })
			.where(eq(CustomerApp.id, appId))
	}
	await purgeOrganizationSiteCache(app.organizationId).catch(() => {})
	return { ok: true, checked, skipped: false }
}

/** The scheduled job: every app whose last check is older than a day. */
export async function refreshDueStoreHealth(now = Date.now()) {
	const apps = await db
		.select({ id: CustomerApp.id })
		.from(CustomerApp)
		.where(inArray(CustomerApp.status, ['draft', 'published']))
	let checked = 0
	let failed = 0
	for (const { id } of apps) {
		try {
			const result = await refreshStoreHealth(id, { now })
			if (result.ok && !result.skipped) checked += 1
		} catch {
			failed += 1
		}
	}
	return { apps: apps.length, checked, failed }
}

export async function saveAccountSnapshot(
	appId: string,
	snapshot: AccountSnapshot,
	now = Date.now(),
) {
	await db
		.update(CustomerApp)
		.set({
			accountSnapshot: JSON.stringify(snapshot),
			accountCheckedAt: new Date(now),
		})
		.where(eq(CustomerApp.id, appId))
}

// ---------------------------------------------------------------------------
// Invite placements and taps (#196)
// ---------------------------------------------------------------------------

export async function updateInviteSettings(
	appId: string,
	input: unknown,
): Promise<ServiceResult<{ appId: string }>> {
	const parsed = inviteSettingsSchema.safeParse(input)
	if (!parsed.success) return fail('invalid', 'Check the invite settings.')
	const [app] = await db
		.select({ organizationId: CustomerApp.organizationId })
		.from(CustomerApp)
		.where(eq(CustomerApp.id, appId))
		.limit(1)
	if (!app) return fail('not_found', 'App not found.')
	await db
		.update(CustomerApp)
		.set({
			inviteBanner: parsed.data.banner,
			inviteConfirmation: parsed.data.confirmation,
			inviteFooter: parsed.data.footer,
			inviteBannerText: parsed.data.bannerText,
		})
		.where(eq(CustomerApp.id, appId))
	await purgeOrganizationSiteCache(app.organizationId).catch(() => {})
	return { ok: true, appId }
}

export async function recordTap(input: {
	appId: string
	placement: string
	store: string
	now?: number
}) {
	const day = new Date(input.now ?? Date.now()).toISOString().slice(0, 10)
	await db
		.insert(CustomerAppTap)
		.values({
			appId: input.appId,
			placement: input.placement,
			store: input.store,
			day,
			count: 1,
		})
		.onConflictDoUpdate({
			target: [
				CustomerAppTap.appId,
				CustomerAppTap.placement,
				CustomerAppTap.store,
				CustomerAppTap.day,
			],
			set: { count: sql`${CustomerAppTap.count} + 1` },
		})
}

export async function tapTotals(appId: string, sinceDay: string) {
	const rows = await db
		.select({
			placement: CustomerAppTap.placement,
			total: sql<number>`sum(${CustomerAppTap.count})`,
		})
		.from(CustomerAppTap)
		.where(
			and(
				eq(CustomerAppTap.appId, appId),
				sql`${CustomerAppTap.day} >= ${sinceDay}`,
			),
		)
		.groupBy(CustomerAppTap.placement)
	return rows.map((row) => ({
		placement: row.placement,
		total: Number(row.total),
	}))
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Live stores of an organization's app, for public pages and emails. */
export async function loadLiveStores(organizationId: string) {
	const [app] = await db
		.select()
		.from(CustomerApp)
		.where(eq(CustomerApp.organizationId, organizationId))
		.limit(1)
	if (!app) return null
	const health = await db
		.select({
			store: CustomerAppStoreHealth.store,
			status: CustomerAppStoreHealth.status,
		})
		.from(CustomerAppStoreHealth)
		.where(eq(CustomerAppStoreHealth.appId, app.id))
	return {
		app,
		live: liveStores({
			status: app.status,
			storeUrls: readStoreUrls(app.storeUrls),
			health,
		}),
	}
}
