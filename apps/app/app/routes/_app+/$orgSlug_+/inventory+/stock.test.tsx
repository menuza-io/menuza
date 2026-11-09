// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { stockItem } from '#tests/inventory-fixtures.ts'
import { type InventoryLayoutContext } from './_layout.tsx'
import InventoryStockRoute from './stock.tsx'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const CONTEXT: InventoryLayoutContext = {
	orgSlug: 'acme',
	nav: { ...HIDDEN_INVENTORY_NAV, visible: true, stock: true },
	locations: [{ id: 'main', name: 'Acme' }],
	activeLocationId: 'main',
	canSeeCost: false,
	canEdit: true,
	canManagePurchasing: false,
	purchasingEnabled: false,
	transfersEnabled: false,
	transferPlaces: [],
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
}

const ITEMS = [
	stockItem({
		id: 'itm_1',
		name: 'Chicken thighs',
		status: 'low',
		onHand: 6_000_000,
		orderBelowQuantity: 8_000_000,
		fillUpToQuantity: 30_000_000,
		areaIds: ['a1'],
		valueMinor: 16_800,
		currency: 'SAR',
	}),
	stockItem({
		id: 'itm_2',
		name: 'Pita bread',
		category: 'bakery',
		baseUnit: 'piece',
		countUnit: 'piece',
		status: 'out',
		onHand: 0,
	}),
	stockItem({
		id: 'itm_3',
		name: 'Garlic sauce',
		category: 'sauces',
		baseUnit: 'ml',
		countUnit: 'l',
	}),
]

function region(
	list: (path: string) => unknown = () => ({
		items: ITEMS,
		total: 112,
		nextCursor: 'next',
	}),
) {
	return vi.fn<InventoryClient['request']>(async (path) => {
		if (path.startsWith('/storage-areas')) {
			return {
				areas: [
					{
						id: 'a1',
						locationId: 'main',
						name: 'Walk-in fridge',
						sortOrder: 0,
						itemCount: 1,
						version: 1,
					},
				],
			}
		}
		if (path.startsWith('/items?')) return list(path)
		throw new Error(`unexpected request ${path}`)
	})
}

function renderStock(
	request: InventoryClient['request'],
	{ route = '/acme/inventory/stock', context = CONTEXT } = {},
) {
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory',
				element: <Outlet context={context} />,
				children: [{ path: 'stock', element: <InventoryStockRoute /> }],
			},
		],
		{ initialEntries: [route] },
	)
	const view = render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<RouterProvider router={router} />
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
	return { router, ...view }
}

function listCalls(request: ReturnType<typeof region>) {
	return request.mock.calls
		.map(([path]) => path)
		.filter((path) => path.startsWith('/items?'))
}

