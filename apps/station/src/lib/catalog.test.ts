import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import {
	buildCategories,
	categoryItems,
	refreshCatalog,
	isSoldOut,
} from './catalog.ts'
import { loadSettings } from './config.ts'
import { db } from './db.ts'
import { demoCatalog } from './demo-catalog.ts'
import {
	availableOptions,
	canQuickAdd,
	validateConfig,
	defaultSelections,
	defaultVariantPicks,
} from './item-config.ts'
import { tillRulesStatus } from './till-discounts.ts'
import { type MenuPayload } from './types.ts'

const menu = (): MenuPayload => structuredClone(demoCatalog().menu)

describe('sub-categories', () => {
	it('keeps nested categories under their parent, three levels deep', () => {
		const drinks = buildCategories(menu(), 'loc-1').find(
			(c) => c.id === 'c-drinks',
		)!
		expect(drinks.subcategories!.map((c) => c.id)).toEqual(['c-hot', 'c-cold'])
		expect(drinks.subcategories![1]!.subcategories!.map((c) => c.id)).toEqual([
			'c-juice',
			'c-soda',
		])
	})

	it('folds every descendant item into the parent, once', () => {
		const drinks = buildCategories(menu(), 'loc-1').find(
			(c) => c.id === 'c-drinks',
		)!
		const ids = categoryItems(drinks).map((i) => i.id)
		expect(ids).toEqual(
			expect.arrayContaining([
				'i-water',
				'i-latte',
				'i-cola',
				'i-oj',
				'i-lemon',
			]),
		)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it('drops a sub-category that the API also lists at the top level', () => {
		const m = menu()
		const cold = m.menus[0]!.categories.find((c) => c.id === 'c-drinks')!
			.subcategories![1]!
		m.menus[0]!.categories.push(cold)
		const top = buildCategories(m, 'loc-1').map((c) => c.id)
		expect(top).not.toContain('c-cold')
	})

	it('hides a sub-category disabled for this location, and a parent left empty', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{ entityType: 'category', entityId: 'c-juice', isEnabled: false },
		]
		const drinks = buildCategories(m, 'loc-1').find((c) => c.id === 'c-drinks')!
		const cold = drinks.subcategories!.find((c) => c.id === 'c-cold')!
		expect(cold.subcategories!.map((c) => c.id)).toEqual(['c-soda'])
	})

	it('applies item overrides: disabled items vanish, prices change', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{ entityType: 'item', entityId: 'i-oj', isEnabled: false },
			{ entityType: 'item', entityId: 'i-cola', price: 9 },
		]
		const items = categoryItems(
			buildCategories(m, 'loc-1').find((c) => c.id === 'c-drinks')!,
		)
		expect(items.find((i) => i.id === 'i-oj')).toBeUndefined()
		expect(items.find((i) => i.id === 'i-cola')!.price).toBe(9)
	})
})

