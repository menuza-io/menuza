/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import { indexCatalog } from './catalog.ts'
import {
	buildChannelCheckoutSync,
	buildChannelMenuCategories,
	buildChannelUpsellCategories,
	buildSiteMenuFetchUrl,
	deriveSiteMenuChannel,
	filterOrderingCategoriesForChannel,
	isQrOrderingEnabled,
	posterQuerySource,
	resolveSiteQrOrdering,
	syncMenuCatalogInPlace,
	syncMenuDomForChannel,
} from './menu-channel.ts'
// Top-level `import type` prevents Vite from evaluating `org.ts` (`cloudflare:workers`) in jsdom tests.
// eslint-disable-next-line import/consistent-type-specifier-style
import type { PublicSiteMenuPayload } from '~/lib/org'

function makeMenuPayload(
	overrides: Partial<PublicSiteMenuPayload> = {},
): PublicSiteMenuPayload {
	return {
		organization: {
			id: 'org_1',
			name: 'Cafe',
			slug: 'cafe',
			currency: 'USD',
			defaultLocale: 'en',
			locales: ['en'],
		},
		locations: [
			{
				id: 'loc_1',
				name: 'Main',
				slug: 'main',
				phone: null,
				timezone: 'UTC',
				taxRate: 0,
				address: null,
				storeHours: [],
				onlineHours: [],
				specialHours: [],
				prepTime: 15,
				fulfillmentOptions: { pickup: true, delivery: true },
				inHouseTips: {},
				scheduling: {},
				deliveryConfig: {},
				deliveryZones: [],
				isDefault: true,
			},
		],
		menus: [
			{
				id: 'menu_1',
				displayName: 'Main Menu',
				internalName: null,
				menuType: 'regular',
				nutritionalInfo: false,
				specialInstructions: true,
				availabilityStatus: 'available',
				channels: ['web', 'qr'],
				position: 0,
				categories: [
					{
						id: 'cat_shared',
						displayName: 'Mains',
						internalName: null,
						description: null,
						upsellCategoryIds: ['cat_shared'],
						availabilityStatus: 'available',
						channels: ['web', 'qr'],
						position: 0,
						items: [
							{
								id: 'item_shared',
								displayName: 'Burger',
								internalName: null,
								description: 'Classic burger',
								price: 12,
								imageKey: null,
								imageUrl: null,
								imageKeys: [],
								imageUrls: [],
								variations: { groups: [], variants: [] },
								isAlcohol: false,
								isGlutenFree: false,
								isVegetarian: false,
								allergens: [],
								calorieMin: null,
								calorieMax: null,
								isPopular: true,
								isUpsell: false,
								availabilityStatus: 'available',
								channels: ['web', 'qr'],
								position: 0,
								modifierGroups: [],
							},
							{
								id: 'item_web_only',
								displayName: 'Web Box',
								internalName: null,
								description: null,
								price: 18,
								imageKey: null,
								imageUrl: null,
								imageKeys: [],
								imageUrls: [],
								variations: { groups: [], variants: [] },
								isAlcohol: false,
								isGlutenFree: false,
								isVegetarian: false,
								allergens: [],
								calorieMin: null,
								calorieMax: null,
								isPopular: true,
								isUpsell: true,
								availabilityStatus: 'available',
								channels: ['web'],
								position: 1,
								modifierGroups: [],
							},
							{
								id: 'item_qr_only',
								displayName: 'Table Fries',
								internalName: null,
								description: 'Hot fries',
								price: 6,
								imageKey: null,
								imageUrl: null,
								imageKeys: [],
								imageUrls: [],
								variations: { groups: [], variants: [] },
								isAlcohol: false,
								isGlutenFree: false,
								isVegetarian: false,
								allergens: [],
								calorieMin: null,
								calorieMax: null,
								isPopular: false,
								isUpsell: true,
								availabilityStatus: 'available',
								channels: ['qr'],
								position: 2,
								modifierGroups: [],
							},
						],
					},
					{
						id: 'cat_qr_only',
						displayName: 'Table Exclusives',
						internalName: null,
						description: null,
						upsellCategoryIds: [],
						availabilityStatus: 'available',
						channels: ['qr'],
						position: 1,
						items: [
							{
								id: 'item_qr_cat_dish',
								displayName: 'Table Pitcher',
								internalName: null,
								description: null,
								price: 15,
								imageKey: null,
								imageUrl: null,
								imageKeys: [],
								imageUrls: [],
								variations: { groups: [], variants: [] },
								isAlcohol: false,
								isGlutenFree: false,
								isVegetarian: false,
								allergens: [],
								calorieMin: null,
								calorieMax: null,
								isPopular: false,
								isUpsell: false,
								availabilityStatus: 'available',
								channels: ['qr'],
								position: 0,
								modifierGroups: [],
							},
						],
					},
				],
			},
		],
		...overrides,
	}
}

