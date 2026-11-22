/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { indexCatalog } from './catalog.ts'
import {
	buildChannelMenuCategories,
	buildChannelUpsellCategories,
	syncMenuCatalogInPlace,
	syncMenuDomForChannel,
} from './menu-channel.ts'
// eslint-disable-next-line import/consistent-type-specifier-style
import type { PublicSiteMenuPayload } from '~/lib/org'

/** #394 and #192: the focal point and photo B travel through every mapping. */

function item(
	id: string,
	extra: Record<string, unknown>,
	channels: string[] = ['web', 'qr'],
) {
	return {
		id,
		displayName: id,
		internalName: null,
		description: null,
		price: 10,
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
		channels,
		position: 0,
		modifierGroups: [],
		...extra,
	}
}

function payload(): PublicSiteMenuPayload {
	return {
		organization: {
			id: 'org_1',
			name: 'Cafe',
			slug: 'cafe',
			currency: 'USD',
			defaultLocale: 'en',
			locales: ['en'],
		},
		locations: [],
		menus: [
			{
				id: 'menu_1',
				displayName: 'Main',
				internalName: null,
				menuType: 'regular',
				nutritionalInfo: false,
				specialInstructions: true,
				availabilityStatus: 'available',
				channels: ['web', 'qr'],
				position: 0,
				categories: [
					{
						id: 'cat_a',
						displayName: 'Mains',
						internalName: null,
						description: null,
						upsellCategoryIds: [],
						availabilityStatus: 'available',
						channels: ['web', 'qr'],
						position: 0,
						items: [
							item('tested', {
								imageUrl: '/a.jpg',
								imageFocal: { x: 0, y: 0 },
								photoTest: {
									id: 'test_abcdefgh',
									imageUrlB: '/b.jpg',
									imageFocalB: { x: 1, y: 1 },
								},
							}),
							item('plain', { imageUrl: '/plain.jpg' }),
							item(
								'qr_only',
								{
									imageUrl: '/fries.jpg',
									imageFocal: { x: 0, y: 0 },
									photoTest: {
										id: 'test_qrqrqrqr',
										imageUrlB: '/fries-b.jpg',
										imageFocalB: null,
									},
								},
								['qr'],
							),
							item('qr_plain', { imageUrl: '/pitcher.jpg' }, ['qr']),
						],
					},
				],
			},
		],
	} as unknown as PublicSiteMenuPayload
}

const mapping = (channel: 'web' | 'qr') => ({
	channel,
	locationId: null,
	locale: 'en',
	defaultLocale: 'en',
	resolveImageUrl: (src: string | null | undefined) =>
		src ? `https://cdn.test${src}` : null,
})

const domOptions = {
	formatMoney: (n: number) => `$${n}`,
	fromLabel: 'From',
	soldOutLabel: 'Sold out',
	popularLabel: 'Popular',
}

describe('payload to catalog', () => {
	it('keeps photo A as imageUrl and carries the focal point and photo B', () => {
		const tested = buildChannelMenuCategories(
			payload(),
			mapping('web'),
		)[0]!.items.find((entry) => entry.id === 'tested')!
		expect(tested.imageUrl).toBe('https://cdn.test/a.jpg')
		expect(tested.imageFocal).toEqual({ x: 0, y: 0 })
		expect(tested.photoTest).toEqual({
			id: 'test_abcdefgh',
			imageUrlB: 'https://cdn.test/b.jpg',
			imageFocalB: { x: 1, y: 1 },
		})
	})

	it('leaves a dish with no focal point and no test untouched', () => {
		const plain = buildChannelMenuCategories(
			payload(),
			mapping('web'),
		)[0]!.items.find((entry) => entry.id === 'plain')!
		expect(plain.imageFocal).toBeUndefined()
		expect(plain.photoTest).toBeUndefined()
	})

	it('carries both into the upsell mapping', () => {
		const tested = buildChannelUpsellCategories(
			payload(),
			mapping('web'),
		)[0]!.items.find((entry) => entry.id === 'tested')!
		expect(tested.imageFocal).toEqual({ x: 0, y: 0 })
		expect(tested.photoTest?.imageUrlB).toBe('https://cdn.test/b.jpg')
	})
})

describe('client-built menu cards', () => {
	function build() {
		const web = buildChannelMenuCategories(payload(), mapping('web'))
		const qr = buildChannelMenuCategories(payload(), mapping('qr'))
		document.body.innerHTML = `
			<div id="menu-catalog-grid"><div data-menu-categories>
				<section id="category-cat_a" data-category-section><ul class="grid"></ul></section>
			</div></div>`
		syncMenuCatalogInPlace(indexCatalog(web), qr)
		syncMenuDomForChannel(document, qr, domOptions)
	}
	const photo = (id: string) =>
		document.querySelector<HTMLImageElement>(
			`.js-item-card[data-item-id="${id}"] img`,
		)!

	it('crops at the focal point and marks the photo for the test', () => {
		build()
		const img = photo('qr_only')
		expect(img.style.objectPosition).toBe('0% 0%')
		expect(img.getAttribute('src')).toBe('https://cdn.test/fries.jpg')
		expect(img.dataset.photoTestId).toBe('test_qrqrqrqr')
		expect(img.dataset.photoTestItem).toBe('qr_only')
		expect(img.dataset.photoTestSrcB).toBe('https://cdn.test/fries-b.jpg')
		expect(img.dataset.photoTestFocalB).toBe('')
	})

	it('keeps the default crop and no markers without a focal point or test', () => {
		build()
		const img = photo('qr_plain')
		expect(img.getAttribute('style')).toBeNull()
		expect(img.dataset.photoTestId).toBeUndefined()
	})
})
