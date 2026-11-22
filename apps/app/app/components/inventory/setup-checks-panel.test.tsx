// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { SetupChecksPanel } from './setup-checks-panel.tsx'

const evidence = {
	supplierProductId: 'sp1',
	supplierId: 's1',
	supplierName: 'Al Watania',
	itemId: 'i1',
	itemName: 'Salt',
	packName: 'Bag',
	packBaseQuantity: 1_000_000,
	baseUnit: 'g' as const,
	priceMinor: 100,
	currency: 'SAR',
}

const FINDINGS = [
	{
		kind: 'price_placeholder' as const,
		key: 'price_placeholder:sp1',
		fingerprint: '100:1000000',
		fix: {
			kind: 'open_supplier_product' as const,
			supplierId: 's1',
			supplierProductId: 'sp1',
		},
		...evidence,
	},
	{
		kind: 'recipe_archived_item' as const,
		key: 'recipe_archived_item:menu_item:d1:i2',
		fingerprint: 'r1:9',
		fix: {
			kind: 'open_recipe' as const,
			ownerKind: 'menu_item' as const,
			ownerId: 'd1',
			lineItemId: 'i2',
		},
		ownerKind: 'menu_item' as const,
		ownerId: 'd1',
		itemId: 'i2',
		itemName: 'Parsley',
	},
	{
		kind: 'item_no_area' as const,
		key: 'item_no_area:i3:main',
		fingerprint: '1:2',
		fix: { kind: 'apply' as const },
		itemId: 'i3',
		itemName: 'Lamb',
		locationId: 'main',
		suggestedAreaId: 'a1',
		suggestedAreaName: 'Walk-in',
	},
]

function draw(findings = FINDINGS, limit?: number) {
	const request = vi.fn<InventoryClient['request']>(async (path) => {
		if (path.startsWith('/setup-checks?')) return { findings, dismissed: 0 }
		if (path === '/setup-checks/fix') return { fixed: true }
		if (path === '/setup-checks/dismiss') return { dismissed: true }
		throw new Error(`unexpected ${path}`)
	})
	renderInventory(
		<SetupChecksPanel
			orgSlug="acme"
			locationId="main"
			names={{
				dishes: new Map([['d1', 'Tabbouleh']]),
				options: new Map(),
			}}
			currency="SAR"
			limit={limit}
			seeAllHref="/acme/inventory/setup-check"
			canEdit
			canManagePurchasing
		/>,
		{ request },
	)
	return request
}

describe('Check your setup (#510)', () => {
	it('flags a supplier product priced 1.00 with its evidence', async () => {
		draw()
		const row = await screen.findByTestId('setup-check-price_placeholder')
		expect(row).toHaveTextContent('Salt')
		expect(row).toHaveTextContent('Al Watania')
		expect(row).toHaveTextContent('placeholder')
	})

	it('opens the recipe with the archived ingredient selected', async () => {
		draw()
		const link = await screen.findByTestId(
			'setup-check-open-recipe_archived_item',
		)
		expect(link).toHaveAttribute('href', '/acme/menu/items/d1?recipeLine=i2')
		expect(
			screen.getByTestId('setup-check-recipe_archived_item'),
		).toHaveTextContent('Tabbouleh uses Parsley, which is archived.')
	})

	it('applies a fix on the server with the finding it showed', async () => {
		const user = userEvent.setup()
		const request = draw()
		await user.click(await screen.findByTestId('setup-check-fix-item_no_area'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([path]) => path === '/setup-checks/fix'),
			).toBe(true),
		)
		const call = request.mock.calls.findIndex(
			([path]) => path === '/setup-checks/fix',
		)
		expect(sentJson(request, call)).toEqual({
			locationId: 'main',
			key: 'item_no_area:i3:main',
			fingerprint: '1:2',
		})
	})

	it('dismisses with "It\'s correct" and asks again afterwards', async () => {
		const user = userEvent.setup()
		const request = draw()
		const row = await screen.findByTestId('setup-check-price_placeholder')
		await user.click(
			within(row).getByTestId('setup-check-dismiss-price_placeholder'),
		)
		await waitFor(() =>
			expect(
				request.mock.calls.some(([path]) => path === '/setup-checks/dismiss'),
			).toBe(true),
		)
		const call = request.mock.calls.findIndex(
			([path]) => path === '/setup-checks/dismiss',
		)
		expect(sentJson(request, call)).toMatchObject({
			key: 'price_placeholder:sp1',
			fingerprint: '100:1000000',
		})
		// The list is read again.
		await waitFor(() =>
			expect(
				request.mock.calls.filter(([path]) =>
					String(path).startsWith('/setup-checks?'),
				).length,
			).toBeGreaterThan(1),
		)
	})

	it('shows the first few on Today and links to the rest', async () => {
		draw(FINDINGS, 2)
		expect(await screen.findByTestId('setup-checks-see-all')).toHaveAttribute(
			'href',
			'/acme/inventory/setup-check',
		)
		expect(
			within(screen.getByTestId('setup-checks-list')).getAllByRole('listitem'),
		).toHaveLength(2)
	})

	it('says nothing on Today when nothing needs a look, and reassures on the page', async () => {
		const { unmount } = (() => {
			draw([], 3)
			return { unmount: () => {} }
		})()
		await waitFor(() =>
			expect(screen.queryByTestId('setup-checks')).not.toBeInTheDocument(),
		)
		unmount()
	})
})
