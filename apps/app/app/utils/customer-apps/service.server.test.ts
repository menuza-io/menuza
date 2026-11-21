import {
	and,
	CustomerApp,
	CustomerAppBuild,
	CustomerAppCredential,
	CustomerAppStoreHealth,
	db,
	eq,
	Organization,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	createMockCustomerAppAdapters,
	type MockBuildAdapter,
} from './adapters.mock.server.ts'
import { setCustomerAppAdapters } from './adapters.select.server.ts'
import {
	checkStoredCredential,
	listCredentialStatuses,
	storeCredential,
} from './credentials.server.ts'
import {
	applyBuildCallback,
	archiveCustomerApp,
	createCustomerApp,
	deleteCustomerApp,
	loadBuildConfig,
	loadLiveStores,
	recordTap,
	refreshStoreHealth,
	retryFailedBuilds,
	startAppBuild,
	startRelease,
	tapTotals,
	updateCustomerApp,
} from './service.server.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => {}),
}))

let adapters: ReturnType<typeof createMockCustomerAppAdapters>

async function publishedOrg() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	await db
		.update(Organization)
		.set({ sitePublished: true })
		.where(eq(Organization.id, organization.id))
	return { user, organization }
}

async function newApp(
	overrides: Partial<Parameters<typeof createCustomerApp>[0]> = {},
) {
	const { user, organization } = await publishedOrg()
	const created = await createCustomerApp({
		organizationId: organization.id,
		actorId: user.id,
		...overrides,
	})
	if (!created.ok) throw new Error(created.message)
	return { user, organization, appId: created.appId }
}

beforeEach(() => {
	adapters = createMockCustomerAppAdapters()
	setCustomerAppAdapters(adapters)
})
afterEach(() => setCustomerAppAdapters(null))

describe('create (#156 criterion 1)', () => {
	it('creates an app from the published website without touching the repo', async () => {
		const { appId, organization } = await newApp()
		const [app] = await db
			.select()
			.from(CustomerApp)
			.where(eq(CustomerApp.id, appId))
		expect(app!.slug).toBe(organization.slug)
		expect(app!.displayName.length).toBeLessThanOrEqual(30)
		expect(app!.iosBundleId).toMatch(
			/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/,
		)
		expect(app!.status).toBe('draft')
	})

	it('refuses an organization without a published site', async () => {
		const user = await insertTestUser()
		const organization = await createTestOrganization(user.id)
		const result = await createCustomerApp({
			organizationId: organization.id,
			actorId: user.id,
		})
		expect(result).toMatchObject({ ok: false, code: 'site_not_published' })
	})

	it('keeps bundle ids unique across all apps', async () => {
		const first = await newApp({
			iosBundleId: 'com.acme.one',
			androidPackage: 'com.acme.one',
		})
		const { user, organization } = await publishedOrg()
		const clash = await createCustomerApp({
			organizationId: organization.id,
			actorId: user.id,
			iosBundleId: 'com.acme.one',
		})
		expect(clash).toMatchObject({ ok: false, code: 'bundle_id_taken' })
		const packageClash = await createCustomerApp({
			organizationId: organization.id,
			actorId: user.id,
			androidPackage: 'com.acme.one',
		})
		expect(packageClash).toMatchObject({ ok: false, code: 'package_taken' })
		expect(first.appId).toBeTruthy()
	})

	it('allows one app per organization', async () => {
		const { user, organization } = await newApp()
		expect(
			await createCustomerApp({
				organizationId: organization.id,
				actorId: user.id,
			}),
		).toMatchObject({ ok: false, code: 'app_exists' })
	})
})

