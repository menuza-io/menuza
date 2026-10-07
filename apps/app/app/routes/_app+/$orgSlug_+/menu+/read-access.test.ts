import {
	createRequestHandler,
	type LoaderFunction,
	RouterContextProvider,
	type ServerBuild,
} from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as overviewLoader } from './_index.tsx'
import { loader as layoutLoader } from './_layout.tsx'
import { loader as categoryLoader } from './categories.$categoryId.tsx'
import { loader as categoriesLoader } from './categories._index.tsx'
import { loader as newCategoryLoader } from './categories.new.tsx'
import { loader as dropLoader } from './drops.$dropId.tsx'
import { loader as dropsLoader } from './drops._index.tsx'
import { loader as newDropLoader } from './drops.new.tsx'
import { loader as itemLoader } from './items.$itemId.tsx'
import { loader as itemsLoader } from './items._index.tsx'
import { loader as newItemLoader } from './items.new.tsx'
import { loader as menuLoader } from './menus.$menuId.tsx'
import { loader as menusLoader } from './menus._index.tsx'
import { loader as newMenuLoader } from './menus.new.tsx'
import { loader as modifierLoader } from './modifiers.$modifierGroupId.tsx'
import { loader as modifiersLoader } from './modifiers._index.tsx'
import { loader as newModifierLoader } from './modifiers.new.tsx'
import { loader as optionLoader } from './options.$optionId.tsx'
import { loader as optionsLoader } from './options._index.tsx'
import { loader as newOptionLoader } from './options.new.tsx'

const mocks = vi.hoisted(() => ({
	requireUserId: vi.fn(),
	requireUserOrganization: vi.fn(),
	requirePermission: vi.fn(),
	menuQuery: vi.fn(),
	select: vi.fn(),
	dropQuery: vi.fn(),
	checkRateLimit: vi.fn(),
}))

vi.mock('@repo/auth', () => ({ requireUserId: mocks.requireUserId }))
vi.mock('@repo/database', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: {
		select: mocks.select,
		query: new Proxy(
			{},
			{
				get: () => ({
					findMany: mocks.menuQuery,
					findFirst: mocks.menuQuery,
				}),
			},
		),
	},
}))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: mocks.requireUserOrganization,
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: {
		READ_MENU_ANY: 'read:menu:any',
		UPDATE_MENU_ANY: 'update:menu:any',
	},
	requireUserWithOrganizationPermission: mocks.requirePermission,
}))
vi.mock('#app/utils/rate-limit.server.ts', () => ({
	checkRateLimit: mocks.checkRateLimit,
	MENU_MUTATION_RATE_LIMIT: {},
}))
vi.mock('#app/utils/menu/drops.server.ts', () => ({
	getDropWithDetails: mocks.dropQuery,
	listDropsForOrganization: mocks.dropQuery,
	saveDrop: vi.fn(),
	deleteDrop: vi.fn(),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(),
}))
vi.mock('#app/components/menu/category-form.tsx', () => ({
	CategoryForm: () => null,
}))
vi.mock('#app/components/menu/item-form.tsx', () => ({
	ItemForm: () => null,
}))
vi.mock('#app/components/menu/menu-form.tsx', () => ({
	MenuForm: () => null,
}))
vi.mock('#app/components/menu/modifier-form.tsx', () => ({
	ModifierForm: () => null,
}))
vi.mock('#app/components/menu/option-form.tsx', () => ({
	OptionForm: () => null,
}))
vi.mock('#app/components/menu/drop-wizard/drop-form.tsx', () => ({
	DropForm: () => null,
}))

const MENU_LOADERS: Array<[string, LoaderFunction]> = [
	['layout', layoutLoader],
	['overview', overviewLoader],
	['categories', categoriesLoader],
	['new category', newCategoryLoader],
	['edit category', categoryLoader],
	['items', itemsLoader],
	['new item', newItemLoader],
	['edit item', itemLoader],
	['menus', menusLoader],
	['new menu', newMenuLoader],
	['edit menu', menuLoader],
	['modifiers', modifiersLoader],
	['new modifier', newModifierLoader],
	['edit modifier', modifierLoader],
	['options', optionsLoader],
	['new option', newOptionLoader],
	['edit option', optionLoader],
	['drops', dropsLoader],
	['new drop', newDropLoader],
	['edit drop', dropLoader],
]

const LAYOUT_ROUTE_ID = 'routes/_app+/$orgSlug_+/menu+/_layout'
const ITEMS_ROUTE_ID = 'routes/_app+/$orgSlug_+/menu+/items._index'

