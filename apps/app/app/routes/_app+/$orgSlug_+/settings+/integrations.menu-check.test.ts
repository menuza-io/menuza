import {
	db,
	Integration,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import { merchantIds, sandboxUrls } from '@repo/integrations'
import {
	posSandboxHandlers,
	resetPosSandbox,
} from '@repo/integrations/pos/sandbox'
import { http, HttpResponse } from 'msw'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	checkDeliveryMenuActionIntent,
	fixDeliveryMenuActionIntent,
} from '#app/components/settings/cards/organization/pos-integrations-card.tsx'
import {
	action as integrationsAction,
	loader as integrationsLoader,
} from '#app/routes/_app+/$orgSlug_+/settings+/integrations.tsx'
import { action as menuCheckJobAction } from '#app/routes/resources+/jobs.menu-check.ts'
import { INTEGRATION_FLAG_KEYS } from '#app/utils/integrations/flags.server.ts'
import { loadMenuHealthSummary } from '#app/utils/menu/menu-health.server.ts'
import { server } from '#tests/mocks/index.ts'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'

const flags = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) => flags.on.has(key)),
}))

async function seedOrgWithDelivery() {
	const { organization, cookie } = await setupTestOrgWithUser('admin')
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: JSON.stringify({ en: 'Downtown' }),
			slug: `downtown-${Date.now()}`,
			timezone: 'UTC',
			isDefault: true,
		})
		.returning()

	const [delivery] = await db
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

	const [menu] = await db
		.insert(OrganizationMenu)
		.values({
			organizationId: organization.id,
			displayName: JSON.stringify({ en: 'All Day' }),
			position: 0,
		})
		.returning()
	const [cat] = await db
		.insert(OrganizationMenuCategory)
		.values({
			organizationId: organization.id,
			displayName: JSON.stringify({ en: 'Mains' }),
		})
		.returning()
	await db.insert(OrganizationMenuCategoryAssignment).values({
		menuId: menu!.id,
		categoryId: cat!.id,
	})
	const [item] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId: organization.id,
			displayName: JSON.stringify({ en: 'Burger' }),
			description: JSON.stringify({ en: 'Grilled burger' }),
			imageKey: 'burger.jpg',
			price: 11.5,
			allergens: '["gluten"]',
		})
		.returning()
	await db.insert(OrganizationMenuItemCategoryAssignment).values({
		categoryId: cat!.id,
		itemId: item!.id,
	})

	return { organization, cookie, location: location!, delivery: delivery! }
}

