// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
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

const reload = vi.fn()
const writeText = vi.fn(async () => {})

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
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText },
		configurable: true,
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const CONTEXT: PurchasingOutletContext = {
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
	basePath: '/acme/inventory/purchasing',
	search: '',
	reload,
	close: vi.fn(),
}

function renderSheet(
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
				],
			},
		],
		{ initialEntries: ['/acme/inventory/purchasing/deliveries/d1'] },
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

function pendingDelivery(overrides: Record<string, unknown> = {}) {
	return {
		id: 'd1',
		locationId: 'main',
		supplierId: 's1',
		supplierName: 'Fresh Farms',
		status: 'received',
		invoiceNumber: null,
		invoiceDate: null,
		businessDate: '2026-11-03',
		source: 'station',
		receivedAt: Date.UTC(2026, 10, 3, 10),
		receivedBy: { kind: 'staff', id: 'st1' },
		lineCount: 2,
		paid: false,
		paidAt: null,
		version: 4,
		currency: 'SAR',
		pricesPending: true,
		orderId: 'o1',
		orderNumber: 12,
		hasPhoto: false,
		zatcaReference: null,
		lines: [
			{
				id: 'l1',
				itemId: 'itm_1',
				itemName: 'Tomatoes',
				quantity: 20_000_000,
				packs: 2,
				packName: 'Crate',
				realWeightQuantity: null,
				orderLineId: 'ol1',
				priced: false,
			},
			{
				id: 'l2',
				itemId: 'itm_2',
				itemName: 'Beef',
				quantity: 9_800_000,
				packs: 1,
				packName: 'Carton',
				realWeightQuantity: 9_800_000,
				orderLineId: 'ol2',
				priced: false,
			},
		],
		...overrides,
	}
}

function region(
	options: {
		delivery?: Record<string, unknown>
		confirm?: () => unknown
		credit?: Record<string, unknown>
	} = {},
) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path === '/deliveries/d1' && !init?.method) {
			return pendingDelivery(options.delivery)
		}
		if (path === '/deliveries/d1/confirm-prices') {
			return (
				options.confirm?.() ?? {
					delivery: pendingDelivery({ pricesPending: false, version: 5 }),
					priceChanges: [
						{
							itemId: 'itm_1',
							itemName: 'Tomatoes',
							previousCostMicro: 2_000_000,
							costMicro: 2_500_000,
							changeBp: 2500,
						},
					],
				}
			)
		}
		if (path === '/deliveries/d1/credit-message') {
			return {
				locale: 'en',
				subject: 'Short delivery',
				text: 'Order 12 arrived short.',
				waLink: null,
				mailto: 'mailto:x@example.com?subject=Short',
				deliveryId: 'd1',
				orderId: 'o1',
				supplierName: 'Fresh Farms',
				lines: [],
				...options.credit,
			}
		}
		if (path === '/deliveries/d1/invoice-photo') {
			return {
				key: 'k1',
				method: 'PUT',
				uploadUrl: 'https://files.example/up',
				headers: {},
				expiresAt: 1,
				maxBytes: 5_242_880,
			}
		}
		if (path === '/deliveries/d1/invoice-photo/confirm') {
			return pendingDelivery({ hasPhoto: true })
		}
		throw new Error(`unexpected request ${path}`)
	})
}

