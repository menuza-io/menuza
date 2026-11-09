// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InventoryChrome } from '#app/components/inventory/inventory-chrome.tsx'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { sentJson } from '#tests/inventory-render.tsx'
import { type InventoryLayoutContext } from './_layout.tsx'
import InventoryPurchasingRoute from './purchasing.tsx'

const toast = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

beforeEach(() => {
	toast.success.mockReset()
	toast.error.mockReset()
})

const CONTEXT: InventoryLayoutContext = {
	orgSlug: 'acme',
	nav: { ...HIDDEN_INVENTORY_NAV, visible: true, purchasing: true },
	locations: [{ id: 'main', name: 'Acme' }],
	activeLocationId: 'main',
	canSeeCost: true,
	canEdit: true,
	canManagePurchasing: true,
	purchasingEnabled: true,
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
}

function card(overrides: Record<string, unknown> = {}) {
	return {
		supplierId: 's1',
		supplierName: 'Al Watania Poultry',
		orderChannel: 'email',
		expectedDate: '2026-11-12',
		cutoff: { date: '2026-11-11', time: '16:00' },
		cutoffPassed: false,
		draftOrderId: null,
		lineCount: 6,
		lines: [],
		currency: 'SAR',
		totalMinor: 184_000,
		minimumOrderMinor: 40_000,
		belowMinimum: false,
		unpricedLines: 0,
		...overrides,
	}
}

function order(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		number: 12,
		locationId: 'main',
		supplierId: 's1',
		supplierName: 'Al Watania Poultry',
		status: 'sent',
		expectedDate: '2026-11-13',
		cutoff: null,
		note: null,
		createdBy: { kind: 'operator', id: 'u1' },
		createdAt: 1,
		sentAt: Date.UTC(2026, 10, 10, 9),
		sentVia: 'email',
		closedAt: null,
		lineCount: 3,
		receivedLineCount: 0,
		version: 1,
		currency: 'SAR',
		totalMinor: 192_000,
		minimumOrderMinor: 40_000,
		shortOfMinimumMinor: 0,
		...overrides,
	}
}

function alert(overrides: Record<string, unknown> = {}) {
	return {
		itemId: 'i1',
		itemName: 'Tomatoes',
		supplierId: 's2',
		supplierName: 'Fresh Farms',
		deliveryId: 'd7',
		deliveredAt: 5,
		previousCostMicro: 2_000_000,
		costMicro: 2_280_000,
		changeBp: 1400,
		severity: 'rise',
		packName: 'Crate',
		previousPackPriceMinor: 5000,
		packPriceMinor: 5700,
		affectedDishes: null,
		...overrides,
	}
}

type Region = {
	suggested?: Record<string, unknown>
	orders?: unknown[]
	alerts?: unknown[]
	create?: () => unknown
}

function region(options: Region = {}) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path.startsWith('/deliveries?')) {
			return { deliveries: [], nextCursor: null }
		}
		if (path === '/suppliers') {
			return {
				suppliers: [
					{
						id: 's1',
						name: 'Al Watania Poultry',
						contactName: null,
						phone: null,
						email: null,
						orderChannel: 'email',
						deliveryDays: [4],
						cutoffTime: null,
						cutoffDaysBefore: null,
						currency: 'SAR',
						paymentTerms: null,
						vatNumber: null,
						notes: null,
						archived: false,
						version: 1,
						productCount: 2,
						unpaidCount: 0,
					},
				],
			}
		}
		if (path.startsWith('/orders/suggested')) {
			return {
				locationId: 'main',
				generatedAt: 1,
				suppliers: [card()],
				unsourced: [],
				toOrderItems: 6,
				...options.suggested,
			}
		}
		if (path.startsWith('/orders?')) {
			return { orders: options.orders ?? [order('o1')], nextCursor: null }
		}
		if (path.startsWith('/price-alerts')) {
			return {
				locationId: 'main',
				days: 30,
				thresholdBp: 500,
				currency: 'SAR',
				alerts: options.alerts ?? [alert()],
			}
		}
		if (path === '/orders' && init?.method === 'POST') {
			return (
				options.create?.() ?? {
					...order('o9', { status: 'draft', sentAt: null, sentVia: null }),
					lines: [],
					deliveries: [],
					supplierOrderChannel: 'email',
					supplierEmail: null,
					supplierPhone: null,
				}
			)
		}
		throw new Error(`unexpected request ${path}`)
	})
}

