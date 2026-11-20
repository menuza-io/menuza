import { describe, expect, it } from 'vitest'
import {
	buildCustomerAppConfig,
	canDeleteApp,
	credentialStatuses,
	dueExpiryAlert,
	evaluateAccountChecks,
	expiryAlertKey,
	identifiersLocked,
	liveStores,
	parseCredentialUpload,
	parseStoreUrl,
	rebuildRequired,
	showsAccountChecks,
	summarizeRelease,
} from './customer-app.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 20)

describe('store links', () => {
	it('accepts only the stores', () => {
		expect(
			parseStoreUrl('app_store', 'https://apps.apple.com/us/app/acme/id123'),
		).toBeTruthy()
		expect(
			parseStoreUrl(
				'play_store',
				'https://play.google.com/store/apps/details?id=com.acme.app',
			),
		).toBeTruthy()
		expect(
			parseStoreUrl('app_store', 'http://apps.apple.com/us/app/acme/id123'),
		).toBeNull()
		expect(
			parseStoreUrl('app_store', 'https://apps.apple.com.evil.example/app'),
		).toBeNull()
		expect(
			parseStoreUrl(
				'play_store',
				'https://play.google.com/store/apps/details?id=a b',
			),
		).toBeNull()
		expect(
			parseStoreUrl(
				'play_store',
				'https://user:pw@play.google.com/store/apps/details?id=a.b',
			),
		).toBeNull()
		expect(parseStoreUrl('app_store', 'javascript:alert(1)')).toBeNull()
	})
})

describe('lifecycle', () => {
	it('locks ids once published and allows delete only before', () => {
		expect(identifiersLocked({ status: 'draft', publishedAt: null })).toBe(
			false,
		)
		expect(canDeleteApp({ status: 'draft', publishedAt: null })).toBe(true)
		expect(
			identifiersLocked({ status: 'published', publishedAt: new Date() }),
		).toBe(true)
		expect(canDeleteApp({ status: 'archived', publishedAt: new Date() })).toBe(
			false,
		)
	})
})

describe('live stores (#196)', () => {
	const urls = {
		app_store: 'https://apps.apple.com/us/app/acme/id1',
		play_store: 'https://play.google.com/store/apps/details?id=com.acme',
	}
	it('needs a link and a live state per store', () => {
		expect(
			liveStores({
				status: 'published',
				storeUrls: urls,
				health: [
					{ store: 'app_store', status: 'live' },
					{ store: 'play_store', status: 'removed' },
				],
			}),
		).toEqual({ app_store: urls.app_store })
		expect(
			liveStores({
				status: 'published',
				storeUrls: { play_store: urls.play_store },
				health: [{ store: 'app_store', status: 'live' }],
			}),
		).toEqual({})
		expect(
			liveStores({
				status: 'archived',
				storeUrls: urls,
				health: [{ store: 'app_store', status: 'live' }],
			}),
		).toEqual({})
		expect(
			liveStores({ status: 'draft', storeUrls: urls, health: [] }),
		).toEqual({})
	})
})

describe('account checks (#156)', () => {
	it('warns inside 30 days, fails once expired, and says how to fix it', () => {
		const ok = evaluateAccountChecks(
			{
				developerAccountExpiresAt: NOW + 90 * DAY,
				termsAccepted: true,
				paymentTermsAccepted: true,
				accessOk: true,
			},
			NOW,
		)
		expect(ok.every((c) => c.status === 'pass' && c.steps.length === 0)).toBe(
			true,
		)

		const [warn] = evaluateAccountChecks(
			{
				developerAccountExpiresAt: NOW + 12 * DAY,
				termsAccepted: null,
				paymentTermsAccepted: null,
				accessOk: null,
			},
			NOW,
		)
		expect(warn).toMatchObject({
			kind: 'developer_account',
			status: 'warn',
			daysLeft: 12,
		})
		expect(warn!.steps).toEqual([
			'renew_developer_account',
			'pay_developer_fee',
		])

		const [expired] = evaluateAccountChecks(
			{
				developerAccountExpiresAt: NOW - DAY,
				termsAccepted: null,
				paymentTermsAccepted: null,
				accessOk: null,
			},
			NOW,
		)
		expect(expired).toMatchObject({ status: 'fail' })

		const fails = evaluateAccountChecks(
			{
				developerAccountExpiresAt: null,
				termsAccepted: false,
				paymentTermsAccepted: false,
				accessOk: false,
			},
			NOW,
		)
		expect(fails.map((c) => [c.kind, c.status])).toEqual([
			['store_terms', 'fail'],
			['payment_terms', 'fail'],
			['store_access', 'fail'],
		])
		expect(fails.flatMap((c) => c.steps)).toEqual([
			'accept_store_terms',
			'accept_payment_terms',
			'restore_store_access',
		])
	})

	it('alerts at 30 days, 7 days and on expiry, and re-arms after a renewal', () => {
		expect(dueExpiryAlert(NOW + 60 * DAY, NOW)).toBeNull()
		expect(dueExpiryAlert(NOW + 29 * DAY, NOW)).toBe(30)
		expect(dueExpiryAlert(NOW + 6 * DAY, NOW)).toBe(7)
		expect(dueExpiryAlert(NOW - DAY, NOW)).toBe(0)
		expect(expiryAlertKey(30, NOW + 29 * DAY)).not.toBe(
			expiryAlertKey(30, NOW + 395 * DAY),
		)
	})

	it('hides the checks for Menuza-published apps', () => {
		expect(showsAccountChecks('menuza')).toBe(false)
		expect(showsAccountChecks('restaurant')).toBe(true)
	})
})

