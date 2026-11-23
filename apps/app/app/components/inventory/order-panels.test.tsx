// @vitest-environment jsdom
import { type SuggestedOrders } from '@repo/inventory'
import { screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { SuggestedOrdersPanel } from '#app/components/inventory/order-panels.tsx'
import { type InventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { renderInventory } from '#tests/inventory-render.tsx'

function makeQuery(data: SuggestedOrders): InventoryQuery<SuggestedOrders> {
	return {
		data,
		error: null,
		loading: false,
		refreshing: false,
		reload: vi.fn(),
	}
}

function makeSuggestedOrders(
	overrides: Partial<SuggestedOrders> = {},
): SuggestedOrders {
	return {
		locationId: 'main',
		generatedAt: Date.UTC(2026, 10, 20, 9),
		unsourced: [],
		toOrderItems: 1,
		suppliers: [
			{
				supplierId: 's1',
				supplierName: 'Al Watania',
				orderChannel: 'email',
				expectedDate: '2026-11-23',
				cutoff: { date: '2026-11-22', time: '16:00' },
				cutoffPassed: false,
				draftOrderId: null,
				lineCount: 1,
				currency: 'SAR',
				totalMinor: 56_000,
				minimumOrderMinor: 100_000,
				belowMinimum: true,
				unpricedLines: 0,
				lines: [
					{
						itemId: 'i1',
						itemName: 'Chicken thighs',
						baseUnit: 'g',
						countUnit: 'kg',
						onHand: 6_000_000,
						onOrderQuantity: 2_000_000,
						orderBelowQuantity: 10_000_000,
						fillUpToQuantity: 30_000_000,
						status: 'low',
						supplierProductId: 'sp1',
						packName: 'Box',
						packBaseQuantity: 10_000_000,
						pricedByWeight: false,
						packs: 3,
						quantity: 30_000_000,
						packPriceMinor: 28_000,
						lineTotalMinor: 84_000,
						explanation: {
							onHandQuantity: 6_000_000,
							lastCountedAt: Date.UTC(2026, 10, 5, 9),
							onOrderQuantity: 2_000_000,
							orderBelowQuantity: 10_000_000,
							fillUpToQuantity: 30_000_000,
							expectedUseUntilDeliveryQuantity: 4_000_000,
							neededQuantity: 22_000_000,
							packName: 'Box',
							packBaseQuantity: 10_000_000,
							rawPacksMilli: 2_200,
							roundedPacksMilli: 3_000,
							warnings: {
								notCountedIn10Days: true,
								priceChangedSinceLastOrder: true,
								belowSupplierMinimum: true,
							},
							previousOrderPackPriceMinor: 25_000,
							currentPackPriceMinor: 28_000,
						},
					},
				],
			},
		],
		...overrides,
	}
}

describe('SuggestedOrdersPanel: explanation and warnings (#497)', () => {
	it('shows line explanation popover and cost-gated warnings on suggested cards', async () => {
		const request = vi.fn<InventoryClient['request']>()
		renderInventory(
			<SuggestedOrdersPanel
				query={makeQuery(makeSuggestedOrders())}
				orgSlug="acme"
				locationId="main"
				search=""
				canSeeCost={true}
				canManagePurchasing={true}
				currency="SAR"
				suppliersHref="/acme/inventory/suppliers"
				onChanged={vi.fn()}
			/>,
			{ request },
		)

		expect(await screen.findByTestId('suggested-lines-s1')).toBeInTheDocument()
		expect(screen.getByTestId('order-line-warn-stale-i1')).toHaveTextContent(
			'Not counted in 10 days',
		)
		expect(screen.getByTestId('order-line-warn-price-i1')).toHaveTextContent(
			'Price changed since the last order',
		)
		expect(screen.getByTestId('order-line-warn-min-i1')).toHaveTextContent(
			"Below the supplier's minimum",
		)

		await userEvent.click(screen.getByTestId('order-line-info-i1'))
		const pop = await screen.findByTestId('order-line-explanation-i1')
		expect(pop).toHaveTextContent('6 kg')
		expect(pop).toHaveTextContent('2 kg')
		expect(pop).toHaveTextContent('10 kg')
		expect(pop).toHaveTextContent('30 kg')
		expect(pop).toHaveTextContent('4 kg')
		expect(pop).toHaveTextContent('22 kg')
		expect(pop).toHaveTextContent('2.2')
		expect(pop).toHaveTextContent('3 packs')
		expect(pop).toHaveTextContent('250')
		expect(pop).toHaveTextContent('280')
	})

	it('never shows money or cost warnings when canSeeCost is false', async () => {
		const request = vi.fn<InventoryClient['request']>()
		const base = makeSuggestedOrders()
		const supplier = {
			...base.suppliers[0]!,
			currency: undefined,
			totalMinor: undefined,
			minimumOrderMinor: undefined,
			belowMinimum: undefined,
			lines: [
				{
					...base.suppliers[0]!.lines[0]!,
					packPriceMinor: undefined,
					lineTotalMinor: undefined,
					explanation: {
						...base.suppliers[0]!.lines[0]!.explanation!,
						previousOrderPackPriceMinor: undefined,
						currentPackPriceMinor: undefined,
						warnings: {
							notCountedIn10Days: true,
							priceChangedSinceLastOrder: false,
							belowSupplierMinimum: false,
						},
					},
				},
			],
		}
		renderInventory(
			<SuggestedOrdersPanel
				query={makeQuery({ ...base, suppliers: [supplier] })}
				orgSlug="acme"
				locationId="main"
				search=""
				canSeeCost={false}
				canManagePurchasing={true}
				currency="SAR"
				suppliersHref="/acme/inventory/suppliers"
				onChanged={vi.fn()}
			/>,
			{ request },
		)

		expect(
			await screen.findByTestId('order-line-warn-stale-i1'),
		).toHaveTextContent('Not counted in 10 days')
		expect(screen.queryByTestId('order-line-warn-price-i1')).toBeNull()
		expect(screen.queryByTestId('order-line-warn-min-i1')).toBeNull()
		expect(screen.getByTestId('suggested-s1').textContent).not.toMatch(
			/\d{2,}[.,]\d{2}/,
		)

		await userEvent.click(screen.getByTestId('order-line-info-i1'))
		const pop = await screen.findByTestId('order-line-explanation-i1')
		expect(pop).toHaveTextContent('6 kg')
		expect(pop).not.toHaveTextContent('Last order')
		expect(pop).not.toHaveTextContent('SAR')
	})
})
