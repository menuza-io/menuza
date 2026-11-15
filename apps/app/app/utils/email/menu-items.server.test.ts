import { describe, expect, it, vi } from 'vitest'
import { type EmailBlock } from '@repo/common/email-blocks'
import {
	collectPickableMenuItems,
	resolveMenuItemBlocks,
	type PickableMenuItems,
} from './menu-items.server.ts'
import { type PublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'

const item = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	displayName: `Dish ${id}`,
	description: '  Smoked\n  for 12 hours  ',
	price: 12.5,
	imageKey: `org/${id}.png`,
	imageUrl: null,
	availabilityStatus: 'available',
	...over,
})

function payload(
	items: unknown[],
	extra: Partial<PublicSiteMenuPayload> = {},
	menu: Record<string, unknown> = {},
) {
	return {
		organization: { id: 'org', currency: 'USD' },
		locations: [
			{ id: 'loc-1', name: 'Downtown', currency: 'USD' },
			{ id: 'loc-2', name: 'Airport', currency: 'USD' },
		],
		menus: [
			{
				menuType: 'regular',
				availabilityStatus: 'available',
				categories: [{ items, subcategories: [] }],
				...menu,
			},
		],
		locationOverrides: {},
		...extra,
	} as unknown as PublicSiteMenuPayload
}

const options = { baseUrl: 'https://app.test', fallbackCurrency: 'USD' }

describe('collectPickableMenuItems', () => {
	it('lists live dishes with base prices, photo and an Order path', () => {
		const result = collectPickableMenuItems(payload([item('a')]), null, options)
		expect(result.items).toEqual([
			{
				itemId: 'a',
				name: 'Dish a',
				description: 'Smoked for 12 hours',
				priceMinor: 1250,
				currency: 'USD',
				imageUrl: 'https://app.test/resources/images?objectKey=org%2Fa.png',
				path: '/menu?item=a',
			},
		])
		expect(result.locations.map((l) => l.name)).toEqual(['Downtown', 'Airport'])
	})

	it('uses the chosen location price override', () => {
		const result = collectPickableMenuItems(
			payload([item('a')], {
				locationOverrides: {
					'loc-1': [{ entityType: 'item', entityId: 'a', price: 14 }],
				},
			}),
			'loc-1',
			options,
		)
		expect(result.items[0]?.priceMinor).toBe(1400)
		// No location: the base price.
		expect(
			collectPickableMenuItems(
				payload([item('a')], {
					locationOverrides: {
						'loc-1': [{ entityType: 'item', entityId: 'a', price: 14 }],
					},
				}),
				null,
				options,
			).items[0]?.priceMinor,
		).toBe(1250)
	})

	it('leaves out unavailable dishes, hidden ones, drops and offline menus', () => {
		const items = [
			item('ok'),
			item('sold-out', { availabilityStatus: 'unavailable' }),
			item('hidden'),
			item('held'),
		]
		const result = collectPickableMenuItems(
			payload(items, {
				locationOverrides: {
					'loc-1': [
						{ entityType: 'item', entityId: 'hidden', isEnabled: false },
						{
							entityType: 'item',
							entityId: 'held',
							availabilityStatus: 'unavailable',
						},
					],
				},
			}),
			'loc-1',
			options,
		)
		expect(result.items.map((i) => i.itemId)).toEqual(['ok'])
		expect(
			collectPickableMenuItems(
				payload([item('a')], {}, { menuType: 'drop' }),
				null,
				options,
			).items,
		).toEqual([])
		expect(
			collectPickableMenuItems(
				payload([item('a')], {}, { availabilityStatus: 'unavailable' }),
				null,
				options,
			).items,
		).toEqual([])
	})
})

describe('resolveMenuItemBlocks', () => {
	const catalog: PickableMenuItems = {
		items: [
			{
				itemId: 'a',
				name: 'Brisket',
				description: '',
				priceMinor: 1250,
				currency: 'USD',
				imageUrl: '',
				path: '/menu?item=a',
			},
		],
		locations: [{ id: 'loc-1', name: 'Downtown' }],
		currency: 'USD',
	}
	const listItems = vi.fn(async () => catalog)
	const block = (
		itemIds: string[],
		locationId: string | null = null,
	): EmailBlock => ({
		id: 'block-dish',
		type: 'menu_item',
		config: {
			itemIds,
			locationId,
			showPrice: true,
			showDescription: true,
			// A forged price from the browser is never trusted.
			snapshot: {
				resolvedAt: '',
				items: [
					{
						itemId: 'a',
						name: 'Forged',
						description: '',
						priceMinor: 1,
						currency: 'USD',
						imageUrl: '',
						path: '/menu?item=a',
					},
				],
			},
		},
	})
	const run = (blocks: EmailBlock[]) =>
		resolveMenuItemBlocks('org', blocks, 'https://app.test', {
			listItems,
			now: new Date('2026-11-15T00:00:00.000Z'),
		})

	it('re-reads dishes from the live menu and ignores the posted snapshot', async () => {
		const result = await run([block(['a'])])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const saved = result.blocks[0]
		if (saved?.type !== 'menu_item') throw new Error('expected menu_item')
		expect(saved.config.snapshot?.items[0]).toMatchObject({
			name: 'Brisket',
			priceMinor: 1250,
		})
		expect(saved.config.snapshot?.resolvedAt).toBe('2026-11-15T00:00:00.000Z')
	})

	it('refuses a dish that is not on the live menu with item_not_available', async () => {
		expect(await run([block(['a', 'gone'])])).toEqual({
			ok: false,
			error: 'item_not_available',
			blockId: 'block-dish',
		})
	})

	it('refuses a location that is not the organization’s', async () => {
		expect(await run([block(['a'], 'other-org-location')])).toMatchObject({
			ok: false,
			error: 'item_not_available',
		})
	})

	it('keeps a block with no dish empty so the pre-send check can refuse it', async () => {
		const result = await run([block([])])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const saved = result.blocks[0]
		if (saved?.type !== 'menu_item') throw new Error('expected menu_item')
		expect(saved.config.snapshot).toBeNull()
	})
})
