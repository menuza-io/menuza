import { type LoaderFunction, RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as overviewLoader } from './_index.tsx'
import { loader as categoriesLoader } from './categories._index.tsx'
import { loader as itemsLoader } from './items._index.tsx'

const OLD = new Date('2026-01-01T00:00:00Z')

const ITEMS = [
	{
		id: 'with-photo',
		organizationId: 'org-1',
		displayName: '{"en":"Hummus"}',
		internalName: null,
		description: '{"en":"Chickpeas"}',
		price: 8,
		imageKey: 'menu/hummus.jpg',
		imageUrl: 'https://cdn/hummus.jpg',
		imageKeys: '[]',
		variations: '{"groups":[],"variants":[]}',
		isAlcohol: false,
		isGlutenFree: false,
		isVegetarian: true,
		isPopular: false,
		isUpsell: false,
		allergens: '["sesame"]',
		calorieMin: null,
		calorieMax: null,
		availabilityStatus: 'available',
		unavailableUntil: null,
		updatedAt: OLD,
		categoryAssignments: [],
		modifierGroupAssignments: [],
	},
	{
		id: 'no-photo',
		organizationId: 'org-1',
		displayName: '{"en":"Falafel"}',
		internalName: null,
		description: null,
		price: 0,
		imageKey: null,
		imageUrl: null,
		imageKeys: '[]',
		variations: '{"groups":[],"variants":[]}',
		isAlcohol: false,
		isGlutenFree: false,
		isVegetarian: true,
		isPopular: false,
		isUpsell: false,
		allergens: '[]',
		calorieMin: null,
		calorieMax: null,
		availabilityStatus: 'available',
		unavailableUntil: null,
		updatedAt: OLD,
		categoryAssignments: [],
		modifierGroupAssignments: [],
	},
]

const CATEGORIES = [
	{
		id: 'mezze',
		parentId: null,
		displayName: 'Mezze',
		internalName: null,
		availabilityStatus: 'available',
		unavailableUntil: null,
		excludeFromOverride: false,
		updatedAt: OLD,
		menuAssignments: [],
		itemAssignments: [{ id: 'a1', itemId: 'with-photo' }],
	},
	{
		id: 'desserts',
		parentId: null,
		displayName: 'Desserts',
		internalName: null,
		availabilityStatus: 'available',
		unavailableUntil: null,
		excludeFromOverride: false,
		updatedAt: OLD,
		menuAssignments: [],
		itemAssignments: [],
	},
]

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	select: vi.fn(),
	selectDistinct: vi.fn(),
	requirePermission: vi.fn(),
	hasPermission: vi.fn(),
}))

vi.mock('@repo/auth', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requireUserId: vi.fn(async () => 'user-1'),
	userHasOrganizationPermission: mocks.hasPermission,
}))
vi.mock('@repo/database', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: {
		select: mocks.select,
		selectDistinct: mocks.selectDistinct,
		query: new Proxy(
			{},
			{ get: (_target, table) => ({ findMany: () => mocks.findMany(table) }) },
		),
	},
}))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: vi.fn(async () => ({
		id: 'org-1',
		slug: 'cafe',
		dataRegion: 'us',
		siteDefaultLocale: 'en',
		siteLocales: '["en"]',
	})),
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: {
		READ_MENU_ANY: 'read:menu:any',
		UPDATE_MENU_ANY: 'update:menu:any',
	},
	requireUserWithOrganizationPermission: mocks.requirePermission,
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(),
}))

function call(loader: LoaderFunction, path: string) {
	const request = new Request(`https://app.example/cafe/menu/${path}`)
	return loader({
		request,
		url: new URL(request.url),
		pattern: '/:orgSlug/menu',
		params: { orgSlug: 'cafe' },
		context: new RouterContextProvider(),
	}) as Promise<any>
}

describe('menu health loaders', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.requirePermission.mockResolvedValue('user-1')
		mocks.hasPermission.mockResolvedValue(false)
		mocks.findMany.mockImplementation(async (table: string) => {
			if (table === 'OrganizationMenuItem') return ITEMS
			if (table === 'OrganizationMenuCategory') return CATEGORIES
			return []
		})
		mocks.select.mockImplementation((columns: Record<string, unknown>) => ({
			from: () => ({
				where: async () => ('price' in columns ? ITEMS : CATEGORIES),
			}),
		}))
		mocks.selectDistinct.mockImplementation(() => ({
			from: () => ({
				innerJoin: () => ({ where: async () => [{ categoryId: 'mezze' }] }),
			}),
		}))
	})

	it('scores the menu on the overview after the read check, without ids', async () => {
		const data = await call(overviewLoader, '')
		expect(mocks.requirePermission).toHaveBeenCalledWith(
			expect.any(Request),
			'org-1',
			'read:menu:any',
		)
		expect(data.health.itemCount).toBe(2)
		expect(data.health.score).toBeLessThan(100)
		const noPhoto = data.health.checks.find(
			(check: { key: string }) => check.key === 'no_photo',
		)
		expect(noPhoto).toEqual({
			key: 'no_photo',
			severity: 'warning',
			count: 1,
			total: 2,
		})
		expect(
			data.health.checks.find(
				(check: { key: string }) => check.key === 'empty_category',
			)?.count,
		).toBe(1)
		expect(JSON.stringify(data.health)).not.toContain('no-photo')
		// Read-only members get the card without Review suggestions.
		expect(data.review).toEqual({
			canEdit: false,
			translationLocales: [],
			autoTranslate: false,
		})
	})

	it('offers Review suggestions to members who can edit the menu', async () => {
		mocks.hasPermission.mockResolvedValue(true)
		const data = await call(overviewLoader, '')
		expect(mocks.hasPermission).toHaveBeenCalledWith(
			'user-1',
			'org-1',
			'update:menu:any',
		)
		expect(data.review).toEqual({
			canEdit: true,
			translationLocales: [],
			autoTranslate: false,
		})
	})

	it('filters the items list with ?health=', async () => {
		const data = await call(itemsLoader, 'items?health=no_photo')
		expect(data.healthFilter).toEqual({
			key: 'no_photo',
			itemIds: ['no-photo'],
		})
		// The full list still loads; the page narrows it.
		expect(data.items).toHaveLength(2)
	})

	it('ignores unknown or category keys on the items list', async () => {
		expect(
			(await call(itemsLoader, 'items?health=bogus')).healthFilter,
		).toBeNull()
		expect(
			(await call(itemsLoader, 'items?health=empty_category')).healthFilter,
		).toBeNull()
	})

	it('filters the categories list to empty categories', async () => {
		const data = await call(
			categoriesLoader,
			'categories?health=empty_category',
		)
		expect(data.healthFilter).toEqual({
			key: 'empty_category',
			categoryIds: ['desserts'],
		})
		expect(
			(await call(categoriesLoader, 'categories?health=no_photo')).healthFilter,
		).toBeNull()
	})
})