function createDataHandler() {
	const parentLoader = vi.fn(layoutLoader)
	const build: ServerBuild = {
		entry: { module: { default: () => new Response() } },
		routes: {
			root: {
				id: 'root',
				path: '',
				module: { default: () => null },
			},
			[LAYOUT_ROUTE_ID]: {
				id: LAYOUT_ROUTE_ID,
				parentId: 'root',
				path: ':orgSlug/menu',
				module: { default: () => null, loader: parentLoader },
			},
			[ITEMS_ROUTE_ID]: {
				id: ITEMS_ROUTE_ID,
				parentId: LAYOUT_ROUTE_ID,
				path: 'items',
				module: { default: () => null, loader: itemsLoader },
			},
		},
		assets: {
			entry: { imports: [], module: '' },
			routes: {},
			url: '',
			version: 'test',
		},
		publicPath: '/',
		assetsBuildDirectory: 'build/client',
		future: {},
		ssr: true,
		isSpaMode: false,
		prerender: [],
		routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
	}
	return { handler: createRequestHandler(build, 'production'), parentLoader }
}

function dataRequest(childOnly: boolean) {
	const url = new URL('https://app.example/cafe/menu/items.data')
	if (childOnly) url.searchParams.set('_routes', ITEMS_ROUTE_ID)
	return new Request(url)
}

describe('menu read authorization', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.requireUserId.mockResolvedValue('user-1')
		mocks.requireUserOrganization.mockResolvedValue({
			id: 'org-1',
			slug: 'cafe',
			siteDefaultLocale: 'en',
			siteLocales: '["en"]',
		})
		mocks.requirePermission.mockImplementation(async () => {
			throw new Response('Forbidden', { status: 403 })
		})
		mocks.menuQuery.mockResolvedValue([
			{
				id: 'private-item',
				displayName: 'Private catalog item',
				price: 42,
				categoryAssignments: [],
				modifierGroupAssignments: [],
				updatedAt: new Date('2026-01-01'),
			},
		])
	})

	it.each(MENU_LOADERS)(
		'rejects the %s loader before reading menu data without permission',
		async (ignoredName, loader) => {
			const request = new Request('https://app.example/cafe/menu')
			await expect(
				loader({
					request,
					url: new URL(request.url),
					pattern: '/:orgSlug/menu',
					params: {
						orgSlug: 'cafe',
						categoryId: 'category-1',
						itemId: 'item-1',
						menuId: 'menu-1',
						modifierGroupId: 'modifier-1',
						optionId: 'option-1',
						dropId: 'drop-1',
					},
					context: new RouterContextProvider(),
				}),
			).rejects.toMatchObject({ status: 403 })
			expect(mocks.requirePermission).toHaveBeenCalledWith(
				request,
				'org-1',
				'read:menu:any',
			)
			expect(mocks.menuQuery).not.toHaveBeenCalled()
			expect(mocks.select).not.toHaveBeenCalled()
			expect(mocks.dropQuery).not.toHaveBeenCalled()
			expect(mocks.checkRateLimit).not.toHaveBeenCalled()
		},
	)

	it.each([
		['child-only', true],
		['parent and child', false],
	] as const)(
		'returns 403 without catalog data for %s data requests',
		async (ignoredName, childOnly) => {
			const { handler, parentLoader } = createDataHandler()
			const response = await handler(dataRequest(childOnly))
			const body = await response.text()

			expect(response.status).toBe(403)
			expect(parentLoader).toHaveBeenCalledTimes(childOnly ? 0 : 1)
			expect(body).not.toContain('private-item')
			expect(body).not.toContain('Private catalog item')
			expect(mocks.menuQuery).not.toHaveBeenCalled()
			expect(mocks.requirePermission).toHaveBeenCalledTimes(childOnly ? 1 : 2)
		},
	)

	it.each([
		['child-only', true],
		['parent and child', false],
	] as const)(
		'keeps %s data requests accessible to read-only members',
		async (ignoredName, childOnly) => {
			mocks.requirePermission.mockResolvedValue('user-1')
			const { handler } = createDataHandler()
			const response = await handler(dataRequest(childOnly))

			expect(response.status).toBe(200)
			expect(await response.text()).toContain('private-item')
			expect(mocks.menuQuery).toHaveBeenCalledOnce()
			expect(mocks.checkRateLimit).not.toHaveBeenCalled()
		},
	)
})
