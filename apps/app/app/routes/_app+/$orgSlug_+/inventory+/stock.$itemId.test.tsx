// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { type StockOutletContext } from '#app/components/inventory/stock-context.ts'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { stockItem } from '#tests/inventory-fixtures.ts'
import { sentJson } from '#tests/inventory-render.tsx'
import InventoryItemSheetRoute from './stock.$itemId.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

// jsdom has no layout, so Recharts would warn about a 0 x 0 chart.
vi.mock('@repo/ui/chart', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ChartContainer: () => <div data-testid="price-chart" />,
}))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const close = vi.fn()
const reload = vi.fn()

beforeEach(() => {
	vi.clearAllMocks()
})

const CONTEXT: StockOutletContext = {
	orgSlug: 'acme',
	nav: { ...HIDDEN_INVENTORY_NAV, visible: true, stock: true },
	locations: [
		{ id: 'main', name: 'Acme Riyadh' },
		{ id: 'jed', name: 'Acme Jeddah' },
	],
	activeLocationId: 'main',
	canSeeCost: true,
	canEdit: true,
	canManagePurchasing: false,
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
	basePath: '/acme/inventory/stock',
	search: '',
	areas: [],
	reload,
	close,
}

const DETAIL = {
	...stockItem({
		status: 'low',
		onHand: 6_000_000,
		orderBelowQuantity: 8_000_000,
		fillUpToQuantity: 30_000_000,
		lastCountedAt: Date.UTC(2026, 10, 1, 9, 0),
		valueMinor: 16_800,
		currency: 'SAR',
	}),
	notes: null,
	places: [],
	onHandByLocation: [
		{ locationId: 'main', onHand: 6_000_000 },
		{ locationId: 'jed', onHand: 2_000_000 },
	],
	suppliers: [
		{
			id: 'sp1',
			supplierId: 's1',
			supplierName: 'Al Watania',
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			priceMinor: 28_000,
			currency: 'SAR',
			pricedByWeight: false,
			preferred: true,
		},
	],
	cost: {
		lastCostMicro: 2_800_000,
		lastPricedAt: Date.UTC(2026, 10, 1),
		avgCostMicro: 2_800_000,
		currency: 'SAR',
		history: [
			{ at: Date.UTC(2026, 9, 1), costMicro: 2_600_000 },
			{ at: Date.UTC(2026, 10, 1), costMicro: 2_800_000 },
		],
	},
	hasMovements: true,
}

const MOVEMENTS = {
	movements: [
		{
			id: 'm1',
			kind: 'waste',
			quantity: -2_300_000,
			reason: 'expired',
			note: 'Left out',
			sourceType: 'waste',
			sourceId: 'w1',
			businessDate: '2026-11-08',
			actor: { kind: 'operator', id: 'usr_1' },
			createdAt: Date.UTC(2026, 10, 8, 10, 0),
		},
		{
			id: 'm2',
			kind: 'delivery',
			quantity: 10_000_000,
			reason: null,
			note: null,
			sourceType: 'delivery',
			sourceId: 'd1',
			businessDate: '2026-11-01',
			actor: { kind: 'system', id: null },
			createdAt: Date.UTC(2026, 10, 1, 10, 0),
		},
	],
	nextCursor: null,
}

function region(detail: unknown = DETAIL) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path.includes('/movements')) return MOVEMENTS
		if (path.endsWith('/adjust') || path.endsWith('/archive')) {
			return init?.method === 'POST' ? {} : {}
		}
		if (path.startsWith('/items/itm_1')) return detail
		throw new Error(`unexpected request ${path}`)
	})
}