describe('lifecycle', () => {
	it('freezes bundle ids once published and refuses delete, archive instead', async () => {
		const { appId } = await newApp({
			iosBundleId: 'com.acme.live',
			androidPackage: 'com.acme.live',
		})
		await updateCustomerApp({
			appId,
			storeUrls: { app_store: 'https://apps.apple.com/us/app/acme/id1' },
		})
		const [app] = await db
			.select()
			.from(CustomerApp)
			.where(eq(CustomerApp.id, appId))
		adapters.store.set(
			{
				iosBundleId: app!.iosBundleId,
				androidPackage: app!.androidPackage,
				storeUrls: {},
			},
			'app_store',
			{ status: 'live', version: '1.0.0' },
		)
		await refreshStoreHealth(appId, { force: true })
		const [published] = await db
			.select()
			.from(CustomerApp)
			.where(eq(CustomerApp.id, appId))
		expect(published!.status).toBe('published')
		expect(published!.publishedAt).not.toBeNull()

		expect(
			await updateCustomerApp({ appId, iosBundleId: 'com.acme.renamed' }),
		).toMatchObject({ ok: false, code: 'identifiers_locked' })
		expect(await deleteCustomerApp(appId)).toMatchObject({
			ok: false,
			code: 'already_published',
		})
		expect(await archiveCustomerApp(appId, true)).toMatchObject({ ok: true })
		const [archived] = await db
			.select()
			.from(CustomerApp)
			.where(eq(CustomerApp.id, appId))
		expect(archived!.status).toBe('archived')
		expect(
			await startAppBuild({ appId, release: '1.0.1-1', actorId: null }),
		).toMatchObject({
			ok: false,
			code: 'archived',
		})
	})

	it('deletes an app that was never published', async () => {
		const { appId } = await newApp()
		expect(await deleteCustomerApp(appId)).toMatchObject({ ok: true })
		const rows = await db
			.select()
			.from(CustomerApp)
			.where(eq(CustomerApp.id, appId))
		expect(rows).toHaveLength(0)
	})

	it('rejects a store link that is not a store', async () => {
		const { appId } = await newApp()
		expect(
			await updateCustomerApp({
				appId,
				storeUrls: { app_store: 'https://evil.example/app' },
			}),
		).toMatchObject({ ok: false, code: 'invalid_store_url' })
	})
})

describe('credentials are write-only (#156 criterion 2)', () => {
	const apns = {
		key: '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----',
		keyId: 'ABC123DEFG',
		teamId: 'TEAM123456',
	}

	it('stores ciphertext, reports only set and date, and never the value', async () => {
		const { appId } = await newApp()
		const result = await storeCredential({
			appId,
			kind: 'apns',
			payload: apns,
			uploadedById: null,
		})
		expect(result.ok).toBe(true)
		const statuses = await listCredentialStatuses(appId)
		expect(statuses).toEqual([
			{ kind: 'apns', set: true, uploadedAt: expect.any(String) },
			{ kind: 'fcm', set: false, uploadedAt: null },
		])
		expect(JSON.stringify(statuses)).not.toContain('PRIVATE KEY')
		const [row] = await db
			.select()
			.from(CustomerAppCredential)
			.where(
				and(
					eq(CustomerAppCredential.appId, appId),
					eq(CustomerAppCredential.kind, 'apns'),
				),
			)
		expect(row!.ciphertext).not.toContain('PRIVATE KEY')
		expect(row!.ciphertext).not.toContain(apns.keyId)
		expect(await checkStoredCredential(appId, 'apns')).toBe(true)
		expect(await checkStoredCredential(appId, 'fcm')).toBe(false)
	})

	it('replaces an upload and refuses junk without echoing it', async () => {
		const { appId } = await newApp()
		await storeCredential({
			appId,
			kind: 'apns',
			payload: apns,
			uploadedById: null,
		})
		const bad = await storeCredential({
			appId,
			kind: 'fcm',
			payload: '{"type":"nope","secret":"sekrit-value"}',
			uploadedById: null,
		})
		expect(bad.ok).toBe(false)
		expect(JSON.stringify(bad)).not.toContain('sekrit-value')
		const rows = await db
			.select()
			.from(CustomerAppCredential)
			.where(eq(CustomerAppCredential.appId, appId))
		expect(rows).toHaveLength(1)
	})
})