describe('Inventory Stock', () => {
	it('lists items with a status only for the ones that need attention', async () => {
		renderStock(region())
		expect(await screen.findByTestId('stock-row-itm_1')).toBeInTheDocument()

		const low = screen.getByTestId('stock-row-itm_1')
		expect(within(low).getByTestId('stock-status-low')).toBeInTheDocument()
		expect(within(low).getByText('Meat · Walk-in fridge')).toBeInTheDocument()
		expect(within(low).getByText('6 kg')).toBeInTheDocument()
		expect(
			within(screen.getByTestId('stock-row-itm_2')).getByTestId(
				'stock-status-out',
			),
		).toBeInTheDocument()
		// Nothing for an item that is fine: no "OK" badge.
		const fine = screen.getByTestId('stock-row-itm_3')
		expect(within(fine).queryByTestId(/stock-status/)).toBeNull()
		expect(screen.getByTestId('stock-count')).toHaveTextContent(
			'Showing 3 of 112',
		)
	})

	it('hides money without the cost grant and shows it with', async () => {
		const withoutCost = renderStock(region())
		await screen.findByTestId('stock-row-itm_1')
		expect(screen.queryByRole('columnheader', { name: 'Value' })).toBeNull()
		expect(screen.queryByText(/168/)).toBeNull()
		withoutCost.unmount()

		renderStock(region(), { context: { ...CONTEXT, canSeeCost: true } })
		await screen.findByTestId('stock-row-itm_1')
		expect(
			screen.getByRole('columnheader', { name: 'Value' }),
		).toBeInTheDocument()
		expect(
			within(screen.getByTestId('stock-row-itm_1')).getByText(/168\.00/),
		).toBeInTheDocument()
		// A row without a value shows a dash, never zero.
		expect(
			within(screen.getByTestId('stock-row-itm_2')).getByText('—'),
		).toBeInTheDocument()
	})

	it('reads its filters from the URL and sends them to the region', async () => {
		const request = region()
		renderStock(request, {
			route:
				'/acme/inventory/stock?q=chick&category=meat&area=a1&low=1&limit=100',
		})
		await screen.findByTestId('stock-row-itm_1')
		const path = listCalls(request)[0]!
		expect(Object.fromEntries(new URLSearchParams(path.split('?')[1]))).toEqual(
			{
				locationId: 'main',
				q: 'chick',
				category: 'meat',
				areaId: 'a1',
				status: 'attention',
				limit: '100',
			},
		)
		expect(screen.getByTestId('stock-search')).toHaveValue('chick')
		expect(screen.getByTestId('stock-filter-low')).toHaveAttribute(
			'aria-pressed',
			'true',
		)
	})

	it('searches after a pause, and toggling Low or out filters the list', async () => {
		const request = region()
		const { router } = renderStock(request)
		await screen.findByTestId('stock-row-itm_1')

		await userEvent.type(screen.getByTestId('stock-search'), 'pita')
		await waitFor(() =>
			expect(router.state.location.search).toContain('q=pita'),
		)
		await waitFor(() =>
			expect(listCalls(request).some((path) => path.includes('q=pita'))).toBe(
				true,
			),
		)
		// One request per pause, not one per key.
		expect(
			listCalls(request).filter((path) => path.includes('q=p')),
		).toHaveLength(
			listCalls(request).filter((path) => path.includes('q=pita')).length,
		)

		await userEvent.click(screen.getByTestId('stock-filter-low'))
		await waitFor(() => expect(router.state.location.search).toContain('low=1'))
		await waitFor(() =>
			expect(
				listCalls(request).some((path) => path.includes('status=attention')),
			).toBe(true),
		)
	})

	it('raises the limit with Show more, up to 200', async () => {
		const request = region()
		const { router } = renderStock(request)
		await userEvent.click(await screen.findByTestId('stock-show-more'))
		await waitFor(() =>
			expect(router.state.location.search).toContain('limit=100'),
		)
		await waitFor(() =>
			expect(
				listCalls(request).some((path) => path.includes('limit=100')),
			).toBe(true),
		)
	})

	it('says nothing matches, with a way back, and an empty list says to add items', async () => {
		const none = renderStock(
			region(() => ({ items: [], total: 0, nextCursor: null })),
			{ route: '/acme/inventory/stock?q=zzz' },
		)
		expect(await screen.findByText('No items match')).toBeInTheDocument()
		await userEvent.click(screen.getByTestId('stock-clear-filters'))
		expect(await screen.findByText('No items yet')).toBeInTheDocument()
		none.unmount()

		renderStock(region(() => ({ items: [], total: 0, nextCursor: null })))
		expect(await screen.findByText('No items yet')).toBeInTheDocument()
		expect(
			screen.getAllByRole('button', { name: /Add item/ }).length,
		).toBeGreaterThan(0)
	})

	it('does not offer adding items to someone who cannot edit', async () => {
		renderStock(
			region(() => ({ items: [], total: 0, nextCursor: null })),
			{
				context: { ...CONTEXT, canEdit: false },
			},
		)
		await screen.findByText('No items yet')
		expect(screen.queryByRole('button', { name: /Add item/ })).toBeNull()
	})

	it('shows an error with Try again, never an empty list', async () => {
		let failing = true
		const request = region(() => {
			if (failing)
				throw new OperatorRequestError('down', 'inventory_unavailable', 503)
			return { items: ITEMS, total: 3, nextCursor: null }
		})
		renderStock(request)
		expect(await screen.findByTestId('stock-error')).toHaveTextContent(
			'Inventory is paused right now',
		)
		failing = false
		await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
		expect(await screen.findByTestId('stock-row-itm_1')).toBeInTheDocument()
	})
})