describe('Delivery sheet: prices to confirm', () => {
	it('says the delivery came without prices and offers Confirm prices', async () => {
		renderSheet(region())
		expect(
			await screen.findByTestId('delivery-prices-pending'),
		).toHaveTextContent('Prices to confirm')
		expect(screen.getByTestId('delivery-pending-note')).toHaveTextContent(
			'recorded without prices',
		)
		expect(screen.queryByTestId('delivery-unpaid')).toBeNull()
		expect(screen.queryByTestId('delivery-toggle-paid')).toBeNull()
		expect(screen.getAllByText('Price to confirm')).toHaveLength(2)
		expect(screen.getByTestId('delivery-order-link')).toHaveAttribute(
			'href',
			'/acme/inventory/purchasing/orders/o1',
		)
	})

	it('only looks, without the purchasing role', async () => {
		renderSheet(region(), { canManagePurchasing: false })
		await screen.findByTestId('delivery-pending-note')
		expect(screen.queryByTestId('delivery-confirm-prices')).toBeNull()
	})

	it('confirms the prices line by line and says which prices moved', async () => {
		const request = region()
		renderSheet(request)
		await userEvent.click(await screen.findByTestId('delivery-confirm-prices'))
		await screen.findByTestId('confirm-prices-dialog')
		await userEvent.type(screen.getByTestId('confirm-price-l1'), '100')
		expect(screen.getByTestId('confirm-total-l1')).toHaveAttribute(
			'placeholder',
			'200.00',
		)
		// A line priced by weight has no pack price to multiply: its total is typed.
		expect(screen.queryByTestId('confirm-price-l2')).toBeNull()
		await userEvent.type(screen.getByTestId('confirm-total-l2'), '412.50')
		await userEvent.type(screen.getByTestId('confirm-invoice-number'), 'INV-9')
		await userEvent.type(screen.getByTestId('confirm-vat'), '92')
		await userEvent.click(screen.getByTestId('confirm-paid'))
		await userEvent.click(screen.getByTestId('confirm-prices-submit'))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Prices confirmed.', {
				description: 'Prices updated for 1 item',
			}),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/deliveries/d1/confirm-prices',
		)
		expect(sentJson(request, index)).toEqual({
			expectedVersion: 4,
			currency: 'SAR',
			invoiceNumber: 'INV-9',
			vatMinor: 9200,
			paid: true,
			lines: [
				{ lineId: 'l1', lineTotalMinor: 20_000, packPriceMinor: 10_000 },
				{ lineId: 'l2', lineTotalMinor: 41_250 },
			],
		})
		expect(reload).toHaveBeenCalled()
	})

	it('marks the lines that still need a total and sends nothing', async () => {
		const request = region()
		renderSheet(request)
		await userEvent.click(await screen.findByTestId('delivery-confirm-prices'))
		await userEvent.click(await screen.findByTestId('confirm-prices-submit'))
		expect(await screen.findAllByText(/Enter the line total/)).toHaveLength(2)
		expect(
			request.mock.calls.some(([path]) => path.endsWith('/confirm-prices')),
		).toBe(false)
	})

	it('explains when someone already confirmed them', async () => {
		renderSheet(
			region({
				confirm: () => {
					throw new OperatorRequestError('x', 'prices_confirmed', 409)
				},
			}),
		)
		await userEvent.click(await screen.findByTestId('delivery-confirm-prices'))
		await userEvent.type(await screen.findByTestId('confirm-total-l1'), '10')
		await userEvent.type(screen.getByTestId('confirm-total-l2'), '10')
		await userEvent.click(screen.getByTestId('confirm-prices-submit'))
		expect(await screen.findByTestId('confirm-prices-error')).toHaveTextContent(
			'already confirmed',
		)
	})
})

describe('Delivery sheet: credit and the invoice photo', () => {
	it('asks the region to draft the credit message and shows it with the ways to send it', async () => {
		renderSheet(region({ delivery: { pricesPending: false } }))
		await userEvent.click(await screen.findByTestId('delivery-ask-credit'))
		expect(await screen.findByTestId('credit-text')).toHaveValue(
			'Order 12 arrived short.',
		)
		expect(screen.getByTestId('message-mailto')).toHaveAttribute(
			'href',
			'mailto:x@example.com?subject=Short',
		)
		expect(screen.queryByTestId('message-whatsapp')).toBeNull()
	})

	it('says so when nothing is short', async () => {
		renderSheet(
			region({
				delivery: { pricesPending: false },
				credit: { text: null, subject: null },
			}),
		)
		await userEvent.click(await screen.findByTestId('delivery-ask-credit'))
		expect(await screen.findByTestId('credit-nothing')).toBeInTheDocument()
	})

	it('has no credit button for a delivery with no order', async () => {
		renderSheet(region({ delivery: { orderId: null, orderNumber: null } }))
		await screen.findByTestId('delivery-pending-note')
		expect(screen.queryByTestId('delivery-ask-credit')).toBeNull()
	})

	it('shows the invoice photo and replaces it', async () => {
		const request = region({
			delivery: {
				hasPhoto: true,
				photo: {
					url: 'https://files.example/read.jpg',
					expiresAt: 9,
					contentType: 'image/jpeg',
				},
			},
		})
		const put = vi.fn(async () => new Response(null, { status: 200 }))
		vi.stubGlobal('fetch', put)
		renderSheet(request)
		expect(await screen.findByTestId('delivery-photo-image')).toHaveAttribute(
			'src',
			'https://files.example/read.jpg',
		)
		expect(screen.getByTestId('delivery-photo-button')).toHaveTextContent(
			'Replace photo',
		)
		await userEvent.upload(
			screen.getByTestId('delivery-photo-input'),
			new File([new Uint8Array(500)], 'new.png', { type: 'image/png' }),
		)
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Photo saved.'),
		)
		expect(put).toHaveBeenCalledWith(
			'https://files.example/up',
			expect.objectContaining({ method: 'PUT' }),
		)
		expect(reload).toHaveBeenCalled()
	})

	it('says so when the upload fails and keeps the delivery as it was', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 500 })),
		)
		renderSheet(region())
		await screen.findByTestId('delivery-photo-input')
		await userEvent.upload(
			screen.getByTestId('delivery-photo-input'),
			new File([new Uint8Array(500)], 'new.png', { type: 'image/png' }),
		)
		expect(await screen.findByTestId('delivery-save-error')).toHaveTextContent(
			'could not be uploaded',
		)
	})

	it('a reader can see the photo but not change it', async () => {
		renderSheet(
			region({
				delivery: {
					photo: {
						url: 'https://files.example/r.jpg',
						expiresAt: 9,
						contentType: 'image/jpeg',
					},
				},
			}),
			{ canEdit: false },
		)
		await screen.findByTestId('delivery-photo-image')
		expect(screen.queryByTestId('delivery-photo-button')).toBeNull()
	})
})
