// @vitest-environment jsdom
import { type Compare } from '@repo/inventory'
import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { renderInventory } from '#tests/inventory-render.tsx'
import { ComparePanel } from './compare-panel.tsx'

const LOCATIONS = [
	{ id: 'main', name: 'Downtown' },
	{ id: 'kitchen', name: 'Central kitchen' },
]

const answer = (money: boolean): Compare => ({
	date: '2026-11-09',
	rows: [
		{
			locationId: 'main',
			lowItems: 3,
			outItems: 1,
			lastCountAt: null,
			wasteWeekCount: 4,
			incomingTransfers: 1,
			outgoingTransfers: 0,
			...(money
				? {
						stockValueMinor: 120_000,
						wasteWeekMinor: 3_500,
						foodCost: { state: 'ok' as const, bp: 3_100, targetBp: 3_000 },
						currency: 'SAR',
					}
				: {}),
		},
		{
			locationId: 'kitchen',
			lowItems: 0,
			outItems: 0,
			lastCountAt: Date.UTC(2026, 10, 1),
			wasteWeekCount: 0,
			incomingTransfers: 0,
			outgoingTransfers: 2,
			...(money
				? {
						stockValueMinor: 80_000,
						wasteWeekMinor: 0,
						foodCost: { state: 'need_two_counts' as const, targetBp: 3_000 },
						currency: 'SAR',
					}
				: {}),
		},
	],
})

const draw = (money: boolean) => {
	const request = vi.fn<InventoryClient['request']>(async () => answer(money))
	renderInventory(
		<ComparePanel
			locations={LOCATIONS}
			activeLocationId="main"
			canSeeCost={money}
			currency="SAR"
		/>,
		{ request },
	)
	return request
}

describe('ComparePanel', () => {
	it('asks for the places it shows and lays their numbers side by side', async () => {
		const request = draw(true)
		const main = await screen.findByTestId('compare-main')
		expect(request).toHaveBeenCalledWith('/compare?locationIds=main%2Ckitchen')
		expect(main).toHaveTextContent('Downtown')
		expect(within(main).getByTestId('compare-low')).toHaveTextContent('3')
		expect(within(main).getByTestId('compare-out')).toHaveTextContent('1')
		expect(within(main).getByText('Never counted')).toBeVisible()
		expect(within(main).getByTestId('compare-food-cost')).toHaveTextContent(
			'31%',
		)
		expect(main).toHaveTextContent('Moving stock')
		// The place being looked at has no Open link; the other one does.
		expect(within(main).queryByTestId('compare-open-main')).toBeNull()
		const kitchen = screen.getByTestId('compare-kitchen')
		expect(within(kitchen).getByTestId('compare-open-kitchen')).toHaveAttribute(
			'href',
			'/?locationId=kitchen',
		)
		expect(within(kitchen).getByTestId('compare-food-cost')).toHaveTextContent(
			'Needs two counts',
		)
	})

	it('leaves money out without the cost grant', async () => {
		draw(false)
		const main = await screen.findByTestId('compare-main')
		expect(main).not.toHaveTextContent('Stock value')
		expect(main).not.toHaveTextContent('Food cost')
	})
})