function renderPurchasing(
	request: InventoryClient['request'],
	context: Partial<InventoryLayoutContext> = {},
) {
	const merged = { ...CONTEXT, ...context }
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory',
				element: (
					<InventoryChrome
						orgSlug="acme"
						nav={merged.nav}
						locations={merged.locations}
						selectedLocationId="main"
						onLocationChange={() => {}}
						canLogWaste={merged.canEdit}
						canSeeCost={merged.canSeeCost}
						currency="SAR"
						userName="Sara"
					>
						<Outlet context={merged} />
					</InventoryChrome>
				),
				children: [
					{ path: 'purchasing', element: <InventoryPurchasingRoute /> },
					{
						path: 'purchasing/orders/:orderId',
						element: <div data-testid="order-page" />,
					},
					{
						path: 'purchasing/deliveries/new',
						element: <div data-testid="receive-page" />,
					},
				],
			},
		],
		{ initialEntries: ['/acme/inventory/purchasing'] },
	)
	return {
		router,
		...render(
			<I18nProvider i18n={i18n}>
				<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
					<InventoryChangeProvider>
						<RouterProvider router={router} />
					</InventoryChangeProvider>
				</InventoryClientContext.Provider>
			</I18nProvider>,
		),
	}
}

describe('Purchasing: suggested orders', () => {
	it('shows a card per supplier with items, total and when to order by', async () => {
		renderPurchasing(region())
		const suggested = await screen.findByTestId('suggested-s1')
		expect(suggested).toHaveTextContent('Al Watania Poultry')
		expect(suggested).toHaveTextContent('6 items')
		expect(suggested).toHaveTextContent('1,840')
		expect(screen.getByTestId('suggested-cutoff')).toHaveTextContent(
			/Order by Wed.*4:00\s?PM for Thu/,
		)
		expect(screen.queryByTestId('suggested-minimum')).toBeNull()
	})

	it('warns when the order is below the supplier minimum', async () => {
		renderPurchasing(
			region({
				suggested: {
					suppliers: [card({ belowMinimum: true, totalMinor: 31_000 })],
				},
			}),
		)
		expect(await screen.findByTestId('suggested-minimum')).toHaveTextContent(
			'Below the minimum order of',
		)
		expect(screen.getByTestId('suggested-minimum')).toHaveTextContent('400')
	})

	it('says when the cut-off has passed', async () => {
		renderPurchasing(
			region({ suggested: { suppliers: [card({ cutoffPassed: true })] } }),
		)
		expect(await screen.findByTestId('suggested-passed')).toHaveTextContent(
			'The cut-off for Thu has passed.',
		)
	})

	it('shows no money without the cost grant', async () => {
		renderPurchasing(
			region({
				suggested: {
					suppliers: [
						card({
							currency: undefined,
							totalMinor: undefined,
							minimumOrderMinor: undefined,
							belowMinimum: undefined,
						}),
					],
				},
			}),
			{ canSeeCost: false },
		)
		const suggested = await screen.findByTestId('suggested-s1')
		expect(suggested.textContent).not.toMatch(/\d{2,}[.,]\d{2}/)
		expect(suggested).toHaveTextContent('6 items')
	})

	it('creates a draft from the suggestion and opens it for review', async () => {
		const request = region()
		const { router } = renderPurchasing(request)
		await userEvent.click(await screen.findByTestId('suggested-review-s1'))
		await screen.findByTestId('order-page')
		expect(router.state.location.pathname).toBe(
			'/acme/inventory/purchasing/orders/o9',
		)
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/orders' && init?.method === 'POST',
		)
		expect(sentJson(request, index)).toMatchObject({
			locationId: 'main',
			supplierId: 's1',
			fromSuggestion: true,
		})
	})

	it('offers to continue a draft that already exists instead of making another', async () => {
		const request = region({
			suggested: { suppliers: [card({ draftOrderId: 'o5' })] },
		})
		renderPurchasing(request)
		const link = await screen.findByTestId('suggested-continue-s1')
		expect(link).toHaveAttribute('href', '/acme/inventory/purchasing/orders/o5')
		expect(screen.queryByTestId('suggested-review-s1')).toBeNull()
	})

	it('says so, and stays, when the draft cannot be made', async () => {
		renderPurchasing(
			region({
				create: () => {
					throw new OperatorRequestError('x', 'feature_disabled', 403)
				},
			}),
		)
		await userEvent.click(await screen.findByTestId('suggested-review-s1'))
		await waitFor(() => expect(toast.error).toHaveBeenCalled())
		expect(screen.queryByTestId('order-page')).toBeNull()
	})

	it('lists items that need ordering but have no supplier', async () => {
		renderPurchasing(
			region({
				suggested: {
					suppliers: [],
					unsourced: [
						{
							itemId: 'i9',
							itemName: 'Saffron',
							baseUnit: 'g',
							countUnit: null,
							onHand: 0,
							orderBelowQuantity: 100,
							fillUpToQuantity: null,
						},
					],
				},
			}),
		)
		expect(await screen.findByTestId('suggested-unsourced')).toHaveTextContent(
			'1 item is low but has no supplier yet: Saffron',
		)
	})

	it('has no suggested orders, open orders or price rises while the purchasing flag is off', async () => {
		const request = region()
		renderPurchasing(request, { purchasingEnabled: false })
		await screen.findByText('Recent deliveries')
		expect(screen.queryByText('Suggested orders')).toBeNull()
		expect(screen.queryByTestId('purchasing-new-order')).toBeNull()
		expect(
			request.mock.calls.some(
				([path]) =>
					path.startsWith('/orders') || path.startsWith('/price-alerts'),
			),
		).toBe(false)
	})
})