describe('builds and releases (#156 criterion 3)', () => {
	it('starts a build for one app and records the job', async () => {
		const { appId } = await newApp()
		const result = await startAppBuild({
			appId,
			release: '1.0.0-1',
			actorId: null,
		})
		expect(result.ok).toBe(true)
		const builds = await db
			.select()
			.from(CustomerAppBuild)
			.where(eq(CustomerAppBuild.appId, appId))
		expect(builds.map((b) => b.platform).sort()).toEqual(['android', 'ios'])
		expect(builds.every((b) => b.status === 'queued')).toBe(true)
		expect(builds[0]!.externalBuildId).toMatch(/^mock-/)
		expect((adapters.build as MockBuildAdapter).started).toHaveLength(2)
	})

	it('reports per app, keeps going after a failure, and retries only the failed app', async () => {
		const a = await newApp()
		const b = await newApp()
		const c = await newApp()
		;(adapters.build as MockBuildAdapter).failFor.add(b.appId)

		const run = await startRelease({
			appIds: [a.appId, b.appId, c.appId],
			release: '2.0.0-1',
			actorId: null,
		})
		expect(run.summary).toMatchObject({
			total: 3,
			succeeded: 2,
			failed: 1,
			failedAppIds: [b.appId],
		})
		expect(run.outcomes.find((o) => o.appId === b.appId)).toMatchObject({
			ok: false,
			code: 'pipeline_refused',
		})

		// The failed app is retried on its own once the pipeline accepts it.
		;(adapters.build as MockBuildAdapter).failFor.clear()
		const startedBefore = (adapters.build as MockBuildAdapter).started.length
		const retry = await retryFailedBuilds({ release: '2.0.0-1', actorId: null })
		expect(retry.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 })
		expect(retry.outcomes[0]!.appId).toBe(b.appId)
		expect(
			(adapters.build as MockBuildAdapter).started.length - startedBefore,
		).toBe(2)
		const rows = await db
			.select()
			.from(CustomerAppBuild)
			.where(
				and(
					eq(CustomerAppBuild.appId, b.appId),
					eq(CustomerAppBuild.release, '2.0.0-1'),
				),
			)
		expect(rows.every((r) => r.attempts === 2 && r.status === 'queued')).toBe(
			true,
		)
		// The apps that succeeded were not touched again.
		const aRows = await db
			.select()
			.from(CustomerAppBuild)
			.where(eq(CustomerAppBuild.appId, a.appId))
		expect(aRows.every((r) => r.attempts === 1)).toBe(true)
	})

	it('applies callbacks forward only', async () => {
		const { appId } = await newApp()
		const started = await startAppBuild({
			appId,
			release: '3.0.0-1',
			platforms: ['ios'],
			actorId: null,
		})
		if (!started.ok) throw new Error('start')
		const buildId = started.buildIds[0]!
		await applyBuildCallback({ buildId, status: 'running' })
		await applyBuildCallback({
			buildId,
			status: 'succeeded',
			logUrl: 'https://github.com/acme/menuza/actions/runs/1',
		})
		const afterRegress = await applyBuildCallback({
			buildId,
			status: 'running',
		})
		expect(afterRegress).toMatchObject({ ok: true, status: 'succeeded' })
		const [row] = await db
			.select()
			.from(CustomerAppBuild)
			.where(eq(CustomerAppBuild.id, buildId))
		expect(row!.logUrl).toBe('https://github.com/acme/menuza/actions/runs/1')
		expect(row!.finishedAt).not.toBeNull()
		// A non-https log link is dropped.
		const other = await startAppBuild({
			appId,
			release: '3.0.1-1',
			platforms: ['ios'],
			actorId: null,
		})
		if (!other.ok) throw new Error('start')
		await applyBuildCallback({
			buildId: other.buildIds[0]!,
			status: 'failed',
			logUrl: 'javascript:alert(1)',
			error: 'eas_failed',
		})
		const [failed] = await db
			.select()
			.from(CustomerAppBuild)
			.where(eq(CustomerAppBuild.id, other.buildIds[0]!))
		expect(failed).toMatchObject({
			status: 'failed',
			error: 'eas_failed',
			logUrl: expect.stringContaining('builds.mock.test'),
		})
	})

	it('records the region at build time and serves only that region in the config', async () => {
		const { appId, organization } = await newApp()
		await startAppBuild({ appId, release: '4.0.0-1', actorId: null })
		const rows = await db
			.select()
			.from(CustomerAppBuild)
			.where(eq(CustomerAppBuild.appId, appId))
		expect(rows.every((r) => r.dataRegion === 'us')).toBe(true)
		const [app] = await db
			.select()
			.from(CustomerApp)
			.where(eq(CustomerApp.id, appId))
		const usConfig = await loadBuildConfig(app!.slug)
		expect(usConfig).toMatchObject({ dataRegion: 'us', tenantApiKsa: '' })
		expect(usConfig!.tenantApiUs).not.toBe('')
		await db
			.update(Organization)
			.set({ dataRegion: 'ksa' })
			.where(eq(Organization.id, organization.id))
		const ksaConfig = await loadBuildConfig(app!.slug)
		expect(ksaConfig).toMatchObject({ dataRegion: 'ksa', tenantApiUs: '' })
		expect(ksaConfig!.tenantApiKsa).not.toBe('')
	})
})

