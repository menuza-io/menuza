// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { type PurchasingOutletContext } from '#app/components/inventory/purchasing-context.ts'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { sentJson } from '#tests/inventory-render.tsx'
import InventoryDeliveryRoute from './purchasing.deliveries.$deliveryId.tsx'
import InventorySupplierRoute from './purchasing.suppliers.$supplierId.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const close = vi.fn()
const reload = vi.fn()

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
})

const CONTEXT: PurchasingOutletContext = {
	orgSlug: 'acme',
	nav: { ...HIDDEN_INVENTORY_NAV, visible: true, purchasing: true },
	locations: [{ id: 'main', name: 'Acme' }],
	activeLocationId: 'main',
	canSeeCost: true,
	canEdit: true,
	canManagePurchasing: true,
	purchasingEnabled: false,
	transfersEnabled: false,
	transferPlaces: [],
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
	basePath: '/acme/inventory/purchasing',
	search: '',
	reload,
	close,
}

function renderSheet(
	route: string,
	request: InventoryClient['request'],
	context: Partial<PurchasingOutletContext> = {},
) {
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory/purchasing',
				element: (
					<Sheet open>
						<SheetContent>
							<Outlet context={{ ...CONTEXT, ...context }} />
						</SheetContent>
					</Sheet>
				),
				children: [
					{
						path: 'deliveries/:deliveryId',
						element: <InventoryDeliveryRoute />,
					},
					{
						path: 'suppliers/:supplierId',
						element: <InventorySupplierRoute />,
					},
				],
			},
		],
		{ initialEntries: [route] },
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

function deliveryDetail(overrides: Record<string, unknown> = {}) {
	return {
		id: 'd1',
		locationId: 'main',
		supplierId: 's1',
		supplierName: 'Fresh Farms',
		status: 'received',
		invoiceNumber: 'INV-4471',
		invoiceDate: '2026-11-03',
		businessDate: '2026-11-03',
		source: 'operator',
		receivedAt: Date.UTC(2026, 10, 3, 10),
		receivedBy: { kind: 'operator', id: 'u1' },
		lineCount: 2,
		paid: false,
		paidAt: null,
		version: 4,
		linesTotalMinor: 41_200,
		vatMinor: 6_180,
		totalMinor: 47_380,
		currency: 'SAR',
		zatcaReference: 'ZATCA-77',
		lines: [
			{
				id: 'l1',
				itemId: 'itm_1',
				itemName: 'Tomatoes',
				quantity: 20_000_000,
				packs: 2,
				packName: 'Crate',
				realWeightQuantity: null,
				packPriceMinor: 10_000,
				lineTotalMinor: 20_000,
				priceChangeBp: 1400,
			},
			{
				id: 'l2',
				itemId: 'itm_2',
				itemName: 'Onions',
				quantity: 10_000_000,
				packs: null,
				packName: null,
				realWeightQuantity: null,
				lineTotalMinor: 21_200,
				priceChangeBp: -500,
			},
		],
		...overrides,
	}
}

function deliveryRegion(detail = deliveryDetail()) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path === '/deliveries/d1' && !init?.method) return detail
		if (path.startsWith('/items/')) {
			return {
				id: path.includes('itm_1') ? 'itm_1' : 'itm_2',
				name: 'x',
				category: 'produce',
				kind: 'bought',
				baseUnit: 'g',
				archived: false,
				version: 1,
				onHand: 0,
				countUnit: 'kg',
				units: [],
				areaIds: [],
				orderBelowQuantity: null,
				fillUpToQuantity: null,
				status: 'out',
				lastCountedAt: null,
			}
		}
		if (init?.method === 'POST') return { ...detail, version: 5 }
		throw new Error(`unexpected request ${path}`)
	})
}

