// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { PriceComparisonPanel } from '#app/components/inventory/price-comparison-panel.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

beforeEach(() => {
	vi.clearAllMocks()
})

const LOCATIONS = [
	{ id: 'loc_a', name: 'Riyadh Main' },
	{ id: 'loc_b', name: 'Jeddah Branch' },
]

const SAMPLE_REPORT = {
	from: '2026-08-26',
	to: '2026-11-23',
	currency: 'SAR',
	totalSavingMinor: 4_000,
	items: [
		{
			itemId: 'itm_1',
			itemName: 'Chicken breast',
			baseUnit: 'g',
			currency: 'SAR',
			entries: [
				{
					locationId: 'loc_a',
					supplierId: 'sup_1',
					supplierName: 'Al Watania',
					costMicro: 2_800_000,
					latestCostMicro: 2_800_000,
					latestPaidAt: Date.UTC(2026, 10, 10),
					quantity: 10_000_000,
					paidMinor: 28_000,
					deliveriesCount: 1,
					currency: 'SAR',
				},
				{
					locationId: 'loc_b',
					supplierId: 'sup_2',
					supplierName: 'Fresh Farms',
					costMicro: 3_200_000,
					latestCostMicro: 3_200_000,
					latestPaidAt: Date.UTC(2026, 10, 12),
					quantity: 10_000_000,
					paidMinor: 32_000,
					deliveriesCount: 1,
					currency: 'SAR',
				},
			],
			lowestCostMicro: 2_800_000,
			lowestLocationId: 'loc_a',
			lowestSupplierId: 'sup_1',
			lowestSupplierName: 'Al Watania',
			highestCostMicro: 3_200_000,
			highestLocationId: 'loc_b',
			highestSupplierId: 'sup_2',
			highestSupplierName: 'Fresh Farms',
			spreadCostMicro: 400_000,
			spreadBp: 1429,
			totalQuantity: 20_000_000,
			totalPaidMinor: 60_000,
			savingMinor: 4_000,
		},
	],
}

function renderPanel(
	request: InventoryClient['request'],
	{ canSeeCost = true }: { canSeeCost?: boolean } = {},
) {
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<InventoryChangeProvider>
					<PriceComparisonPanel
						locations={LOCATIONS}
						canSeeCost={canSeeCost}
						currency="SAR"
					/>
				</InventoryChangeProvider>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('PriceComparisonPanel (#508)', () => {
	it('renders prices across locations and suppliers, spread, and saving', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path) => {
			if (path.startsWith('/price-comparison')) return SAMPLE_REPORT
			throw new Error(`unexpected path ${path}`)
		})

		renderPanel(request, { canSeeCost: true })

		const totalSaving = await screen.findByTestId(
			'price-comparison-total-saving',
		)
		expect(totalSaving).toHaveTextContent('40.00')

		const row = screen.getByTestId('price-comparison-row-itm_1')
		expect(row).toHaveTextContent('Chicken breast')
		expect(row).toHaveTextContent('Riyadh Main · Al Watania')
		expect(row).toHaveTextContent('Jeddah Branch · Fresh Farms')
		expect(row).toHaveTextContent('28.00')
		expect(row).toHaveTextContent('32.00')
		expect(row).toHaveTextContent('4.00')
		expect(row).toHaveTextContent('14%')
		expect(row).toHaveTextContent('40.00')
		expect(within(row).getByText('Lowest')).toBeInTheDocument()
	})

	it('hides money and skips query when caller lacks cost grant', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => SAMPLE_REPORT)
		const { container } = renderPanel(request, { canSeeCost: false })

		const notice = await screen.findByTestId('price-comparison-no-cost')
		expect(notice).toBeInTheDocument()
		expect(request).not.toHaveBeenCalled()
		expect(container.textContent).not.toMatch(/SAR|USD|\d+\.\d{2}/)
	})

	it('shows permission notice with zero money figures if API responds 403', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => {
			throw new OperatorRequestError('forbidden', 'forbidden', 403)
		})
		const { container } = renderPanel(request, { canSeeCost: true })

		const notice = await screen.findByTestId('price-comparison-no-cost')
		expect(notice).toBeInTheDocument()
		expect(container.textContent).not.toMatch(/SAR|USD|\d+\.\d{2}/)
	})
})