describe('availability and overrides match what the server enforces', () => {
	const items = (m: MenuPayload) =>
		categoryItems(buildCategories(m, 'loc-1').find((c) => c.id === 'c-mains')!)
	const find = (m: MenuPayload, id: string) => items(m).find((i) => i.id === id)

	it('an item whose status is hidden is not on the till at all', () => {
		const m = menu()
		m.menus[0]!.categories.find((c) => c.id === 'c-mains')!.items.find(
			(i) => i.id === 'i-chicken',
		)!.availabilityStatus = 'hidden'
		expect(find(m, 'i-chicken')).toBeUndefined()
	})

	it('an override can hide an item, and can make one sold out', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{
				entityType: 'item',
				entityId: 'i-chicken',
				availabilityStatus: 'hidden',
			},
			{
				entityType: 'item',
				entityId: 'i-salmon',
				availabilityStatus: 'unavailable',
			},
		]
		expect(find(m, 'i-chicken')).toBeUndefined()
		expect(isSoldOut(find(m, 'i-salmon')!)).toBe(true)
	})

	it('any status other than available is sold out, including "unavailable until"', () => {
		for (const status of [
			'unavailable',
			'unavailable_until',
			'unavailable_until_tomorrow',
		]) {
			const m = menu()
			m.menus[0]!.categories.find((c) => c.id === 'c-mains')!.items.find(
				(i) => i.id === 'i-chicken',
			)!.availabilityStatus = status
			expect({ status, soldOut: isSoldOut(find(m, 'i-chicken')!) }).toEqual({
				status,
				soldOut: true,
			})
		}
	})

	it('a zero or missing override price never zeroes a price (the server ignores it too)', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{ entityType: 'item', entityId: 'i-salmon', price: 0 },
			{ entityType: 'item', entityId: 'i-chicken', price: null },
		]
		expect(find(m, 'i-salmon')!.price).toBe(19)
		expect(find(m, 'i-chicken')!.price).toBe(12.75)
	})

	it('modifier option overrides apply: price replaced, disabled and hidden options removed', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{ entityType: 'option', entityId: 'o-cheese', price: 3 },
			{ entityType: 'option', entityId: 'o-bacon', isEnabled: false },
			{ entityType: 'option', entityId: 'o-egg', availabilityStatus: 'hidden' },
			{
				entityType: 'option',
				entityId: 'o-avo',
				availabilityStatus: 'unavailable',
			},
		]
		const burger = find(m, 'i-burger')!
		const extras = burger.modifierGroups.find((g) => g.id === 'g-extras')!
		expect(extras.options.map((o) => o.id)).toEqual(['o-cheese', 'o-avo'])
		expect(extras.options.find((o) => o.id === 'o-cheese')!.price).toBe(3)
		// Sold-out options are kept in the data but never offered.
		expect(availableOptions(extras).map((o) => o.id)).toEqual(['o-cheese'])
	})

	it('a hidden modifier group is removed, and a sold-out group is skipped rather than demanded', () => {
		const m = menu()
		m.locationOverrides['loc-1'] = [
			{
				entityType: 'modifier_group',
				entityId: 'g-extras',
				availabilityStatus: 'hidden',
			},
			{
				entityType: 'modifier_group',
				entityId: 'g-temp',
				availabilityStatus: 'unavailable',
			},
		]
		const burger = find(m, 'i-burger')!
		expect(burger.modifierGroups.map((g) => g.id)).toEqual(['g-temp'])
		// The required "how cooked" group is sold out: nothing valid can be chosen.
		expect(
			validateConfig(
				burger,
				defaultVariantPicks(burger),
				defaultSelections(burger),
			),
		).toBeNull()
	})

	it('a variant that is "unavailable until" cannot be picked', () => {
		const m = menu()
		const pizza = m.menus[0]!.categories.find(
			(c) => c.id === 'c-pizza',
		)!.items.find((i) => i.id === 'i-marg')!
		pizza.variations.variants[0]!.availabilityStatus = 'unavailable_until'
		const built = categoryItems(
			buildCategories(m, 'loc-1').find((c) => c.id === 'c-pizza')!,
		).find((i) => i.id === 'i-marg')!
		expect(isSoldOut(built)).toBe(false) // the large still sells
		expect(defaultVariantPicks(built)).toEqual({ size: 'lg' })
		pizza.variations.variants[1]!.availabilityStatus = 'unavailable'
		const all = categoryItems(
			buildCategories(m, 'loc-1').find((c) => c.id === 'c-pizza')!,
		).find((i) => i.id === 'i-marg')!
		expect(isSoldOut(all)).toBe(true)
		expect(canQuickAdd(all)).toBe(false)
	})

	it('a payload with no availability fields is treated as available', () => {
		const m = menu()
		const item = m.menus[0]!.categories.find(
			(c) => c.id === 'c-mains',
		)!.items.find((i) => i.id === 'i-chicken')!
		delete (item as { availabilityStatus?: string }).availabilityStatus
		expect(isSoldOut(find(m, 'i-chicken')!)).toBe(false)
	})
})

describe('till discount rules in the stored catalog', () => {
	it('stores the fetched rules as a list, with the time they were fetched', async () => {
		const demo = demoCatalog()
		const rules = [{ id: 'd1', name: 'Ten off' }]
		const fetchMock = vi.fn(async (url: string | URL) => {
			const path = String(url)
			const json = (body: unknown) =>
				new Response(JSON.stringify(body), { status: 200 })
			if (path.includes('/pos/discount-rules')) {
				return json({ discountRules: rules })
			}
			if (path.includes('/resources/sites/menu')) return json(demo.menu)
			return json(demo.organization)
		})
		vi.stubGlobal('fetch', fetchMock)
		try {
			const settings = {
				...loadSettings(),
				demo: false,
				appUrl: 'https://app.test',
				slug: 'acme',
				tenantApiUrl: 'https://region.test',
				deviceToken: 'device',
			}
			const result = await refreshCatalog(settings)
			expect(result.ok).toBe(true)
			if (!result.ok) return
			expect(Array.isArray(result.snapshot.menu.discountRules)).toBe(true)
			expect(result.snapshot.menu.discountRulesAt).toBeTypeOf('number')
			expect(tillRulesStatus(result.snapshot).state).toBe('fresh')
		} finally {
			vi.unstubAllGlobals()
			await db.catalog.clear()
		}
	})

	/** A refresh whose menu answers but whose rules fetch fails, over a stored catalog. */
	async function refreshKeepingRules(stored: {
		rules: unknown[]
		rulesAt: number
	}) {
		const demo = demoCatalog()
		await db.catalog.put({
			...demo,
			fetchedAt: stored.rulesAt,
			menu: {
				...demo.menu,
				discountRules: stored.rules,
				discountRulesAt: stored.rulesAt,
			},
		})
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) => {
				const path = String(url)
				if (path.includes('/pos/discount-rules')) {
					return new Response('{}', { status: 503 })
				}
				const body = path.includes('/resources/sites/menu')
					? demo.menu
					: demo.organization
				return new Response(JSON.stringify(body), { status: 200 })
			}),
		)
		try {
			return await refreshCatalog({
				...loadSettings(),
				demo: false,
				appUrl: 'https://app.test',
				slug: 'acme',
				tenantApiUrl: 'https://region.test',
				deviceToken: 'device',
			})
		} finally {
			vi.unstubAllGlobals()
			await db.catalog.clear()
		}
	}

	it('keeps the old rules with their own stamp when the rules fetch fails', async () => {
		const rulesAt = Date.now() - 25 * 60 * 60 * 1000
		const result = await refreshKeepingRules({ rules: [{ id: 'd1' }], rulesAt })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		// The new catalog is fresh; its rules are as old as when they came.
		expect(result.snapshot.menu.discountRulesAt).toBe(rulesAt)
		expect(tillRulesStatus(result.snapshot)).toMatchObject({
			state: 'expired',
			cause: 'age',
		})
	})

	it('never lets carried rules take the new catalog time, even with a zero stamp', async () => {
		const result = await refreshKeepingRules({
			rules: [{ id: 'd1' }],
			rulesAt: 0,
		})
		if (!result.ok) throw new Error('refresh failed')
		expect(result.snapshot.menu.discountRulesAt).toBe(0)
		expect(tillRulesStatus(result.snapshot).state).toBe('expired')
	})

	it('keeps carried rules from the future off: the clock moved back since', async () => {
		const result = await refreshKeepingRules({
			rules: [{ id: 'd1' }],
			rulesAt: Date.now() + 60 * 60 * 1000,
		})
		if (!result.ok) throw new Error('refresh failed')
		expect(tillRulesStatus(result.snapshot)).toMatchObject({
			state: 'expired',
			cause: 'clock',
		})
	})
})

