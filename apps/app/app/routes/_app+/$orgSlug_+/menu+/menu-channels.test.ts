import {
	and,
	db,
	eq,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuLocationOverride,
	UserOrganization,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))

vi.mock('@repo/common/feature-flags', async (importOriginal) => {
	const mod = await importOriginal<Record<string, unknown>>()
	return {
		...mod,
		getFeatureFlag: vi.fn(async () => true),
	}
})

const { action: menuAction } = await import('./menus.$menuId.tsx')
const { action: categoryAction } = await import('./categories.$categoryId.tsx')
const { action: itemAction } = await import('./items.$itemId.tsx')
const { loader: itemsIndexLoader } = await import('./items._index.tsx')
const { action: bulkAction } = await import('./bulk.ts')

function formRequest(
	url: string,
	cookie: string,
	fields: Record<string, string>,
) {
	const formData = new FormData()
	for (const [k, v] of Object.entries(fields)) {
		formData.set(k, v)
	}
	return createAuthenticatedRequest(
		url,
		{ method: 'POST', body: formData },
		cookie,
	)
}

describe('menu channels CRUD, overrides, items list, and bulk edit (#220)', () => {
	it('saves channels and enforces narrow-only location overrides on menus, categories, and items', async () => {
		const { organization, cookieHeader } = await setupTestOrgWithUser('admin')
		const [loc] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'Branch 1',
				slug: 'branch-1',
			})
			.returning()
		if (!loc) throw new Error('Missing location')

		const [menu] = await db
			.insert(OrganizationMenu)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: 'Dinner' }),
			})
			.returning()
		const [category] = await db
			.insert(OrganizationMenuCategory)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: 'Mains' }),
			})
			.returning()
		const [item] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: 'Steak' }),
				price: 30,
			})
			.returning()
		if (!menu || !category || !item) throw new Error('Failed to seed entities')

		// Menu: base = ['web', 'pos'], override attempts ['web', 'qr', 'pos'] -> narrowed to ['web', 'pos'] -> null (matches base)
		const menuRes = await menuAction({
			request: formRequest(
				`https://app.example.test/${organization.slug}/menu/menus/${menu.id}`,
				cookieHeader,
				{
					displayName: JSON.stringify({ en: 'Dinner' }),
					channels: JSON.stringify(['web', 'pos']),
					locationOverrides: JSON.stringify({
						[loc.id]: {
							locationId: loc.id,
							isEnabled: true,
							channels: ['web', 'qr', 'pos'],
						},
					}),
				},
			),
			params: { orgSlug: organization.slug, menuId: menu.id },
			context: {} as never,
		} as never)
		expect(getResponseStatus(menuRes)).toBe(302)
		const [updatedMenu] = await db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.id, menu.id))
		expect(JSON.parse(updatedMenu!.channels)).toEqual(['web', 'pos'])
		const [menuOv] = await db
			.select()
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.entityType, 'menu'),
					eq(OrganizationMenuLocationOverride.entityId, menu.id),
				),
			)
		expect(menuOv?.channels).toBeNull()

		// Category: base = ['web', 'qr', 'pos'], override = ['qr', 'pos'] -> kept as ['qr', 'pos']
		const catRes = await categoryAction({
			request: formRequest(
				`https://app.example.test/${organization.slug}/menu/categories/${category.id}`,
				cookieHeader,
				{
					displayName: JSON.stringify({ en: 'Mains' }),
					channels: JSON.stringify(['web', 'qr', 'pos']),
					locationOverrides: JSON.stringify({
						[loc.id]: {
							locationId: loc.id,
							isEnabled: true,
							channels: ['qr', 'pos', 'app'],
						},
					}),
				},
			),
			params: { orgSlug: organization.slug, categoryId: category.id },
			context: {} as never,
		} as never)
		expect(getResponseStatus(catRes)).toBe(302)
		const [updatedCat] = await db
			.select()
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.id, category.id))
		expect(JSON.parse(updatedCat!.channels)).toEqual(['web', 'qr', 'pos'])
		const [catOv] = await db
			.select()
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.entityType, 'category'),
					eq(OrganizationMenuLocationOverride.entityId, category.id),
				),
			)
		expect(JSON.parse(catOv!.channels!)).toEqual(['qr', 'pos'])

		// Item: base = ['web', 'pos'], override attempts ['pos', 'app'] -> narrowed to ['pos']
		const itemRes = await itemAction({
			request: formRequest(
				`https://app.example.test/${organization.slug}/menu/items/${item.id}`,
				cookieHeader,
				{
					displayName: JSON.stringify({ en: 'Steak' }),
					price: '30',
					channels: JSON.stringify(['web', 'pos']),
					locationOverrides: JSON.stringify({
						[loc.id]: {
							locationId: loc.id,
							isEnabled: true,
							channels: ['pos', 'app'],
						},
					}),
				},
			),
			params: { orgSlug: organization.slug, itemId: item.id },
			context: {} as never,
		} as never)
		expect(getResponseStatus(itemRes)).toBe(302)
		const [updatedItem] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, item.id))
		expect(JSON.parse(updatedItem!.channels)).toEqual(['web', 'pos'])
		const [itemOv] = await db
			.select()
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.entityType, 'item'),
					eq(OrganizationMenuLocationOverride.entityId, item.id),
				),
			)
		expect(JSON.parse(itemOv!.channels!)).toEqual(['pos'])
	})

	it('flags notSoldEverywhere on items._index when base or location override omits a channel', async () => {
		const { organization, cookieHeader } = await setupTestOrgWithUser('admin')
		const [loc] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'Branch A',
				slug: 'branch-a',
			})
			.returning()
		if (!loc) throw new Error('Missing location')

		const [everywhere, tillOnly, locNarrowed] = await db
			.insert(OrganizationMenuItem)
			.values([
				{
					organizationId: organization.id,
					displayName: JSON.stringify({ en: 'Everywhere Soup' }),
					price: 10,
					channels: JSON.stringify(['web', 'qr', 'pos', 'app']),
				},
				{
					organizationId: organization.id,
					displayName: JSON.stringify({ en: 'Till Only Roll' }),
					price: 8,
					channels: JSON.stringify(['pos']),
				},
				{
					organizationId: organization.id,
					displayName: JSON.stringify({ en: 'Branch Web Off Cake' }),
					price: 12,
					channels: JSON.stringify(['web', 'qr', 'pos', 'app']),
				},
			])
			.returning()
		if (!everywhere || !tillOnly || !locNarrowed) {
			throw new Error('Failed to create items')
		}

		await db.insert(OrganizationMenuLocationOverride).values({
			organizationId: organization.id,
			locationId: loc.id,
			entityType: 'item',
			entityId: locNarrowed.id,
			channels: JSON.stringify(['qr', 'pos', 'app']),
		})

		const data = (await itemsIndexLoader({
			request: createAuthenticatedRequest(
				`https://app.example.test/${organization.slug}/menu/items`,
				{},
				cookieHeader,
			),
			params: { orgSlug: organization.slug },
			context: {} as never,
		} as never)) as {
			items: Array<{
				id: string
				channels: string[]
				notSoldEverywhere: boolean
			}>
		}

		const byId = new Map(data.items.map((i) => [i.id, i]))
		expect(byId.get(everywhere.id)?.notSoldEverywhere).toBe(false)
		expect(byId.get(tillOnly.id)?.notSoldEverywhere).toBe(true)
		expect(byId.get(tillOnly.id)?.channels).toEqual(['pos'])
		expect(byId.get(locNarrowed.id)?.notSoldEverywhere).toBe(true)
	})

	it('applies bulk channels edits (base + location-scoped narrow) and enforces viewer 403', async () => {
		const { organization, cookieHeader: adminCookie } =
			await setupTestOrgWithUser('admin')
		const viewerUser = await createTestUser()
		await db.insert(UserOrganization).values({
			userId: viewerUser.id,
			organizationId: organization.id,
			organizationRoleId: 'org_role_viewer',
		})
		const { cookieHeader: viewerCookie } = await createTestSession(
			viewerUser.id,
		)
		const [loc] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'Branch Bulk',
				slug: 'branch-bulk',
			})
			.returning()
		if (!loc) throw new Error('Missing location')

		const [itemA, itemB] = await db
			.insert(OrganizationMenuItem)
			.values([
				{
					organizationId: organization.id,
					displayName: JSON.stringify({ en: 'Item A' }),
					price: 10,
					channels: JSON.stringify(['web', 'pos']),
				},
				{
					organizationId: organization.id,
					displayName: JSON.stringify({ en: 'Item B' }),
					price: 15,
					channels: JSON.stringify(['web', 'qr', 'pos', 'app']),
				},
			])
			.returning()
		if (!itemA || !itemB) throw new Error('Missing items')

		// Viewer is blocked with 403 on item edit & bulk
		let viewerItemStatus = 0
		try {
			const res = await itemAction({
				request: formRequest(
					`https://app.example.test/${organization.slug}/menu/items/${itemA.id}`,
					viewerCookie,
					{ displayName: JSON.stringify({ en: 'Hack' }), price: '1' },
				),
				params: { orgSlug: organization.slug, itemId: itemA.id },
				context: {} as never,
			} as never)
			viewerItemStatus = getResponseStatus(res)
		} catch (caught) {
			viewerItemStatus = getResponseStatus(caught)
		}
		expect(viewerItemStatus).toBe(403)

		let viewerBulkStatus = 0
		try {
			const res = await bulkAction({
				request: createAuthenticatedRequest(
					`https://app.example.test/${organization.slug}/menu/bulk`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							intent: 'apply',
							targetType: 'item',
							ids: [itemA.id],
							operation: { type: 'channels', channels: ['pos'] },
							updatedAt: { [itemA.id]: itemA.updatedAt.toISOString() },
						}),
					},
					viewerCookie,
				),
				params: { orgSlug: organization.slug },
				context: {} as never,
			} as never)
			viewerBulkStatus = getResponseStatus(res)
		} catch (caught) {
			viewerBulkStatus = getResponseStatus(caught)
		}
		expect(viewerBulkStatus).toBe(403)

		// Admin location-scoped bulk edit narrows itemA (['web','pos'] ∩ ['qr','pos'] = ['pos'])
		// and itemB (['web','qr','pos','app'] ∩ ['qr','pos'] = ['qr','pos'])
		const applyRes = await bulkAction({
			request: createAuthenticatedRequest(
				`https://app.example.test/${organization.slug}/menu/bulk`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						intent: 'apply',
						targetType: 'item',
						ids: [itemA.id, itemB.id],
						locationId: loc.id,
						operation: { type: 'channels', channels: ['qr', 'pos'] },
						updatedAt: {
							[itemA.id]: itemA.updatedAt.toISOString(),
							[itemB.id]: itemB.updatedAt.toISOString(),
						},
					}),
				},
				adminCookie,
			),
			params: { orgSlug: organization.slug },
			context: {} as never,
		} as never)
		expect(getResponseStatus(applyRes)).toBe(200)

		const overrides = await db
			.select()
			.from(OrganizationMenuLocationOverride)
			.where(eq(OrganizationMenuLocationOverride.locationId, loc.id))
		const ovByItem = new Map(overrides.map((o) => [o.entityId, o]))
		expect(JSON.parse(ovByItem.get(itemA.id)!.channels!)).toEqual(['pos'])
		expect(JSON.parse(ovByItem.get(itemB.id)!.channels!)).toEqual(['qr', 'pos'])

		// Admin org-wide bulk edit updates base OrganizationMenuItem.channels
		const [freshItemA] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, itemA.id))
		const baseApplyRes = await bulkAction({
			request: createAuthenticatedRequest(
				`https://app.example.test/${organization.slug}/menu/bulk`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						intent: 'apply',
						targetType: 'item',
						ids: [itemA.id],
						operation: { type: 'channels', channels: ['pos'] },
						updatedAt: { [itemA.id]: freshItemA!.updatedAt.toISOString() },
					}),
				},
				adminCookie,
			),
			params: { orgSlug: organization.slug },
			context: {} as never,
		} as never)
		expect(getResponseStatus(baseApplyRes)).toBe(200)
		const [itemAAfter] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, itemA.id))
		expect(JSON.parse(itemAAfter!.channels)).toEqual(['pos'])
	})
})