describe('Delivery sheet', () => {
	it('shows the lines, how prices moved, the invoice and its totals', async () => {
		renderSheet('/acme/inventory/purchasing/deliveries/d1', deliveryRegion())
		const lines = await screen.findByTestId('delivery-lines')
		await waitFor(() => expect(lines).toHaveTextContent('2 × Crate · 20 kg'))
		expect(lines).toHaveTextContent('Tomatoes')
		expect(screen.getByTestId('delivery-line-change-l1')).toHaveTextContent(
			'+14%',
		)
		expect(screen.getByTestId('delivery-line-change-l2')).toHaveTextContent(
			'-5%',
		)
		expect(screen.getByTestId('delivery-totals')).toHaveTextContent('473.80')
		expect(screen.getByText('INV-4471')).toBeInTheDocument()
		expect(screen.getByText('ZATCA-77')).toBeInTheDocument()
		expect(screen.getByTestId('delivery-unpaid')).toBeInTheDocument()
	})

	it('hides every money figure from someone without the cost grant', async () => {
		renderSheet(
			'/acme/inventory/purchasing/deliveries/d1',
			deliveryRegion(
				deliveryDetail({
					linesTotalMinor: undefined,
					vatMinor: undefined,
					totalMinor: undefined,
					lines: [
						{
							id: 'l1',
							itemId: 'itm_1',
							itemName: 'Tomatoes',
							quantity: 20_000_000,
							packs: 2,
							packName: 'Crate',
							realWeightQuantity: null,
						},
					],
				}),
			),
			{ canSeeCost: false },
		)
		await screen.findByTestId('delivery-lines')
		expect(screen.queryByTestId('delivery-totals')).toBeNull()
		expect(document.body.textContent).not.toMatch(/SAR|473/)
	})

	it('marks it paid with the version it saw, and refreshes the list', async () => {
		const request = deliveryRegion()
		renderSheet('/acme/inventory/purchasing/deliveries/d1', request)
		await userEvent.click(await screen.findByTestId('delivery-toggle-paid'))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Marked as paid.'),
		)
		const index = request.mock.calls.findIndex(([path]) =>
			path.endsWith('/paid'),
		)
		expect(sentJson(request, index)).toEqual({ expectedVersion: 4, paid: true })
		expect(reload).toHaveBeenCalled()
	})

	it('offers Mark unpaid for a paid delivery', async () => {
		renderSheet(
			'/acme/inventory/purchasing/deliveries/d1',
			deliveryRegion(deliveryDetail({ paid: true, paidAt: 5 })),
		)
		expect(await screen.findByTestId('delivery-toggle-paid')).toHaveTextContent(
			'Mark unpaid',
		)
		expect(screen.queryByTestId('delivery-unpaid')).toBeNull()
	})

	it('marking paid needs the purchasing grant', async () => {
		renderSheet('/acme/inventory/purchasing/deliveries/d1', deliveryRegion(), {
			canManagePurchasing: false,
		})
		await screen.findByTestId('delivery-lines')
		expect(screen.queryByTestId('delivery-toggle-paid')).toBeNull()
		expect(screen.getByTestId('delivery-cancel')).toBeInTheDocument()
	})

	it('cancels only after a confirmation, with the reason, and says the stock goes back', async () => {
		const request = deliveryRegion()
		renderSheet('/acme/inventory/purchasing/deliveries/d1', request)
		await userEvent.click(await screen.findByTestId('delivery-cancel'))
		expect(request.mock.calls.some(([p]) => p.endsWith('/cancel'))).toBe(false)
		expect(
			await screen.findByText(/The stock it added is taken back out/),
		).toBeInTheDocument()
		await userEvent.type(
			screen.getByTestId('delivery-cancel-note'),
			'Entered twice',
		)
		await userEvent.click(screen.getByTestId('delivery-cancel-confirm'))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Delivery cancelled.'),
		)
		const index = request.mock.calls.findIndex(([path]) =>
			path.endsWith('/cancel'),
		)
		expect(sentJson(request, index)).toEqual({
			expectedVersion: 4,
			note: 'Entered twice',
		})
	})

	it('a cancelled delivery has no actions', async () => {
		renderSheet(
			'/acme/inventory/purchasing/deliveries/d1',
			deliveryRegion(deliveryDetail({ status: 'cancelled' })),
		)
		expect(await screen.findByTestId('delivery-cancelled')).toBeInTheDocument()
		expect(screen.queryByTestId('delivery-cancel')).toBeNull()
		expect(screen.queryByTestId('delivery-toggle-paid')).toBeNull()
	})

	it('shows why an action failed and keeps the sheet', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path, init) => {
			if (init?.method === 'POST') {
				throw new OperatorRequestError('stale', 'stale_version', 409)
			}
			if (path.startsWith('/items/')) throw new Error('skip')
			return deliveryDetail()
		})
		renderSheet('/acme/inventory/purchasing/deliveries/d1', request)
		await userEvent.click(await screen.findByTestId('delivery-toggle-paid'))
		expect(await screen.findByTestId('delivery-save-error')).toHaveTextContent(
			'Someone else changed this first',
		)
	})
})

