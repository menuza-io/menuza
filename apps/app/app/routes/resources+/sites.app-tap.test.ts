import {
	CustomerApp,
	CustomerAppStoreHealth,
	CustomerAppTap,
	db,
	eq,
	Organization,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { loadPublicCustomerApp } from '#app/utils/customer-apps/public.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { action } from './sites.app-tap.ts'

vi.mock('#app/utils/rate-limit.server.ts', () => ({
	PUBLIC_SITE_RATE_LIMIT: {},
	checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
	createRateLimitResponse: vi.fn(),
}))

async function siteWithApp(live: Array<'app_store' | 'play_store'>) {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	await db
		.update(Organization)
		.set({ sitePublished: true })
		.where(eq(Organization.id, organization.id))
	const appId = `app_${organization.id}`
	await db.insert(CustomerApp).values({
		id: appId,
		organizationId: organization.id,
		slug: `s-${organization.id}`.toLowerCase(),
		displayName: 'Acme',
		iosBundleId: `com.acme.${organization.id.toLowerCase()}`,
		androidPackage: `com.acme.a${organization.id.toLowerCase()}`,
		status: 'published',
		publishedAt: new Date(),
		storeUrls: JSON.stringify({
			app_store: 'https://apps.apple.com/us/app/acme/id1',
			play_store: 'https://play.google.com/store/apps/details?id=com.acme.app',
		}),
	})
	for (const store of live) {
		await db
			.insert(CustomerAppStoreHealth)
			.values({ appId, store, status: 'live' })
	}
	return { organization, appId }
}

function post(body: unknown, method = 'POST') {
	const url = new URL('http://localhost:3001/resources/sites/app-tap')
	return action({
		request: new Request(url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: method === 'POST' ? JSON.stringify(body) : undefined,
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: url.pathname,
	} as never)
}

const totals = async (appId: string) =>
	Object.fromEntries(
		(
			await db
				.select()
				.from(CustomerAppTap)
				.where(eq(CustomerAppTap.appId, appId))
		).map((row) => [`${row.placement}:${row.store}`, row.count]),
	)

describe('POST /resources/sites/app-tap (#196, taps counted per placement)', () => {
	it('counts a tap on a live store, per placement and store', async () => {
		const { organization, appId } = await siteWithApp([
			'app_store',
			'play_store',
		])
		for (let i = 0; i < 3; i += 1) {
			expect(
				await (
					await post({
						slug: organization.slug,
						placement: 'banner',
						store: 'app_store',
					})
				).json(),
			).toEqual({ ok: true, counted: true })
		}
		await post({
			slug: organization.slug,
			placement: 'footer',
			store: 'play_store',
		})
		await post({
			slug: organization.slug,
			placement: 'confirmation',
			store: 'app_store',
		})
		expect(await totals(appId)).toEqual({
			'banner:app_store': 3,
			'footer:play_store': 1,
			'confirmation:app_store': 1,
		})
	})

	it('counts nothing for a store that is not live', async () => {
		const { organization, appId } = await siteWithApp(['app_store'])
		expect(
			await (
				await post({
					slug: organization.slug,
					placement: 'banner',
					store: 'play_store',
				})
			).json(),
		).toEqual({ ok: true, counted: false })
		expect(await totals(appId)).toEqual({})
	})

	it('refuses junk, unknown placements and other methods, and stores no visitor data', async () => {
		const { organization, appId } = await siteWithApp(['app_store'])
		expect(
			(
				await post({
					slug: organization.slug,
					placement: 'sidebar',
					store: 'app_store',
				})
			).status,
		).toBe(400)
		expect(
			(await post({ placement: 'banner', store: 'app_store' })).status,
		).toBe(400)
		expect((await post(null, 'GET')).status).toBe(405)
		expect(
			(
				await post({
					slug: 'nope-nope',
					placement: 'banner',
					store: 'app_store',
				})
			).status,
		).toBe(404)
		const columns = Object.keys(
			(
				await db
					.select()
					.from(CustomerAppTap)
					.where(eq(CustomerAppTap.appId, appId))
			)[0] ?? { appId, placement: '', store: '', day: '', count: 0 },
		).sort()
		expect(columns).toEqual(['appId', 'count', 'day', 'placement', 'store'])
	})

	it('publishes only live stores and switches in the public site facts', async () => {
		const { organization } = await siteWithApp(['app_store'])
		const pub = await loadPublicCustomerApp(organization.id)
		expect(Object.keys(pub!.stores)).toEqual(['app_store'])
		expect(pub!.invite).toEqual({
			banner: true,
			confirmation: true,
			footer: true,
			bannerText: '',
		})
		expect(JSON.stringify(pub)).not.toMatch(/ciphertext|credential/i)
	})
})