function renderSheet(
	request: InventoryClient['request'],
	context: StockOutletContext = CONTEXT,
) {
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory/stock',
				element: (
					<Sheet open>
						<SheetContent>
							<Outlet context={context} />
						</SheetContent>
					</Sheet>
				),
				children: [
					{
						path: ':itemId',
						loader: () => ({ memberNames: { usr_1: 'Sara Ahmed' } }),
						HydrateFallback: () => null,
						element: <InventoryItemSheetRoute />,
					},
				],
			},
		],
		{ initialEntries: ['/acme/inventory/stock/itm_1'] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<InventoryChangeProvider>
					<RouterProvider router={router} />
				</InventoryChangeProvider>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('Inventory item sheet', () => {
	it('shows the summary, where it is kept per location, buying and history', async () => {
		const request = region()
		renderSheet(request)
		expect(await screen.findByTestId('item-sheet-on-hand')).toHaveTextContent(
			'6 kg',
		)
		expect(request).toHaveBeenCalledWith('/items/itm_1?locationId=main')

		const locations = screen.getByTestId('item-sheet-locations')
		expect(locations).toHaveTextContent('Acme Riyadh')
		expect(locations).toHaveTextContent('Acme Jeddah')
		expect(locations).toHaveTextContent('2 kg')

		expect(screen.getByTestId('item-sheet-suppliers')).toHaveTextContent(
			'Al Watania',
		)
		expect(screen.getByTestId('item-sheet-suppliers')).toHaveTextContent(
			'280.00',
		)

		const history = await screen.findByTestId('item-sheet-history')
		expect(within(history).getByText(/Wasted/)).toBeInTheDocument()
		expect(history).toHaveTextContent('Expired')
		expect(history).toHaveTextContent('Sara Ahmed')
		expect(history).toHaveTextContent('−2.3 kg')
		expect(history).toHaveTextContent('Delivered')
		expect(history).toHaveTextContent('+10 kg')
		expect(history).toHaveTextContent('Automatic')
	})

	it('shows cost and the price history only with the cost grant', async () => {
		const withCost = renderSheet(region())
		const cost = await screen.findByTestId('item-sheet-cost')
		expect(cost).toHaveTextContent('28.00')
		expect(within(cost).getByTestId('price-chart')).toBeInTheDocument()
		withCost.unmount()

		const { cost: ignoredCost, valueMinor, currency, ...withoutCost } = DETAIL
		void ignoredCost
		void valueMinor
		void currency
		// The region leaves money out of every field, supplier prices included.
		const quantityOnly = {
			...withoutCost,
			suppliers: withoutCost.suppliers.map(
				({ priceMinor, currency: priceCurrency, ...supplier }) => {
					void priceMinor
					void priceCurrency
					return supplier
				},
			),
		}
		renderSheet(region(quantityOnly), { ...CONTEXT, canSeeCost: false })
		await screen.findByTestId('item-sheet-on-hand')
		expect(screen.queryByTestId('item-sheet-cost')).toBeNull()
		expect(screen.queryByText(/SAR/)).toBeNull()
	})

	it('adjusts stock with a required reason, signed by direction, in base units', async () => {
		const request = region()
		renderSheet(request)
		await userEvent.click(await screen.findByTestId('item-sheet-adjust'))
		await userEvent.click(screen.getByTestId('adjust-stock-remove'))
		await userEvent.type(screen.getByTestId('adjust-stock-amount'), '1.5')

		// No reason yet: nothing is sent.
		await userEvent.click(screen.getByTestId('adjust-stock-submit'))
		expect(await screen.findByText('Choose a reason.')).toBeInTheDocument()
		expect(request.mock.calls.some(([path]) => path.endsWith('/adjust'))).toBe(
			false,
		)

		await userEvent.click(screen.getByTestId('adjust-stock-reason-damaged'))
		await userEvent.click(screen.getByTestId('adjust-stock-submit'))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Stock adjusted.'),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/items/itm_1/adjust',
		)
		expect(sentJson(request, index)).toEqual({
			clientId: expect.stringMatching(/^a-/),
			locationId: 'main',
			quantity: -1_500_000,
			reason: 'damaged',
		})
		expect(reload).toHaveBeenCalled()
	})

	it('archives with the item version after a confirmation', async () => {
		const request = region()
		renderSheet(request)
		await userEvent.click(await screen.findByTestId('item-sheet-archive'))
		expect(screen.getByText('Archive this item?')).toBeInTheDocument()
		await userEvent.click(screen.getByTestId('item-sheet-archive-confirm'))
		await waitFor(() => expect(close).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(
			([path]) => path === '/items/itm_1/archive',
		)
		expect(sentJson(request, index)).toEqual({ expectedVersion: 1 })
	})

	it('offers no actions to someone who cannot edit', async () => {
		renderSheet(region(), { ...CONTEXT, canEdit: false })
		await screen.findByTestId('item-sheet-on-hand')
		expect(screen.queryByTestId('item-sheet-actions')).toBeNull()
	})
})
