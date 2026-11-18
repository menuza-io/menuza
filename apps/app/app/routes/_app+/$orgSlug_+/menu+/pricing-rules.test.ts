import { auditService } from '@repo/audit'
import { resolveMenuItemPrice } from '@repo/common/menu-pricing'
import {
	db,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuPricingRule,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))

import { action, loader } from './pricing-rules.tsx'

type Setup = Awaited<ReturnType<typeof setupTestOrgWithUser>>

async function post(setup: Setup, body: unknown) {
	const request = new Request(
		`https://app.example/${setup.organization.slug}/menu/pricing-rules`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: setup.cookie },
			body: JSON.stringify(body),
		},
	)
	try {
		return (await action({
			request,
			params: { orgSlug: setup.organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

async function seed(organizationId: string) {
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name: 'Main',
			slug: 'main',
			isActive: true,
			isDefault: true,
		})
		.returning()
	const [menu] = await db
		.insert(OrganizationMenu)
		.values({ organizationId, displayName: 'Lunch' })
		.returning()
	const [mains] = await db
		.insert(OrganizationMenuCategory)
		.values({ organizationId, displayName: 'Mains' })
		.returning()
	await db
		.insert(OrganizationMenuCategoryAssignment)
		.values({ menuId: menu!.id, categoryId: mains!.id })
	const dish = async (name: string, price: number) => {
		const [item] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId,
				displayName: JSON.stringify({ en: name }),
				price,
			})
			.returning()
		await db
			.insert(OrganizationMenuItemCategoryAssignment)
			.values({ categoryId: mains!.id, itemId: item!.id })
		return item!
	}
	return { location: location!, menu: menu!, mains: mains!, dish }
}

const body = (categoryId: string) => ({
	name: 'Plus ten',
	percent: '10',
	menuIds: [],
	categoryIds: [categoryId],
	locationIds: [],
	roundingMode: 'decimals',
	roundingDecimals: 0,
	roundingAmount: '',
	excludeMin: '',
	excludeMax: '',
})

/** What a guest pays for a dish now, from the published menu. */
async function guestPrice(setup: Setup, itemId: string, locationId: string) {
	const { payload } = await buildPublicSiteMenuPayload(
		{
			id: setup.organization.id,
			name: 'Org',
			slug: setup.organization.slug,
			currency: 'USD',
			siteDefaultLocale: 'en',
			siteLocales: null,
			customDomain: null,
		},
		null,
	)
	const item = payload.menus
		.flatMap((menu) => menu.categories)
		.flatMap((category) =>
			category.items.map((entry) => ({ entry, categoryId: category.id })),
		)
		.find(({ entry }) => entry.id === itemId)!
	return resolveMenuItemPrice(
		{ ...item.entry, categoryIds: [item.categoryId] },
		{ orderType: 'pickup', locationId, rules: payload.pricingRules ?? [] },
		{
			overridePrice: payload.locationOverrides[locationId]?.find(
				(row) => row.entityId === itemId,
			)?.price,
		},
	)
}

describe('Menu pricing rules (#388)', () => {
	it('previews +10% round-up, saves it, covers a new dish, skips fixed prices, and ends', async () => {
		const setup = await setupTestOrgWithUser()
		const { location, mains, dish } = await seed(setup.organization.id)
		const salad = await dish('Salad', 9.99)
		const steak = await dish('Steak', 18.5)
		await db.insert(OrganizationMenuLocationOverride).values({
			organizationId: setup.organization.id,
			locationId: location.id,
			entityType: 'item',
			entityId: steak.id,
			price: 17,
		})

		const previewed = (await (
			await post(setup, { intent: 'preview', ...body(mains.id) })
		).json()) as {
			preview: {
				total: number
				changed: number
				rows: Array<{
					itemId: string
					before: number
					after: number
					unchanged?: string
				}>
			}
		}
		expect(previewed.preview).toMatchObject({ total: 2, changed: 1 })
		expect(previewed.preview.rows).toEqual([
			expect.objectContaining({ itemId: salad.id, before: 9.99, after: 11 }),
			expect.objectContaining({
				itemId: steak.id,
				before: 17,
				after: 17,
				unchanged: 'fixed_price',
			}),
		])
		// Preview writes nothing.
		expect(await db.select().from(OrganizationMenuPricingRule)).toHaveLength(0)

		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const saved = await post(setup, { intent: 'create', ...body(mains.id) })
		expect(saved.status).toBe(200)
		const { id } = (await saved.json()) as { id: string }
		expect(await guestPrice(setup, salad.id, location.id)).toBe(11)
		expect(await guestPrice(setup, steak.id, location.id)).toBe(17)

		// A dish added to the category afterwards follows the rule.
		const soup = await dish('Soup', 6.2)
		expect(await guestPrice(setup, soup.id, location.id)).toBe(7)

		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				resourceType: 'menu_pricing_rule',
				resourceId: id,
			}),
		)

		const ended = await post(setup, { intent: 'end', ruleId: id })
		expect(ended.status).toBe(200)
		expect(await guestPrice(setup, salad.id, location.id)).toBe(9.99)
		const page = await loader({
			request: new Request(
				`https://app.example/${setup.organization.slug}/menu/pricing-rules`,
				{
					headers: { cookie: setup.cookie },
				},
			),
			params: { orgSlug: setup.organization.slug },
			context: new RouterContextProvider(),
		} as never)
		expect(page.rules[0]).toMatchObject({ id, live: false })
	})

	it('refuses a zero or out-of-range percentage and needs menu write access', async () => {
		const setup = await setupTestOrgWithUser()
		const { mains } = await seed(setup.organization.id)
		const zero = await post(setup, {
			intent: 'preview',
			...body(mains.id),
			percent: '0',
		})
		expect(zero.status).toBe(422)
		expect(((await zero.json()) as { error: string }).error).toBe(
			'percent_invalid',
		)
		const viewer = await setupTestOrgWithUser('viewer')
		const refused = await post(viewer, { intent: 'preview', ...body('x') })
		expect(refused.status).toBe(403)
	})

	it('refuses another organization’s category', async () => {
		const setup = await setupTestOrgWithUser()
		const other = await setupTestOrgWithUser()
		const { mains } = await seed(other.organization.id)
		const response = await post(setup, { intent: 'preview', ...body(mains.id) })
		expect(response.status).toBe(404)
	})
})