describe('integrations menu-check route, daily job & menu health (#144)', () => {
	beforeEach(() => {
		flags.on.clear()
		resetPosSandbox()
		server.use(...posSandboxHandlers)
	})

	afterEach(() => {
		server.resetHandlers()
		vi.restoreAllMocks()
	})

	it('gates check-delivery-menu and fix-delivery-menu behind integrations.menu_check (404 when off)', async () => {
		const { organization, cookie, delivery } = await seedOrgWithDelivery()

		const form = new FormData()
		form.set('intent', checkDeliveryMenuActionIntent)
		form.set('integrationId', delivery.id)
		const res = (await integrationsAction({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{ method: 'POST', body: form },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(res.status).toBe(404)

		const health = await loadMenuHealthSummary({
			id: organization.id,
			siteLocales: null,
			siteDefaultLocale: null,
		})
		expect(
			health.checks.find((c) => c.key === 'delivery_menu_differs'),
		).toBeUndefined()
	})

	it('runs Check now, exposes diffs in loader & Menu health, enforces 3/day limit, and fixes via Fix by pushing', async () => {
		flags.on.add(INTEGRATION_FLAG_KEYS.menuCheck)
		const { organization, cookie, delivery } = await seedOrgWithDelivery()

		// 1. Check now
		const checkForm = new FormData()
		checkForm.set('intent', checkDeliveryMenuActionIntent)
		checkForm.set('integrationId', delivery.id)
		const checkRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{ method: 'POST', body: checkForm },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(checkRes.status).toBe(200)
		const checkJson = (await checkRes.json()) as {
			ok: boolean
			errorDiffCount: number
		}
		expect(checkJson.ok).toBe(true)
		expect(checkJson.errorDiffCount).toBeGreaterThan(0)

		// 2. Loader returns menuCheck + diffs
		const loaderData = await integrationsLoader({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)
		expect(loaderData.menuCheckEnabled).toBe(true)
		const dto = loaderData.integrations.find((i) => i.id === delivery.id)
		expect(dto?.menuCheck?.diffCount).toBe(checkJson.errorDiffCount)
		expect(dto?.menuCheck?.diffs.length).toBeGreaterThan(0)

		// 3. Menu health reports delivery_menu_differs
		const healthBefore = await loadMenuHealthSummary({
			id: organization.id,
			siteLocales: null,
			siteDefaultLocale: null,
		})
		const deliveryCheck = healthBefore.checks.find(
			(c) => c.key === 'delivery_menu_differs',
		)
		expect(deliveryCheck).toBeDefined()
		expect(deliveryCheck!.count).toBe(1)
		expect(deliveryCheck!.entityType).toBe('integration')

		// 4. Fix by pushing resolves the mismatch
		const fixForm = new FormData()
		fixForm.set('intent', fixDeliveryMenuActionIntent)
		fixForm.set('integrationId', delivery.id)
		const fixRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{ method: 'POST', body: fixForm },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(fixRes.status).toBe(200)
		expect(((await fixRes.json()) as { ok: boolean }).ok).toBe(true)

		// Menu health clears delivery_menu_differs after push
		const healthAfter = await loadMenuHealthSummary({
			id: organization.id,
			siteLocales: null,
			siteDefaultLocale: null,
		})
		expect(
			healthAfter.checks.find((c) => c.key === 'delivery_menu_differs')?.count,
		).toBe(0)

		// 5. Two more manual checks hit the 3/day limit on the 4th
		for (let i = 0; i < 2; i++) {
			const f = new FormData()
			f.set('intent', checkDeliveryMenuActionIntent)
			f.set('integrationId', delivery.id)
			const r = (await integrationsAction({
				request: createAuthenticatedRequest(
					`http://localhost/${organization.slug}/settings/integrations`,
					{ method: 'POST', body: f },
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: new RouterContextProvider(),
			} as never)) as Response
			expect(r.status).toBe(200)
		}

		const limitForm = new FormData()
		limitForm.set('intent', checkDeliveryMenuActionIntent)
		limitForm.set('integrationId', delivery.id)
		const limitRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{ method: 'POST', body: limitForm },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(limitRes.status).toBe(429)
		expect(((await limitRes.json()) as { error: string }).error).toBe(
			'check_limit_reached',
		)
	})

	it('requires internal command auth on /resources/jobs/menu-check and runs daily check on POST', async () => {
		flags.on.add(INTEGRATION_FLAG_KEYS.menuCheck)
		await seedOrgWithDelivery()

		let unauthStatus = 0
		try {
			const res = await menuCheckJobAction({
				request: new Request('http://localhost/resources/jobs/menu-check', {
					method: 'POST',
				}),
				params: {},
				context: new RouterContextProvider(),
			} as never)
			unauthStatus = res.status
		} catch (thrown) {
			unauthStatus = (thrown as Response).status
		}
		expect(unauthStatus).toBe(401)

		const token =
			ENV.INTERNAL_COMMAND_TOKEN ||
			process.env.INTERNAL_COMMAND_TOKEN ||
			'test-internal-command-token-12345'
		const okRes = (await menuCheckJobAction({
			request: new Request('http://localhost/resources/jobs/menu-check', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
			}),
			params: {},
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(okRes.status).toBe(200)
		const json = (await okRes.json()) as { success: boolean; checked: number }
		expect(json.success).toBe(true)
		expect(json.checked).toBeGreaterThanOrEqual(1)
	})

	it('read failure via sandbox error preserves prior check results and shows Could not check', async () => {
		flags.on.add(INTEGRATION_FLAG_KEYS.menuCheck)
		const { organization, cookie, delivery } = await seedOrgWithDelivery()

		const firstForm = new FormData()
		firstForm.set('intent', checkDeliveryMenuActionIntent)
		firstForm.set('integrationId', delivery.id)
		const firstRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{ method: 'POST', body: firstForm },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(firstRes.status).toBe(200)

		server.use(
			http.get(`${sandboxUrls.ubereats}/v2/eats/stores/*/menus`, () =>
				HttpResponse.json({ message: 'Down' }, { status: 500 }),
			),
		)

		const secondForm = new FormData()
		secondForm.set('intent', checkDeliveryMenuActionIntent)
		secondForm.set('integrationId', delivery.id)
		const secondRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{ method: 'POST', body: secondForm },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(secondRes.status).toBe(502)

		const loaderData = await integrationsLoader({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)
		const dto = loaderData.integrations.find((i) => i.id === delivery.id)
		expect(dto?.menuCheck?.lastError).toBe('Could not check')
		expect(dto?.menuCheck?.diffCount).toBeGreaterThan(0)
		expect(dto?.menuCheck?.diffs.length).toBeGreaterThan(0)
	})
})