describe('store health (#156 criterion 4)', () => {
	it('shows rating and version per store, and keeps the last known state when unreachable', async () => {
		const { appId } = await newApp({
			iosBundleId: 'com.acme.health',
			androidPackage: 'com.acme.health',
		})
		const lookup = {
			iosBundleId: 'com.acme.health',
			androidPackage: 'com.acme.health',
			storeUrls: {},
		}
		adapters.store.set(lookup, 'app_store', {
			status: 'live',
			version: '1.4.2',
			ratingX100: 462,
			ratingCount: 87,
			reviews: [
				{
					externalId: 'r1',
					rating: 5,
					title: 'Great',
					body: 'Love the app',
					appVersion: '1.4.2',
					reviewedAt: Date.now(),
				},
			],
		})
		adapters.store.set(lookup, 'play_store', {
			status: 'live',
			version: '1.4.1',
			ratingX100: 410,
			ratingCount: 20,
		})
		const first = await refreshStoreHealth(appId, { force: true })
		expect(first).toMatchObject({ ok: true, checked: 2, skipped: false })
		const rows = await db
			.select()
			.from(CustomerAppStoreHealth)
			.where(eq(CustomerAppStoreHealth.appId, appId))
		const ios = rows.find((r) => r.store === 'app_store')!
		expect(ios).toMatchObject({
			status: 'live',
			version: '1.4.2',
			ratingX100: 462,
			ratingCount: 87,
			lastError: null,
		})
		expect(ios.lastCheckedAt).not.toBeNull()

		// At most daily: a second call inside the interval does not read the store.
		const fetchesBefore = adapters.store.fetches
		expect(await refreshStoreHealth(appId)).toMatchObject({ skipped: true })
		expect(adapters.store.fetches).toBe(fetchesBefore)

		// An unreachable store shows the last known state, not an error state.
		adapters.store.unreachable('app_store')
		const later = Date.now() + 25 * 60 * 60 * 1000
		await refreshStoreHealth(appId, { now: later })
		const [after] = await db
			.select()
			.from(CustomerAppStoreHealth)
			.where(
				and(
					eq(CustomerAppStoreHealth.appId, appId),
					eq(CustomerAppStoreHealth.store, 'app_store'),
				),
			)
		expect(after).toMatchObject({
			status: 'live',
			version: '1.4.2',
			ratingX100: 462,
			lastError: 'unreachable',
		})
		expect(after!.lastCheckedAt!.getTime()).toBe(later)
	})

	it('treats only stores with a link and a live state as live', async () => {
		const { appId, organization } = await newApp({
			iosBundleId: 'com.acme.live2',
			androidPackage: 'com.acme.live2',
		})
		await updateCustomerApp({
			appId,
			storeUrls: {
				app_store: 'https://apps.apple.com/us/app/acme/id2',
				play_store:
					'https://play.google.com/store/apps/details?id=com.acme.live2',
			},
		})
		const lookup = {
			iosBundleId: 'com.acme.live2',
			androidPackage: 'com.acme.live2',
			storeUrls: {},
		}
		adapters.store.set(lookup, 'app_store', { status: 'live' })
		adapters.store.set(lookup, 'play_store', { status: 'removed' })
		await refreshStoreHealth(appId, { force: true })
		const result = await loadLiveStores(organization.id)
		expect(Object.keys(result!.live)).toEqual(['app_store'])
	})
})

describe('taps', () => {
	it('counts per placement and day', async () => {
		const { appId } = await newApp()
		await recordTap({ appId, placement: 'banner', store: 'app_store' })
		await recordTap({ appId, placement: 'banner', store: 'play_store' })
		await recordTap({ appId, placement: 'footer', store: 'app_store' })
		const totals = await tapTotals(appId, '2000-01-01')
		expect(
			Object.fromEntries(totals.map((t) => [t.placement, t.total])),
		).toEqual({ banner: 2, footer: 1 })
	})
})