describe('Purchasing: open orders and price rises', () => {
	it('lists open orders with a status badge and Receive', async () => {
		renderPurchasing(
			region({
				orders: [
					order('o1'),
					order('o2', { status: 'partly_received', number: 13 }),
					order('o3', { status: 'draft', number: 14, sentAt: null }),
				],
			}),
		)
		const sent = await screen.findByTestId('order-row-o1')
		expect(sent).toHaveTextContent('Order 12')
		expect(screen.getByTestId('order-status-o1')).toHaveTextContent('Sent')
		expect(screen.getByTestId('order-status-o2')).toHaveTextContent(
			'Partly received',
		)
		expect(screen.getByTestId('order-status-o3')).toHaveTextContent('Draft')
		expect(screen.getByTestId('order-receive-o1')).toHaveAttribute(
			'href',
			'/acme/inventory/purchasing/deliveries/new?orderId=o1',
		)
	})

	it('offers no Receive to someone who cannot record deliveries', async () => {
		renderPurchasing(region(), { canEdit: false })
		await screen.findByTestId('order-row-o1')
		expect(screen.queryByTestId('order-receive-o1')).toBeNull()
	})

	it('says there are no open orders', async () => {
		renderPurchasing(region({ orders: [] }))
		expect(await screen.findByTestId('orders-empty')).toBeInTheDocument()
	})

	it('shows the prices that went up with the delivery to look at', async () => {
		renderPurchasing(region())
		const row = await screen.findByTestId('price-alert-i1')
		expect(row).toHaveTextContent('Tomatoes')
		expect(row).toHaveTextContent('went up 14%')
		expect(row).toHaveTextContent('at Fresh Farms')
		expect(within(row).getByTestId('price-alert-link-i1')).toHaveAttribute(
			'href',
			'/acme/inventory/purchasing/deliveries/d7',
		)
	})

	it('does not ask for price rises, which are money, without the cost grant', async () => {
		const request = region()
		renderPurchasing(request, { canSeeCost: false })
		await screen.findByTestId('order-row-o1')
		expect(screen.queryByText('Prices went up')).toBeNull()
		expect(
			request.mock.calls.some(([path]) => path.startsWith('/price-alerts')),
		).toBe(false)
	})

	it('starts an empty draft for a supplier from New order', async () => {
		const request = region()
		renderPurchasing(request)
		await userEvent.click(await screen.findByTestId('purchasing-new-order'))
		await userEvent.click(await screen.findByTestId('new-order-supplier'))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Al Watania Poultry' }),
		)
		await userEvent.click(screen.getByTestId('new-order-submit'))
		await screen.findByTestId('order-page')
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/orders' && init?.method === 'POST',
		)
		const body = sentJson(request, index) as Record<string, unknown>
		expect(body).toMatchObject({ supplierId: 's1', locationId: 'main' })
		expect(body).not.toHaveProperty('fromSuggestion')
	})
})
