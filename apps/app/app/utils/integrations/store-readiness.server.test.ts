import {
	and,
	db,
	eq,
	Integration,
	IntegrationLog,
	MenuSyncOutbox,
	Organization,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import {
	merchantIds,
	parsePosConfig,
	pushMenu,
	sandboxUrls,
} from '@repo/integrations'
import {
	getSandboxHolidayHours,
	posSandboxHandlers,
	resetPosSandbox,
} from '@repo/integrations/pos/sandbox'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { action as locationEditAction } from '#app/routes/_app+/$orgSlug_+/settings+/locations.$locationId.tsx'
import { INTEGRATION_FLAG_KEYS } from '#app/utils/integrations/flags.server.ts'
import {
	evaluateStoreReadiness,
	goLiveDeliveryStore,
	isDeliveryManagedByPos,
	saveStoreSettings,
} from '#app/utils/integrations/store-readiness.server.ts'
import { drainMenuSyncOutbox } from '#app/utils/menu/menu-sync.server.ts'
import { server } from '#tests/mocks/index.ts'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'

const flags = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) => flags.on.has(key)),
}))

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))

vi.mock('#app/utils/gbp/sync.server.ts', () => ({
	enqueueGbpPush: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('#app/utils/reservations/access.server.ts', () => ({
	isReservationsFeatureEnabled: vi.fn().mockResolvedValue(false),
	notifyReservationsContextChanged: vi.fn().mockResolvedValue(undefined),
}))

const menuSyncWakeHandler = http.post(
	'http://localhost:8787/workflows/menu-sync/start',
	() => HttpResponse.json({ success: true }),
)

async function seedStoreFixture() {
	const { organization, cookie } = await setupTestOrgWithUser('admin')
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: JSON.stringify({ en: 'Downtown' }),
			slug: `downtown-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			timezone: 'America/New_York',
			address: JSON.stringify({
				formattedAddress: '123 Main St, New York, NY 10001',
				city: 'New York',
				state: 'NY',
				postalCode: '10001',
				country: 'US',
				lat: 40.71,
				lng: -74.0,
			}),
			phone: '+12125550100',
			email: 'store@example.com',
			isDefault: true,
		})
		.returning()

	const [uber] = await db
		.insert(Integration)
		.values({
			organizationId: organization.id,
			organizationLocationId: location!.id,
			providerName: 'ubereats',
			providerType: 'delivery',
			isActive: true,
			config: JSON.stringify({
				environment: 'sandbox',
				merchantId: merchantIds.ubereats,
			}),
		})
		.returning()

	const menus: Array<typeof OrganizationMenu.$inferSelect> = []
	for (const [idx, name] of ['Lunch', 'Dinner', 'Brunch'].entries()) {
		const [menu] = await db
			.insert(OrganizationMenu)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: name }),
				position: idx,
			})
			.returning()
		menus.push(menu!)

		const [cat] = await db
			.insert(OrganizationMenuCategory)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: `${name} Mains` }),
			})
			.returning()

		await db.insert(OrganizationMenuCategoryAssignment).values({
			menuId: menu!.id,
			categoryId: cat!.id,
			position: 0,
		})

		const [item] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: `${name} Dish` }),
				price: 12.5,
				imageUrl: `https://cdn.example.com/${name.toLowerCase()}.jpg`,
				imageKey: `${name.toLowerCase()}.jpg`,
			})
			.returning()

		await db.insert(OrganizationMenuItemCategoryAssignment).values({
			categoryId: cat!.id,
			itemId: item!.id,
			position: 0,
		})
	}

	return { organization, cookie, location: location!, uber: uber!, menus }
}

