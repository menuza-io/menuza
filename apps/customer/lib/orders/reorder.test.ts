import { decodeReorderPayload } from '@repo/common/customer-orders'
import { reorderWebsiteUrl } from './reorder'

const reorder = {
	locationId: 'loc_1',
	fulfillment: 'pickup' as const,
	lines: [
		{
			itemId: 'item_1',
			variantId: null,
			quantity: 2,
			options: [{ groupId: 'g', optionId: 'o', quantity: 1, half: null }],
			instructions: 'for Alice, 12 Main St',
			name: 'Margherita',
		},
	],
}

describe('order again from the app (#112)', () => {
	it('opens the menu at the order’s location with ids in the fragment only', () => {
		const url = reorderWebsiteUrl('https://acme.menuza.io/menu', reorder)!
		const parsed = new URL(url)
		expect(parsed.origin + parsed.pathname).toBe('https://acme.menuza.io/menu')
		expect(parsed.searchParams.get('location')).toBe('loc_1')
		expect(parsed.search).not.toMatch(/item_1|Margherita|Alice/)
		const payload = new URLSearchParams(parsed.hash.slice(1)).get(
			'reorderlines',
		)
		expect(decodeReorderPayload(payload)).toMatchObject({
			locationId: 'loc_1',
			lines: [{ itemId: 'item_1', quantity: 2 }],
		})
		expect(url).not.toMatch(/Alice|Main St|Margherita/)
	})

	it('gives nothing for an unusable address', () => {
		expect(reorderWebsiteUrl('not a url', reorder)).toBeNull()
	})
})
