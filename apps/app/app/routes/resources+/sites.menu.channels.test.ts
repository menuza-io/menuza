import {
	db,
	eq,
	Organization,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuLocationOverride,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	buildPublicSiteMenuPayload,
	type PublicSiteMenuOrgContext,
} from '#app/utils/menu/public-menu-context.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

const kvStore = new Map<string, unknown>()

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	getSiteCacheVersion: vi.fn(async () => 'v1'),
	getMenuCacheGeneration: vi.fn(async () => '1'),
	getSiteKvKey: vi.fn(
		(type: string, id: string, queryHash: string, version: string) =>
			`org:${id}:v${version}:${type}:${queryHash}`,
	),
	getCachedSiteData: vi.fn(async (key: string) => kvStore.get(key) ?? null),
	setCachedSiteData: vi.fn(async (key: string, value: unknown) => {
		kvStore.set(key, value)
	}),
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))

vi.mock('#app/utils/rate-limit.server.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		checkRateLimit: vi.fn(async () => ({
			allowed: true,
			remaining: 99,
			resetAt: new Date(Date.now() + 60_000),
			limit: 100,
		})),
	}
})

const { loader } = await import('./sites.menu.ts')

function jsonDisplayName(en: string) {
	return JSON.stringify({ en })
}

function makeOrgContext(
	org: typeof Organization.$inferSelect,
): PublicSiteMenuOrgContext {
	return {
		id: org.id,
		slug: org.slug,
		name: org.name,
		currency: 'USD',
		customDomain: org.customDomain ?? null,
		siteDefaultLocale: org.siteDefaultLocale,
		siteLocales: org.siteLocales,
	}
}

async function seedChannelMenuFixture() {
	const { organization } = await setupTestOrgWithUser('admin')
	await db
		.update(Organization)
		.set({ sitePublished: true })
		.where(eq(Organization.id, organization.id))

	const [locA, locB] = await db
		.insert(OrganizationLocation)
		.values([
			{
				organizationId: organization.id,
				name: 'Location A',
				slug: 'loc-a',
			},
			{
				organizationId: organization.id,
				name: 'Location B',
				slug: 'loc-b',
			},
		])
		.returning()

	if (!locA || !locB) {
		throw new Error('Failed to create test locations')
	}

	const [mainMenu, posOnlyMenu] = await db
		.insert(OrganizationMenu)
		.values([
			{
				organizationId: organization.id,
				displayName: jsonDisplayName('All Channels Menu'),
				channels: JSON.stringify(['web', 'qr', 'pos', 'app']),
				position: 0,
			},
			{
				organizationId: organization.id,
				displayName: jsonDisplayName('Till Only Menu'),
				channels: JSON.stringify(['pos']),
				position: 1,
			},
		])
		.returning()

	if (!mainMenu || !posOnlyMenu) {
		throw new Error('Failed to create test menus')
	}

	const [allChannelCat, posOnlyCat, posMenuCat] = await db
		.insert(OrganizationMenuCategory)
		.values([
			{
				organizationId: organization.id,
				displayName: jsonDisplayName('Mains'),
				channels: JSON.stringify(['web', 'qr', 'pos', 'app']),
				position: 0,
			},
			{
				organizationId: organization.id,
				displayName: jsonDisplayName('Till Only Category'),
				channels: JSON.stringify(['pos']),
				position: 1,
			},
			{
				organizationId: organization.id,
				displayName: jsonDisplayName('Register Specials'),
				channels: JSON.stringify(['web', 'qr', 'pos', 'app']),
				position: 2,
			},
		])
		.returning()

	if (!allChannelCat || !posOnlyCat || !posMenuCat) {
		throw new Error('Failed to create test categories')
	}

	await db.insert(OrganizationMenuCategoryAssignment).values([
		{ menuId: mainMenu.id, categoryId: allChannelCat.id, position: 0 },
		{ menuId: mainMenu.id, categoryId: posOnlyCat.id, position: 1 },
		{ menuId: posOnlyMenu.id, categoryId: posMenuCat.id, position: 0 },
	])

	const [
		everywhereItem,
		tillOnlyItem,
		catInheritedItem,
		menuInheritedItem,
		locOverrideItem,
	] = await db
		.insert(OrganizationMenuItem)
		.values([
			{
				organizationId: organization.id,
				displayName: jsonDisplayName('Classic Burger'),
				price: 15,
				channels: JSON.stringify(['web', 'qr', 'pos', 'app']),
				position: 0,
			},
			{
				organizationId: organization.id,
				displayName: jsonDisplayName('Till Only Steak'),
				price: 40,
				channels: JSON.stringify(['pos']),
				position: 1,
			},
			{
				organizationId: organization.id,
				displayName: jsonDisplayName('Hidden By Category'),
				price: 12,
				channels: JSON.stringify(['web', 'qr', 'pos', 'app']),
				position: 2,
			},
			{
				organizationId: organization.id,
				displayName: jsonDisplayName('Hidden By Menu'),
				price: 18,
				channels: JSON.stringify(['web', 'qr', 'pos', 'app']),
				position: 3,
			},
			{
				organizationId: organization.id,
				displayName: jsonDisplayName('Location Web Hidden Salad'),
				price: 14,
				channels: JSON.stringify(['web', 'qr', 'pos', 'app']),
				position: 4,
			},
		])
		.returning()

	if (
		!everywhereItem ||
		!tillOnlyItem ||
		!catInheritedItem ||
		!menuInheritedItem ||
		!locOverrideItem
	) {
		throw new Error('Failed to create test items')
	}

	await db.insert(OrganizationMenuItemCategoryAssignment).values([
		{ categoryId: allChannelCat.id, itemId: everywhereItem.id, position: 0 },
		{ categoryId: allChannelCat.id, itemId: tillOnlyItem.id, position: 1 },
		{ categoryId: allChannelCat.id, itemId: locOverrideItem.id, position: 2 },
		{ categoryId: posOnlyCat.id, itemId: catInheritedItem.id, position: 0 },
		{ categoryId: posMenuCat.id, itemId: menuInheritedItem.id, position: 0 },
	])

	// Location A narrows locOverrideItem off on 'web' only
	await db.insert(OrganizationMenuLocationOverride).values({
		organizationId: organization.id,
		locationId: locA.id,
		entityType: 'item',
		entityId: locOverrideItem.id,
		channels: JSON.stringify(['qr', 'pos', 'app']),
	})

	return {
		organization,
		locA,
		locB,
		mainMenu,
		posOnlyMenu,
		allChannelCat,
		posOnlyCat,
		everywhereItem,
		tillOnlyItem,
		catInheritedItem,
		menuInheritedItem,
		locOverrideItem,
	}
}