describe('credential uploads', () => {
	it('validates the shape and never echoes the secret in a message', () => {
		const good = parseCredentialUpload('apns', {
			key: '-----BEGIN PRIVATE KEY-----\nABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF\n-----END PRIVATE KEY-----',
			keyId: 'ABC123DEFG',
			teamId: 'TEAM123456',
		})
		expect(good).toMatchObject({ ok: true, teamId: 'TEAM123456' })
		const bad = parseCredentialUpload('apns', {
			key: 'not a key but secret-text-secret-text-secret-text-secret',
			keyId: 'x',
			teamId: 'y',
		})
		expect(bad.ok).toBe(false)
		expect(JSON.stringify(bad)).not.toContain('secret-text')
		expect(
			parseCredentialUpload(
				'fcm',
				'{"type":"service_account","project_id":"p","client_email":"a@b.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF"}',
			).ok,
		).toBe(true)
		expect(parseCredentialUpload('fcm', 'not json').ok).toBe(false)
	})

	it('reports only set and date', () => {
		const statuses = credentialStatuses([
			{ kind: 'fcm', uploadedAt: new Date('2026-01-02T00:00:00Z') },
		])
		expect(statuses).toEqual([
			{ kind: 'apns', set: false, uploadedAt: null },
			{ kind: 'fcm', set: true, uploadedAt: '2026-01-02T00:00:00.000Z' },
		])
	})
})

describe('build config', () => {
	const app = {
		slug: 'acme',
		displayName: 'Acme',
		iosBundleId: 'com.acme.app',
		androidPackage: 'com.acme.app',
		marketingVersion: '1.0.0',
		iconBackground: '#0F172A',
		appleTeamId: null,
		androidSha256: [],
		status: 'draft' as const,
	}
	const organization = {
		slug: 'acme',
		dataRegion: 'ksa',
		siteHost: 'acme.menuza.io',
		siteOrigin: 'https://acme.menuza.io',
		iconUrl: null,
	}
	const endpoints = {
		appUrl: 'app.menuza.io',
		brandDomain: 'menuza.io',
		tenantApiUs: 'us.menuza.io',
		tenantApiKsa: 'ksa.menuza.io',
	}

	it('holds only its own region and claims only its own domain', () => {
		const config = buildCustomerAppConfig(app, organization, endpoints)
		expect(config).toMatchObject({
			tenantApiUs: '',
			tenantApiKsa: 'ksa.menuza.io',
			dataRegion: 'ksa',
			associatedDomains: ['acme.menuza.io'],
			useTls: true,
		})
	})

	it('knows when a region change needs a new build', () => {
		expect(
			rebuildRequired({ organizationRegion: 'us', lastBuiltRegion: 'ksa' }),
		).toBe(true)
		expect(
			rebuildRequired({ organizationRegion: 'us', lastBuiltRegion: 'us' }),
		).toBe(false)
		expect(
			rebuildRequired({ organizationRegion: 'us', lastBuiltRegion: null }),
		).toBe(false)
	})
})

describe('release summary', () => {
	it('counts per app', () => {
		expect(
			summarizeRelease([
				{ appId: 'a', ok: true, buildIds: [] },
				{ appId: 'b', ok: false, code: 'x', message: 'y' },
			]),
		).toEqual({ total: 2, succeeded: 1, failed: 1, failedAppIds: ['b'] })
	})
})