describe('Station channel filtering (#220)', () => {
	it('requests channel=pos when refreshing catalog from App', async () => {
		const demo = demoCatalog()
		const seenUrls: string[] = []
		const fetchMock = vi.fn(async (url: string | URL) => {
			seenUrls.push(String(url))
			if (String(url).includes('/pos/discount-rules')) {
				return new Response(JSON.stringify({ discountRules: [] }), {
					status: 200,
				})
			}
			if (String(url).includes('/resources/sites/menu')) {
				return new Response(JSON.stringify(demo.menu), { status: 200 })
			}
			return new Response(JSON.stringify(demo.organization), { status: 200 })
		})
		vi.stubGlobal('fetch', fetchMock)
		try {
			const result = await refreshCatalog({
				...loadSettings(),
				demo: false,
				appUrl: 'https://app.test',
				slug: 'acme',
			})
			expect(result.ok).toBe(true)
			const menuUrl = seenUrls.find((u) => u.includes('/resources/sites/menu'))
			expect(menuUrl).toBeTruthy()
			expect(new URL(menuUrl!).searchParams.get('channel')).toBe('pos')
		} finally {
			vi.unstubAllGlobals()
			await db.catalog.clear()
		}
	})

	it('keeps till-only dishes, hides web-only and pos-off categories, and applies location channel overrides', () => {
		const m = menu()
		const mains = m.menus[0]!.categories.find((c) => c.id === 'c-mains')!
		mains.items.push(
			{
				...mains.items[0]!,
				id: 'i-till-only',
				displayName: 'Till Secret',
				channels: ['pos'],
			},
			{
				...mains.items[0]!,
				id: 'i-web-only',
				displayName: 'Web Only',
				channels: ['web', 'qr', 'app'],
			},
		)
		m.menus[0]!.categories.push({
			id: 'c-web-cat',
			displayName: 'Web Category',
			availabilityStatus: 'available',
			channels: ['web'],
			position: 99,
			items: [
				{
					...mains.items[0]!,
					id: 'i-in-web-cat',
					displayName: 'In Web Cat',
					channels: ['web', 'qr', 'pos', 'app'],
				},
			],
		})
		m.locationOverrides = {
			...m.locationOverrides,
			'loc-1': [
				{
					entityType: 'item',
					entityId: 'i-till-only',
					channels: ['web'],
				},
			],
			'loc-2': [],
		}
		const loc1Items = buildCategories(m, 'loc-1').flatMap((c) =>
			categoryItems(c).map((i) => i.id),
		)
		expect(loc1Items).not.toContain('i-till-only')
		expect(loc1Items).not.toContain('i-web-only')
		expect(loc1Items).not.toContain('i-in-web-cat')

		const loc2Items = buildCategories(m, 'loc-2').flatMap((c) =>
			categoryItems(c).map((i) => i.id),
		)
		expect(loc2Items).toContain('i-till-only')
		expect(loc2Items).not.toContain('i-web-only')
		expect(loc2Items).not.toContain('i-in-web-cat')
	})
})