describe('Supplier sheet', () => {
	const SUPPLIER = {
		id: 's1',
		name: 'Fresh Farms',
		contactName: 'Omar',
		phone: '123',
		email: null,
		orderChannel: 'phone',
		deliveryDays: [1, 4],
		cutoffTime: null,
		cutoffDaysBefore: null,
		currency: 'SAR',
		paymentTerms: '30 days',
		vatNumber: null,
		notes: null,
		archived: false,
		version: 2,
		productCount: 0,
		unpaidCount: 2,
		minimumOrderMinor: 40_000,
		unpaidMinor: 421_000,
		products: [],
	}

	function supplierRegion() {
		return vi.fn<InventoryClient['request']>(async (path, init) => {
			if (path === '/suppliers/s1' && !init?.method) return SUPPLIER
			if (path === '/suppliers/s1/archive')
				return { ...SUPPLIER, archived: true }
			throw new Error(`unexpected request ${path}`)
		})
	}

	it('shows the details to edit and what you owe them', async () => {
		renderSheet('/acme/inventory/purchasing/suppliers/s1', supplierRegion())
		expect(await screen.findByTestId('supplier-form-name')).toHaveValue(
			'Fresh Farms',
		)
		const owed = screen.getByTestId('supplier-owed')
		expect(owed).toHaveTextContent('You owe')
		expect(owed).toHaveTextContent('4,210')
		expect(owed).toHaveTextContent('on 2 unpaid deliveries')
		expect(screen.getByTestId('supplier-products-empty')).toBeInTheDocument()
	})

	it('a reader sees a summary, not a form, and no Archive', async () => {
		renderSheet('/acme/inventory/purchasing/suppliers/s1', supplierRegion(), {
			canManagePurchasing: false,
		})
		const summary = await screen.findByTestId('supplier-summary')
		expect(summary).toHaveTextContent('Omar')
		expect(summary).toHaveTextContent('Mon, Thu')
		expect(summary).toHaveTextContent('400.00')
		expect(screen.queryByTestId('supplier-form-name')).toBeNull()
		expect(screen.queryByTestId('supplier-archive')).toBeNull()
	})

	it('archives only after a confirmation, with the version it saw', async () => {
		const request = supplierRegion()
		renderSheet('/acme/inventory/purchasing/suppliers/s1', request)
		await userEvent.click(await screen.findByTestId('supplier-archive'))
		expect(request.mock.calls.some(([p]) => p.endsWith('/archive'))).toBe(false)
		await userEvent.click(await screen.findByTestId('supplier-archive-confirm'))
		await waitFor(() => expect(close).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(([p]) => p.endsWith('/archive'))
		expect(sentJson(request, index)).toEqual({ expectedVersion: 2 })
		expect(toast.success).toHaveBeenCalledWith('Fresh Farms archived.')
	})

	it('shows the error with Try again when the supplier does not load', async () => {
		renderSheet(
			'/acme/inventory/purchasing/suppliers/s1',
			vi.fn<InventoryClient['request']>(async () => {
				throw new OperatorRequestError('down', 'inventory_unavailable', 503)
			}),
		)
		expect(await screen.findByTestId('supplier-error')).toBeInTheDocument()
	})
})
