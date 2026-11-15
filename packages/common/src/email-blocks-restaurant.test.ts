import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
	EMAIL_COUPON_BUTTON_PATH,
	emailImageUrl,
	emailSiteUrl,
	menuItemChanges,
	orderButtonLabel,
	restaurantBlockProblems,
	type EmailMenuItemBlock,
} from './email-blocks-restaurant.ts'
import {
	emailBlocksSchema,
	getDefaultEmailBlock,
	parseEmailBlocks,
} from './email-blocks.ts'

function dishBlock(overrides: Partial<EmailMenuItemBlock['config']> = {}) {
	return {
		id: 'block-dish',
		type: 'menu_item' as const,
		config: {
			itemIds: ['item-1'],
			locationId: null,
			showPrice: true,
			showDescription: true,
			snapshot: {
				resolvedAt: '2026-11-15T00:00:00.000Z',
				items: [
					{
						itemId: 'item-1',
						name: 'Brisket <b>sandwich</b>',
						description: 'Smoked 12 hours',
						priceMinor: 1250,
						currency: 'USD',
						imageUrl: 'https://app.test/resources/images?objectKey=a.png',
						path: '/menu?item=item-1',
					},
				],
			},
			...overrides,
		},
	} satisfies EmailMenuItemBlock
}

describe('restaurant email blocks', () => {
	it('round-trips menu_item and coupon blocks through the schema', () => {
		const blocks = [dishBlock(), getDefaultEmailBlock('coupon')]
		const parsed = emailBlocksSchema.parse(JSON.parse(JSON.stringify(blocks)))
		expect(parsed).toEqual(blocks)
		expect(parseEmailBlocks(JSON.stringify(blocks))).toHaveLength(2)
	})

	it('caps a dish row at three and refuses absolute order paths', () => {
		const four = dishBlock({ itemIds: ['a', 'b', 'c', 'd'] })
		expect(emailBlocksSchema.safeParse([four]).success).toBe(false)
		const evil = dishBlock()
		evil.config.snapshot.items[0]!.path = '//evil.test/x'
		expect(emailBlocksSchema.safeParse([evil]).success).toBe(false)
	})

	it('never echoes stored values in validation errors', () => {
		const evil = dishBlock()
		evil.config.snapshot.items[0]!.path = '//secret-host.test/x'
		const result = emailBlocksSchema.safeParse([evil])
		expect(result.success).toBe(false)
		expect(JSON.stringify(result.error?.issues)).not.toContain('secret-host')
	})

	it('flags a changed price or a dish that left the menu', () => {
		const block = dishBlock()
		expect(
			menuItemChanges(block, new Map([['item-1', { priceMinor: 1250 }]])),
		).toEqual([])
		expect(
			menuItemChanges(block, new Map([['item-1', { priceMinor: 1400 }]])),
		).toEqual([{ blockId: 'block-dish', itemId: 'item-1', kind: 'price' }])
		expect(menuItemChanges(block, new Map())).toEqual([
			{ blockId: 'block-dish', itemId: 'item-1', kind: 'unavailable' },
		])
	})

	it('reports empty dish and coupon blocks', () => {
		expect(
			restaurantBlockProblems(dishBlock({ itemIds: [], snapshot: null }), {
				hasCoupon: false,
			}),
		).toEqual([{ blockId: 'block-dish', code: 'empty_menu_item' }])
		expect(restaurantBlockProblems(dishBlock(), { hasCoupon: false })).toEqual(
			[],
		)
		const coupon = getDefaultEmailBlock('coupon')
		if (coupon.type !== 'coupon') throw new Error('expected coupon')
		expect(restaurantBlockProblems(coupon, { hasCoupon: false })).toEqual([
			{ blockId: coupon.id, code: 'empty_coupon' },
		])
		expect(restaurantBlockProblems(coupon, { hasCoupon: true })).toEqual([])
	})

	it('builds links only on the organization origin', () => {
		const context = { siteOrigin: 'https://acme.menuza.test/' }
		expect(emailSiteUrl(context, '/menu?item=1')).toBe(
			'https://acme.menuza.test/menu?item=1',
		)
		expect(emailSiteUrl(context, '//evil.test')).toBe('')
		expect(emailSiteUrl(context, 'https://evil.test')).toBe('')
		expect(emailSiteUrl({ siteOrigin: null }, '/menu')).toBe('')
		expect(emailSiteUrl({ siteOrigin: 'javascript:alert(1)' }, '/menu')).toBe(
			'',
		)
		expect(EMAIL_COUPON_BUTTON_PATH).toBe('/menu?coupon={{couponCode}}')
	})

	it('transforms photos at 2x of the column width', () => {
		const src = 'https://app.test/resources/images?objectKey=a.png'
		expect(emailImageUrl(src, { columns: 1, transformBase: null })).toBe(src)
		expect(
			emailImageUrl(src, {
				columns: 1,
				transformBase: 'https://cdn.test/',
			}),
		).toBe(
			'https://cdn.test/cdn-cgi/image/width=1120,format=jpeg,quality=85/resources/images?objectKey=a.png',
		)
		expect(
			emailImageUrl(src, { columns: 3, transformBase: 'https://cdn.test' }),
		).toContain('width=373,')
	})

	it('labels the Order button in the email language', () => {
		expect(orderButtonLabel('en')).toBe('Order')
		expect(orderButtonLabel('ar-SA')).toBe('اطلب')
		expect(orderButtonLabel('xx')).toBe('Order')
	})

	it('keeps menu words out of the generic block core', () => {
		const core = readFileSync(
			new URL('./email-blocks.ts', import.meta.url),
			'utf8',
		)
		// Comments and the one registration (import, spread, re-export) may name
		// the vertical; nothing else in the core may.
		const stripped = core
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '')
			.replace(/import \{[^}]*\} from '\.\/email-blocks-restaurant\.ts'/, '')
			.replace(
				/EMAIL_RESTAURANT_BLOCK_TYPES|emailRestaurantBlockSchemas|getDefaultRestaurantEmailBlock|EmailCouponBlock|EmailMenuItemBlock/g,
				'',
			)
		expect(stripped).not.toMatch(/menu_item|\bdish\b|restaurant|coupon/i)
	})
})
