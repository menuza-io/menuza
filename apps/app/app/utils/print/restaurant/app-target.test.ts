import { createPrintCatalog } from '@repo/common/print-shop'
import { restaurantPrintCatalog } from '@repo/common/print-shop-restaurant'
import { db, eq, Organization } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { createMockCustomerAppAdapters } from '../../customer-apps/adapters.mock.server.ts'
import { setCustomerAppAdapters } from '../../customer-apps/adapters.select.server.ts'
import {
	createCustomerApp,
	refreshStoreHealth,
	updateCustomerApp,
} from '../../customer-apps/service.server.ts'
import { restaurantPrintVertical } from './vertical.server.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => {}),
}))

const target = restaurantPrintVertical.qrTargets!.app!
const catalog = createPrintCatalog(restaurantPrintCatalog)
let adapters: ReturnType<typeof createMockCustomerAppAdapters>

beforeEach(() => {
	adapters = createMockCustomerAppAdapters()
	setCustomerAppAdapters(adapters)
})
afterEach(() => setCustomerAppAdapters(null))

async function org() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	await db
		.update(Organization)
		.set({ sitePublished: true })
		.where(eq(Organization.id, organization.id))
	return {
		organization,
		user,
		access: {
			userId: user.id,
			organization: { id: organization.id, slug: organization.slug },
		} as never,
	}
}

describe('the app QR code in the Print shop (#196)', () => {
	it('is a registered target for counter prints, with words in every site language', () => {
		expect(catalog.qrTargets.app).toBeDefined()
		expect(catalog.targetsFor('table_tent')).toContain('app')
		expect(catalog.targetsFor('poster')).toContain('app')
		for (const locale of ['en', 'ar', 'es', 'fr', 'de', 'zh']) {
			const copy = catalog.defaultCopy(locale, 'app')
			expect(copy.headline.length).toBeGreaterThan(0)
			expect(copy.qrCaption.length).toBeGreaterThan(0)
		}
		expect(catalog.qrTargetSchema.safeParse({ kind: 'app' }).success).toBe(true)
		expect(
			catalog.qrTargetSchema.safeParse({ kind: 'app', extra: 1 }).success,
		).toBe(false)
	})

	it("prints the site's own /get-app link under the print placement, with the campaign tags", async () => {
		const { access } = await org()
		const { pieces, facts } = await target.resolve(
			{ kind: 'app' },
			{
				request: new Request('https://app.test/'),
				access,
				designId: 'design1',
				siteOrigin: 'https://acme.example',
				utm: { utm_source: 'print', utm_campaign: 'design1' },
			},
		)
		expect(pieces).toHaveLength(1)
		const url = new URL(pieces[0]!.qrUrl)
		expect(url.origin).toBe('https://acme.example')
		expect(url.pathname).toBe('/get-app')
		expect(url.searchParams.get('p')).toBe('print')
		expect(url.searchParams.get('utm_source')).toBe('print')
		// No store link, token or guest data in the code.
		expect(pieces[0]!.qrUrl).not.toMatch(/apps\.apple|play\.google/)
		expect(facts).toEqual([])
	})

	it('is offered only while the app is live in a store', async () => {
		const { organization, user, access } = await org()
		expect(await target.available!(access)).toBe(false)

		const created = await createCustomerApp({
			organizationId: organization.id,
			actorId: user.id,
			iosBundleId: 'com.acme.printqr',
			androidPackage: 'com.acme.printqr',
		})
		if (!created.ok) throw new Error(created.message)
		await updateCustomerApp({
			appId: created.appId,
			storeUrls: { app_store: 'https://apps.apple.com/us/app/acme/id77' },
		})
		// A link that is not live yet is not offered.
		expect(await target.available!(access)).toBe(false)

		adapters.store.set(
			{
				iosBundleId: 'com.acme.printqr',
				androidPackage: 'com.acme.printqr',
				storeUrls: {},
			},
			'app_store',
			{ status: 'live' },
		)
		await refreshStoreHealth(created.appId, { force: true })
		expect(await target.available!(access)).toBe(true)
	})

	it('reads the form back', () => {
		expect(target.fromForm(new FormData())).toEqual({ kind: 'app' })
	})
})
