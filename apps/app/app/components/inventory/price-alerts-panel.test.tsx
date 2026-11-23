// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type PriceAlerts } from '@repo/inventory'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeAll, describe, expect, it } from 'vitest'
import { type InventoryQuery } from '#app/hooks/use-inventory-client.ts'
import {
	PriceAlertsPanel,
	type PriceAlertMenuDish,
} from './price-alerts-panel.tsx'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function makeQuery(data: PriceAlerts): InventoryQuery<PriceAlerts> {
	return {
		data,
		loading: false,
		refreshing: false,
		error: null,
		reload: () => {},
	}
}

describe('PriceAlertsPanel (#520)', () => {
	it('renders affected dishes with old/new food cost %, target price, target-crossing highlight, and menu editor link', () => {
		const dishes: PriceAlertMenuDish[] = [
			// Selling price SAR 20.00 (2000 minor):
			// old cost 560 -> 28.0% (<= 30% target), new cost 660 -> 33.0% (> 30% target) => Crossed target!
			{ id: 'dish_crossing', name: 'Classic Burger', price: 20 },
			// Selling price SAR 25.00 (2500 minor):
			// old cost 500 -> 20.0%, new cost 625 -> 25.0% (<= 30% target) => Under target
			{ id: 'dish_under', name: 'Garden Salad', price: 25 },
			// Selling price SAR 10.00 (1000 minor):
			// old cost 350 -> 35.0% (> 30%), new cost 420 -> 42.0% (> 30%) => Already over target
			{ id: 'dish_already_over', name: 'Cheese Fries', price: 10 },
		]
		const data: PriceAlerts = {
			locationId: 'main',
			days: 30,
			thresholdBp: 500,
			currency: 'SAR',
			alerts: [
				{
					itemId: 'item_beef',
					itemName: 'Beef patty',
					supplierId: 'sup_1',
					supplierName: 'Prime Meats',
					deliveryId: 'del_1',
					deliveredAt: 1000,
					previousCostMicro: 2_000_000,
					costMicro: 2_400_000,
					changeBp: 2000,
					severity: 'big',
					packName: 'Box',
					previousPackPriceMinor: 20_000,
					packPriceMinor: 24_000,
					affectedDishes: 3,
					targetFoodCostBp: 3000,
					pricesIncludeTax: false,
					taxRateBp: null,
					dishes: [
						{
							menuItemId: 'dish_crossing',
							variantId: null,
							previousCostMinor: 560,
							costMinor: 660,
							priceForTargetMinor: 2200,
						},
						{
							menuItemId: 'dish_under',
							variantId: null,
							previousCostMinor: 500,
							costMinor: 625,
							priceForTargetMinor: 2083,
						},
						{
							menuItemId: 'dish_already_over',
							variantId: null,
							previousCostMinor: 350,
							costMinor: 420,
							priceForTargetMinor: 1400,
						},
					],
				},
			],
		}

		render(
			<MemoryRouter>
				<I18nProvider i18n={i18n}>
					<PriceAlertsPanel
						query={makeQuery(data)}
						orgSlug="acme"
						basePath="/acme/inventory/purchasing"
						search=""
						currency="SAR"
						dishes={dishes}
					/>
				</I18nProvider>
			</MemoryRouter>,
		)

		const dishList = screen.getByTestId('price-alert-dishes-item_beef')
		expect(dishList).toBeInTheDocument()

		// Crossing target dish
		const crossingRow = within(dishList).getByTestId(
			'price-alert-dish-dish_crossing',
		)
		expect(crossingRow).toHaveTextContent('Classic Burger')
		expect(
			within(crossingRow).getByTestId(
				'price-alert-dish-food-cost-dish_crossing',
			),
		).toHaveTextContent('28% → 33%')
		expect(
			within(crossingRow).getByTestId(
				'price-alert-dish-target-price-dish_crossing',
			),
		).toHaveTextContent('22.00')
		expect(
			within(crossingRow).getByTestId(
				'price-alert-dish-over-target-dish_crossing',
			),
		).toHaveTextContent('Crossed target')
		expect(
			within(crossingRow).getByTestId('price-alert-dish-link-dish_crossing'),
		).toHaveAttribute('href', '/acme/menu/items/dish_crossing')
		expect(
			within(crossingRow).getByTestId(
				'price-alert-dish-edit-price-dish_crossing',
			),
		).toHaveAttribute('href', '/acme/menu/items/dish_crossing')

		// Under target dish has no over-target badge
		const underRow = within(dishList).getByTestId('price-alert-dish-dish_under')
		expect(underRow).toHaveTextContent('Garden Salad')
		expect(
			within(underRow).getByTestId('price-alert-dish-food-cost-dish_under'),
		).toHaveTextContent('20% → 25%')
		expect(
			within(underRow).queryByTestId('price-alert-dish-over-target-dish_under'),
		).toBeNull()

		// Already over target dish has Over target badge
		const overRow = within(dishList).getByTestId(
			'price-alert-dish-dish_already_over',
		)
		expect(
			within(overRow).getByTestId(
				'price-alert-dish-over-target-dish_already_over',
			),
		).toHaveTextContent('Over target')
	})
})