describe('Delivery store settings, readiness & holiday hours (#96)', () => {
	beforeEach(() => {
		flags.on.clear()
		flags.on.add(INTEGRATION_FLAG_KEYS.storeSettings)
		flags.on.add(INTEGRATION_FLAG_KEYS.autoSync)
		resetPosSandbox()
		server.use(menuSyncWakeHandler, ...posSandboxHandlers)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('AC #1: selecting 2 of 3 menus pushes only those 2 menus and switching menus drops unselected dishes', async () => {
		const { organization, uber, menus } = await seedStoreFixture()
		const [lunch, dinner, brunch] = menus

		await saveStoreSettings(organization.id, uber.id, {
			menuIds: [lunch!.id, dinner!.id],
			holidaySync: false,
		})

		const capturedBodies: Array<Record<string, unknown>> = []
		server.use(
			http.put(
				`${sandboxUrls.ubereats}/v2/eats/stores/${merchantIds.ubereats}/menus`,
				async ({ request }) => {
					capturedBodies.push((await request.json()) as Record<string, unknown>)
					return new HttpResponse(null, {
						status: 204,
						headers: { 'x-pos-sandbox': 'true' },
					})
				},
			),
		)

		const firstPush = await pushMenu(uber.id, organization.id)
		expect(firstPush.pushed).toBe(2)
		expect(capturedBodies).toHaveLength(1)
		const firstPayload = JSON.stringify(capturedBodies[0])
		expect(firstPayload).toContain('Lunch Dish')
		expect(firstPayload).toContain('Dinner Dish')
		expect(firstPayload).not.toContain('Brunch Dish')

		// Switch to only Brunch: Lunch & Dinner dishes are dropped
		await saveStoreSettings(organization.id, uber.id, {
			menuIds: [brunch!.id],
			holidaySync: false,
		})
		const secondPush = await pushMenu(uber.id, organization.id)
		expect(secondPush.pushed).toBe(1)
		const secondPayload = JSON.stringify(capturedBodies[1])
		expect(secondPayload).toContain('Brunch Dish')
		expect(secondPayload).not.toContain('Lunch Dish')
		expect(secondPayload).not.toContain('Dinner Dish')
	})

	it('enforces no_menus_selected, menu_limit_reached, and managed_by_pos', async () => {
		const { organization, location, uber, menus } = await seedStoreFixture()

		await expect(
			saveStoreSettings(organization.id, uber.id, {
				menuIds: [],
				holidaySync: false,
			}),
		).rejects.toMatchObject({ code: 'no_menus_selected', status: 400 })

		await expect(
			saveStoreSettings(organization.id, uber.id, {
				menuIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
				holidaySync: false,
			}),
		).rejects.toMatchObject({ code: 'menu_limit_reached', status: 400 })

		// Connect an active Clover POS that feeds Uber Eats at this location
		await db.insert(Integration).values({
			organizationId: organization.id,
			organizationLocationId: location.id,
			providerName: 'clover',
			providerType: 'pos',
			isActive: true,
			config: JSON.stringify({
				environment: 'sandbox',
				merchantId: merchantIds.clover,
				feedsDelivery: ['ubereats'],
			}),
		})

		expect(
			await isDeliveryManagedByPos(organization.id, location.id, 'ubereats'),
		).toBe(true)

		await expect(
			saveStoreSettings(organization.id, uber.id, {
				menuIds: [menus[0]!.id],
				holidaySync: false,
			}),
		).rejects.toMatchObject({ code: 'managed_by_pos', status: 409 })

		const readiness = await evaluateStoreReadiness(organization.id, uber.id)
		expect(readiness.managedByPos).toBe(true)
		expect(readiness.ready).toBe(false)
		expect(readiness.reasons.some((r) => r.code === 'managed_by_pos')).toBe(
			true,
		)
	})

	it('AC #3: blocks Go live (400) for zero_price, >20% missing photos, or missing location contact info, then succeeds when fixed', async () => {
		const { organization, location, uber, menus } = await seedStoreFixture()
		const lunch = menus[0]!

		await saveStoreSettings(organization.id, uber.id, {
			menuIds: [lunch.id],
			holidaySync: true,
		})

		// Add a zero-price dish without a photo to Lunch (1 of 2 = 50% > 20%)
		const [catAssign] = await db
			.select()
			.from(OrganizationMenuCategoryAssignment)
			.where(eq(OrganizationMenuCategoryAssignment.menuId, lunch.id))
			.limit(1)

		const [badDish] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: 'Free Soup' }),
				price: 0,
				imageUrl: null,
				imageKey: null,
			})
			.returning()
		await db.insert(OrganizationMenuItemCategoryAssignment).values({
			categoryId: catAssign!.categoryId,
			itemId: badDish!.id,
			position: 1,
		})

		// Clear location phone/address/email
		await db
			.update(OrganizationLocation)
			.set({ address: null, phone: null, email: null })
			.where(eq(OrganizationLocation.id, location.id))
		await db
			.update(Organization)
			.set({ legalContact: null })
			.where(eq(Organization.id, organization.id))

		const blocked = await goLiveDeliveryStore(organization.id, uber.id)
		expect(blocked.ok).toBe(false)
		if (!blocked.ok) {
			expect(blocked.status).toBe(400)
			const codes = blocked.reasons.map((r) => r.code)
			expect(codes).toContain('zero_price')
			expect(codes).toContain('missing_photos')
			expect(codes).toContain('location_missing_address')
			expect(codes).toContain('location_missing_phone')
			expect(codes).toContain('location_missing_email')
		}

		// Fix dish price & photo, and restore location contact info
		await db
			.update(OrganizationMenuItem)
			.set({
				price: 8.0,
				imageUrl: 'https://cdn.example.com/soup.jpg',
				imageKey: 'soup.jpg',
			})
			.where(eq(OrganizationMenuItem.id, badDish!.id))
		await db
			.update(OrganizationLocation)
			.set({
				address: JSON.stringify({ formattedAddress: '123 Main St' }),
				phone: '+12125550100',
				email: 'store@example.com',
			})
			.where(eq(OrganizationLocation.id, location.id))

		const liveResult = await goLiveDeliveryStore(organization.id, uber.id)
		expect(liveResult.ok).toBe(true)

		const [updatedUber] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.id, uber.id))
			.limit(1)
		expect(parsePosConfig(updatedUber!.config).store?.live).toBe(true)
	})

	it('AC #2: saving specialHours enqueues holiday_hours sync and draining pushes to sandbox and logs pos_holiday_hours', async () => {
		const { organization, cookie, location, uber, menus } =
			await seedStoreFixture()

		await saveStoreSettings(organization.id, uber.id, {
			menuIds: [menus[0]!.id],
			holidaySync: true,
		})

		const futureDate = '2099-12-25'
		const specialHours = JSON.stringify([
			{
				id: 'xmas',
				date: futureDate,
				isOpen: false,
				slots: [],
			},
		])

		const formData = new FormData()
		formData.set('name', 'Downtown')
		formData.set('slug', location.slug)
		formData.set('timezone', 'America/New_York')
		formData.set('taxRate', '0')
		formData.set('isActive', 'true')
		formData.set('isDefault', 'true')
		formData.set('prepTime', '15')
		formData.set('largeOrderThreshold', '100')
		formData.set('largeOrderThresholdType', 'dollars')
		formData.set('largeOrderExtraPrepTime', '15')
		formData.set('specialHours', specialHours)

		const request = createAuthenticatedRequest(
			`http://localhost/${organization.slug}/settings/locations/${location.id}`,
			{ method: 'POST', body: formData },
			cookie,
		)
		const response = (await locationEditAction({
			request,
			params: { orgSlug: organization.slug, locationId: location.id },
			context: {} as never,
		} as never)) as Response
		expect(response.status).toBe(302)

		const queued = await db
			.select()
			.from(MenuSyncOutbox)
			.where(
				and(
					eq(MenuSyncOutbox.integrationId, uber.id),
					eq(MenuSyncOutbox.kind, 'holiday_hours'),
				),
			)
		expect(queued).toHaveLength(1)

		const drainResult = await drainMenuSyncOutbox({
			organizationId: organization.id,
			integrationId: uber.id,
		})
		expect(drainResult.holidayHoursSent).toBe(1)
		expect(getSandboxHolidayHours(uber.id)).toEqual([
			{
				date: futureDate,
				isOpen: false,
				intervals: [],
				timezone: 'America/New_York',
			},
		])

		const logs = await db
			.select()
			.from(IntegrationLog)
			.where(
				and(
					eq(IntegrationLog.integrationId, uber.id),
					eq(IntegrationLog.action, 'pos_holiday_hours'),
				),
			)
		expect(logs).toHaveLength(1)
		expect(logs[0]!.status).toBe('success')

		// Nightly drain also queues and sends holiday_hours when holidaySync is true
		const nightlyResult = await drainMenuSyncOutbox({
			organizationId: organization.id,
			integrationId: uber.id,
			nightly: true,
		})
		expect(nightlyResult.holidayHoursSent).toBe(1)
	})
})