describe('menu channel derivation and sync (#220 / review #4)', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
	})

	it('derives channel using the same inputs as derivePublicOrderChannel including qr_ordering flag', () => {
		expect(deriveSiteMenuChannel({ atTable: true, qrOrdering: false })).toBe(
			'qr',
		)
		expect(
			deriveSiteMenuChannel({
				atTable: false,
				source: 'qr_poster',
				qrOrdering: { enabled: true, dineIn: false, online: false },
			}),
		).toBe('qr')
		expect(
			deriveSiteMenuChannel({
				atTable: false,
				source: 'qr_poster',
				qrOrdering: { enabled: false, dineIn: false, online: false },
			}),
		).toBe('web')
		expect(
			deriveSiteMenuChannel({
				atTable: false,
				source: 'qr_poster',
				qrOrdering: undefined,
			}),
		).toBe('web')
		expect(
			deriveSiteMenuChannel({
				atTable: false,
				source: null,
				qrOrdering: { enabled: true, dineIn: true, online: true },
			}),
		).toBe('web')

		expect(isQrOrderingEnabled(true)).toBe(true)
		expect(isQrOrderingEnabled(false)).toBe(false)
		expect(
			isQrOrderingEnabled({ enabled: true, dineIn: false, online: false }),
		).toBe(true)
		expect(resolveSiteQrOrdering(undefined)).toEqual({
			enabled: true,
			dineIn: true,
			online: true,
		})
		expect(resolveSiteQrOrdering({ qrOrdering: { enabled: false } })).toEqual({
			enabled: false,
		})
	})

	it('recognizes only qr_poster query params and ignores channel=qr / qr=1 / qr_table', () => {
		expect(posterQuerySource('?src=qr')).toBe('qr_poster')
		expect(posterQuerySource('?src=qr_poster')).toBe('qr_poster')
		expect(posterQuerySource('?channel=qr')).toBeNull()
		expect(posterQuerySource('?qr=1')).toBeNull()
		expect(posterQuerySource('?src=qr_table')).toBeNull()
	})

	it('builds channel-specific categories & upsells and filters existing categories client-side', () => {
		const payload = makeMenuPayload({
			locationOverrides: {
				loc_1: [
					{
						entityType: 'item',
						entityId: 'item_shared',
						channels: ['web'],
					},
				],
			},
		})
		const webCats = buildChannelMenuCategories(payload, {
			channel: 'web',
			locationId: 'loc_1',
			locale: 'en',
			defaultLocale: 'en',
			resolveImageUrl: (s) => s ?? null,
		})
		expect(webCats.map((c) => c.id)).toEqual(['cat_shared'])
		expect(webCats[0]!.items.map((i) => i.id)).toEqual([
			'item_shared',
			'item_web_only',
		])

		const qrCats = buildChannelMenuCategories(payload, {
			channel: 'qr',
			locationId: 'loc_1',
			locale: 'en',
			defaultLocale: 'en',
			resolveImageUrl: (s) => s ?? null,
		})
		expect(qrCats.map((c) => c.id)).toEqual(['cat_shared', 'cat_qr_only'])
		expect(qrCats[0]!.items.map((i) => i.id)).toEqual(['item_qr_only'])
		expect(qrCats[1]!.items.map((i) => i.id)).toEqual(['item_qr_cat_dish'])

		const filteredWebToQr = filterOrderingCategoriesForChannel(webCats, 'qr')
		expect(filteredWebToQr[0]!.items.map((i) => i.id)).toEqual(['item_shared'])

		const qrUpsells = buildChannelUpsellCategories(makeMenuPayload(), {
			channel: 'qr',
			locationId: 'loc_1',
			locale: 'en',
			defaultLocale: 'en',
			resolveImageUrl: (s) => s ?? null,
		})
		expect(qrUpsells[0]!.items.map((i) => i.id)).toEqual([
			'item_shared',
			'item_qr_only',
		])
	})

	it('syncs rendered menu DOM and catalog index when switching from web SSR to qr client-side', () => {
		const payload = makeMenuPayload()
		const webCats = buildChannelMenuCategories(payload, {
			channel: 'web',
			locationId: 'loc_1',
			locale: 'en',
			defaultLocale: 'en',
			resolveImageUrl: (s) => s ?? null,
		})
		const qrCats = buildChannelMenuCategories(payload, {
			channel: 'qr',
			locationId: 'loc_1',
			locale: 'en',
			defaultLocale: 'en',
			resolveImageUrl: (s) => s ?? null,
		})

		document.body.innerHTML = `
			<section data-popular-rail>
				<button class="js-popular-card" data-item-id="item_shared"></button>
				<button class="js-popular-card" data-item-id="item_web_only"></button>
			</section>
			<nav data-category-nav="chips">
				<a href="#category-cat_shared" data-category-id="cat_shared">Mains</a>
			</nav>
			<div id="menu-empty-catalog" class="hidden" hidden></div>
			<div id="menu-catalog-grid">
				<div data-menu-categories>
					<section id="category-cat_shared" data-category-section>
						<ul class="grid">
							<li class="js-item-card" data-item-id="item_shared"><button class="js-item-open">Burger</button></li>
							<li class="js-item-card" data-item-id="item_web_only"><button class="js-item-open">Web Box</button></li>
						</ul>
					</section>
				</div>
			</div>
		`

		const catalog = indexCatalog(webCats)
		expect(catalog.items.has('item_web_only')).toBe(true)
		expect(catalog.items.has('item_qr_only')).toBe(false)

		syncMenuCatalogInPlace(catalog, qrCats)
		syncMenuDomForChannel(document, qrCats, {
			formatMoney: (n) => `$${n.toFixed(2)}`,
			fromLabel: 'From',
			soldOutLabel: 'Sold out',
			popularLabel: 'Popular',
		})

		expect(catalog.items.has('item_web_only')).toBe(false)
		expect(catalog.items.has('item_qr_only')).toBe(true)
		expect(catalog.items.has('item_qr_cat_dish')).toBe(true)

		expect(
			document.querySelector('.js-item-card[data-item-id="item_web_only"]'),
		).toBeNull()
		expect(
			document.querySelector('.js-item-card[data-item-id="item_shared"]'),
		).not.toBeNull()
		expect(
			document.querySelector('.js-item-card[data-item-id="item_qr_only"]'),
		).not.toBeNull()
		expect(
			document.querySelector('#category-cat_qr_only[data-category-section]'),
		).not.toBeNull()
		expect(
			document.querySelector(
				'[data-category-nav="chips"] a[data-category-id="cat_qr_only"]',
			),
		).not.toBeNull()
		// Only 1 popular card remains on qr -> popular rail is hidden.
		expect(
			document.querySelector<HTMLElement>('[data-popular-rail]')?.hidden,
		).toBe(true)
	})

	it('builds menu fetch URL and checkout sync data for poster qr_ordering refetch', () => {
		expect(
			buildSiteMenuFetchUrl({
				appUrl: 'https://app.example.test/',
				slug: 'cafe',
				lng: 'en',
				locationId: 'loc_1',
				channel: 'qr',
			}),
		).toBe(
			'https://app.example.test/resources/sites/menu?slug=cafe&lng=en&locationId=loc_1&channel=qr',
		)

		const synced = buildChannelCheckoutSync(makeMenuPayload(), {
			channel: 'qr',
			locationId: 'loc_1',
			locale: 'en',
			defaultLocale: 'en',
			resolveImageUrl: (s) => s ?? null,
		})
		expect(synced.upsellCategories[0]!.items.map((i) => i.id)).toEqual([
			'item_shared',
			'item_qr_only',
		])
	})
})