function extractItemIds(payload: {
	menus: Array<{
		categories: Array<{
			items: Array<{ id: string }>
			subcategories?: Array<{ items: Array<{ id: string }> }>
		}>
	}>
}): string[] {
	const ids: string[] = []
	for (const menu of payload.menus) {
		for (const cat of menu.categories) {
			for (const item of cat.items) ids.push(item.id)
			for (const sub of cat.subcategories ?? []) {
				for (const item of sub.items) ids.push(item.id)
			}
		}
	}
	return ids
}

async function callLoader(url: string) {
	const response = await loader({
		request: new Request(url),
		params: {},
		context: {} as never,
	} as never)
	return {
		status: response.status,
		body: (await response.json()) as any,
	}
}

describe('sites.menu & buildPublicSiteMenuPayload channels (#220)', () => {
	beforeEach(() => {
		kvStore.clear()
	})

	it('defaults to web, hides till-only dish + off category/menu on web/qr/app, and shows all on pos', async () => {
		const f = await seedChannelMenuFixture()

		// Default (no ?channel=) -> web
		const defaultRes = await callLoader(
			`https://example.test/resources/sites/menu?slug=${f.organization.slug}`,
		)
		expect(defaultRes.status).toBe(200)
		const webIds = extractItemIds(defaultRes.body)
		expect(webIds).toContain(f.everywhereItem.id)
		expect(webIds).toContain(f.locOverrideItem.id) // no location selected yet
		expect(webIds).not.toContain(f.tillOnlyItem.id)
		expect(webIds).not.toContain(f.catInheritedItem.id)
		expect(webIds).not.toContain(f.menuInheritedItem.id)
		expect(defaultRes.body.menus.map((m: { id: string }) => m.id)).toEqual([
			f.mainMenu.id,
		])

		// QR
		const qrRes = await callLoader(
			`https://example.test/resources/sites/menu?slug=${f.organization.slug}&channel=qr`,
		)
		expect(qrRes.status).toBe(200)
		const qrIds = extractItemIds(qrRes.body)
		expect(qrIds).toContain(f.everywhereItem.id)
		expect(qrIds).not.toContain(f.tillOnlyItem.id)
		expect(qrIds).not.toContain(f.catInheritedItem.id)
		expect(qrIds).not.toContain(f.menuInheritedItem.id)

		// Customer app
		const appRes = await callLoader(
			`https://example.test/resources/sites/menu?slug=${f.organization.slug}&channel=app`,
		)
		expect(appRes.status).toBe(200)
		const appIds = extractItemIds(appRes.body)
		expect(appIds).toContain(f.everywhereItem.id)
		expect(appIds).not.toContain(f.tillOnlyItem.id)
		expect(appIds).not.toContain(f.catInheritedItem.id)
		expect(appIds).not.toContain(f.menuInheritedItem.id)

		// Station POS (?channel=pos) sees everything!
		const posRes = await callLoader(
			`https://example.test/resources/sites/menu?slug=${f.organization.slug}&channel=pos`,
		)
		expect(posRes.status).toBe(200)
		const posIds = extractItemIds(posRes.body)
		expect(posIds).toContain(f.everywhereItem.id)
		expect(posIds).toContain(f.tillOnlyItem.id)
		expect(posIds).toContain(f.catInheritedItem.id)
		expect(posIds).toContain(f.menuInheritedItem.id)
		expect(posRes.body.menus.map((m: { id: string }) => m.id)).toEqual([
			f.mainMenu.id,
			f.posOnlyMenu.id,
		])

		// Cache keys are isolated per channel (4 distinct keys in KV store)
		const keys = [...kvStore.keys()]
		expect(keys.some((k) => k.endsWith('-web'))).toBe(true)
		expect(keys.some((k) => k.endsWith('-qr'))).toBe(true)
		expect(keys.some((k) => k.endsWith('-app'))).toBe(true)
		expect(keys.some((k) => k.endsWith('-pos'))).toBe(true)
	})

	it('returns 400 on invalid channel parameter', async () => {
		const f = await seedChannelMenuFixture()
		const invalidRes = await callLoader(
			`https://example.test/resources/sites/menu?slug=${f.organization.slug}&channel=fax`,
		)
		expect(invalidRes.status).toBe(400)
		expect(invalidRes.body.error).toBe('Invalid channel')
	})

	it('applies location override to hide a dish on one channel at that location only', async () => {
		const f = await seedChannelMenuFixture()

		// Location A + web -> locOverrideItem is hidden
		const locAWeb = await callLoader(
			`https://example.test/resources/sites/menu?slug=${f.organization.slug}&locationId=${f.locA.id}&channel=web`,
		)
		expect(extractItemIds(locAWeb.body)).not.toContain(f.locOverrideItem.id)
		expect(extractItemIds(locAWeb.body)).toContain(f.everywhereItem.id)

		// Location A + qr -> locOverrideItem is visible
		const locAQr = await callLoader(
			`https://example.test/resources/sites/menu?slug=${f.organization.slug}&locationId=${f.locA.id}&channel=qr`,
		)
		expect(extractItemIds(locAQr.body)).toContain(f.locOverrideItem.id)

		// Location B + web -> locOverrideItem is visible
		const locBWeb = await callLoader(
			`https://example.test/resources/sites/menu?slug=${f.organization.slug}&locationId=${f.locB.id}&channel=web`,
		)
		expect(extractItemIds(locBWeb.body)).toContain(f.locOverrideItem.id)
	})

	it('keeps full catalog with channels metadata when options.channel is omitted (for order-context)', async () => {
		const f = await seedChannelMenuFixture()
		const { payload: fullPayload } = await buildPublicSiteMenuPayload(
			makeOrgContext(f.organization),
			f.locA.id,
		)
		const fullIds = extractItemIds(fullPayload)
		expect(fullIds).toContain(f.everywhereItem.id)
		expect(fullIds).toContain(f.tillOnlyItem.id)
		expect(fullIds).toContain(f.catInheritedItem.id)
		expect(fullIds).toContain(f.menuInheritedItem.id)
		expect(fullIds).toContain(f.locOverrideItem.id)

		const allItems = fullPayload.menus.flatMap((m) =>
			m.categories.flatMap((c) => c.items),
		)
		const tillItem = allItems.find((i) => i.id === f.tillOnlyItem.id)
		expect(tillItem?.channels).toEqual(['pos'])
		const locOverrideEntry = fullPayload.locationOverrides[f.locA.id]?.find(
			(ov) => ov.entityType === 'item' && ov.entityId === f.locOverrideItem.id,
		)
		expect(locOverrideEntry?.channels).toEqual(['qr', 'pos', 'app'])
	})
})
