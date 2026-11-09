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

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
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
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
}

function delivery(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		locationId: 'main',
		supplierId: 's1',
		supplierName: 'Fresh Farms',
		status: 'received',
		invoiceNumber: 'INV-4471',
		invoiceDate: '2026-11-03',
		businessDate: '2026-11-03',
		source: 'operator',
		receivedAt: 1,
		receivedBy: { kind: 'operator', id: 'u1' },
		lineCount: 2,
		paid: false,
		paidAt: null,
		version: 1,
		linesTotalMinor: 41_200,
		vatMinor: 0,
		totalMinor: 41_200,
		currency: 'SAR',
		...overrides,
	}
}

function supplier(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		name: 'Fresh Farms',
		contactName: 'Omar',
		phone: null,
		email: null,
		orderChannel: 'phone',
		deliveryDays: [1, 4],
		cutoffTime: null,
		cutoffDaysBefore: null,
		currency: 'SAR',
		paymentTerms: null,
		vatNumber: null,
		notes: null,
		archived: false,
		version: 1,
		productCount: 2,
		unpaidCount: 1,
		minimumOrderMinor: null,
		unpaidMinor: 41_200,
		...overrides,
	}
}

type Region = {
	deliveries?: unknown[]
	suppliers?: unknown[]
	unpaidMinor?: number | undefined
	pay?: () => unknown
}

function region(options: Region = {}) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path.startsWith('/deliveries?')) {
			return {
				deliveries: options.deliveries ?? [delivery('d1')],
				nextCursor: null,
			}
		}
		if (path === '/suppliers') {
			return {
				suppliers: options.suppliers ?? [supplier('s1')],
				...('unpaidMinor' in options
					? options.unpaidMinor === undefined
						? {}
						: { unpaidMinor: options.unpaidMinor, currency: 'SAR' }
					: { unpaidMinor: 421_000, currency: 'SAR' }),
			}
		}
		if (path.endsWith('/paid') && init?.method === 'POST') {
			return (
				options.pay?.() ?? {
					...delivery('d1'),
					paid: true,
					paidAt: 5,
					version: 2,
					zatcaReference: null,
					lines: [],
				}
			)
		}
		throw new Error(`unexpected request ${path}`)
	})
}

function renderPurchasing(
	request: InventoryClient['request'],
	context: Partial<InventoryLayoutContext> = {},
	route = '/acme/inventory/purchasing',
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
					{
						path: 'purchasing',
						element: <InventoryPurchasingRoute />,
						children: [
							{
								path: 'suppliers/new',
								element: <div data-testid="supplier-new-sheet" />,
							},
							{
								path: 'deliveries/:deliveryId',
								element: <div data-testid="delivery-sheet" />,
							},
						],
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

describe('Inventory Purchasing', () => {
	it('lists recent deliveries with an Unpaid badge and what you owe', async () => {
		renderPurchasing(region())
		const row = await screen.findByTestId('delivery-row-d1')
		expect(row).toHaveTextContent('Fresh Farms')
		expect(row).toHaveTextContent('INV-4471')
		expect(row).toHaveTextContent('412')
		// The table and the phone list both render; CSS shows one.
		expect(screen.getAllByTestId('delivery-unpaid-d1')[0]).toHaveTextContent(
			'Unpaid',
		)
		const owed = screen.getByTestId('purchasing-owed')
		expect(owed).toHaveTextContent('You owe')
		expect(screen.getByTestId('purchasing-owed-total')).toHaveTextContent(
			'4,210',
		)
		expect(owed).toHaveTextContent('on 1 unpaid delivery')
	})

	it('a paid delivery has no badge and no Mark paid', async () => {
		renderPurchasing(
			region({ deliveries: [delivery('d1', { paid: true, paidAt: 3 })] }),
		)
		await screen.findByTestId('delivery-row-d1')
		expect(screen.queryByTestId('delivery-unpaid-d1')).toBeNull()
		expect(screen.queryByTestId('delivery-mark-paid-d1')).toBeNull()
	})

	it('a cancelled delivery says so and cannot be marked paid', async () => {
		renderPurchasing(
			region({ deliveries: [delivery('d1', { status: 'cancelled' })] }),
		)
		const row = await screen.findByTestId('delivery-row-d1')
		expect(row).toHaveTextContent('Cancelled')
		expect(screen.queryByTestId('delivery-mark-paid-d1')).toBeNull()
	})

	it('marks a delivery paid with the version it saw, then refreshes', async () => {
		const request = region()
		renderPurchasing(request)
		await screen.findByTestId('delivery-row-d1')
		await userEvent.click(screen.getAllByTestId('delivery-mark-paid-d1')[0]!)
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Marked as paid.'),
		)
		const index = request.mock.calls.findIndex(([path]) =>
			path.endsWith('/deliveries/d1/paid'),
		)
		expect(sentJson(request, index)).toEqual({ expectedVersion: 1, paid: true })
		// The lists are read again.
		await waitFor(() =>
			expect(
				request.mock.calls.filter(([path]) => path.startsWith('/deliveries?'))
					.length,
			).toBeGreaterThanOrEqual(2),
		)
	})

	it('says so when marking paid fails, and keeps the delivery unpaid', async () => {
		renderPurchasing(
			region({
				pay: () => {
					throw new OperatorRequestError('stale', 'stale_version', 409)
				},
			}),
		)
		await screen.findByTestId('delivery-row-d1')
		await userEvent.click(screen.getAllByTestId('delivery-mark-paid-d1')[0]!)
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				expect.stringContaining('Someone else changed this first'),
			),
		)
		expect(screen.getAllByTestId('delivery-unpaid-d1')[0]).toBeInTheDocument()
	})

	it('without the purchasing grant there is no Mark paid and no new supplier', async () => {
		renderPurchasing(region(), { canManagePurchasing: false })
		await screen.findByTestId('delivery-row-d1')
		expect(screen.queryByTestId('delivery-mark-paid-d1')).toBeNull()
		expect(screen.queryByTestId('suppliers-add')).toBeNull()
	})

	it('without the cost grant there is no money and no way to record a delivery', async () => {
		renderPurchasing(
			region({
				unpaidMinor: undefined,
				deliveries: [
					delivery('d1', {
						linesTotalMinor: undefined,
						vatMinor: undefined,
						totalMinor: undefined,
						currency: undefined,
					}),
				],
				suppliers: [supplier('s1', { unpaidMinor: undefined })],
			}),
			{ canSeeCost: false, canManagePurchasing: false },
		)
		const row = await screen.findByTestId('delivery-row-d1')
		expect(row.textContent).not.toMatch(/\d{2,}\.\d{2}/)
		expect(screen.queryByTestId('purchasing-owed')).toBeNull()
		expect(screen.queryByTestId('purchasing-record-delivery')).toBeNull()
		expect(screen.getByTestId('purchasing-cost-note')).toHaveTextContent(
			'needs access to costs',
		)
		// The supplier still shows that something is unpaid, in words.
		expect(screen.getByTestId('supplier-row-s1')).toHaveTextContent('Unpaid')
	})

	it('offers Record delivery to someone who can see costs and edit', async () => {
		renderPurchasing(region())
		expect(
			await screen.findByTestId('purchasing-record-delivery'),
		).toHaveAttribute('href', '/acme/inventory/purchasing/deliveries/new')
	})

	it('shows the suppliers with their delivery days and what they are owed', async () => {
		renderPurchasing(region())
		const row = await screen.findByTestId('supplier-row-s1')
		expect(row).toHaveTextContent('Fresh Farms')
		expect(row).toHaveTextContent('Omar')
		expect(row).toHaveTextContent('Mon, Thu')
		expect(row).toHaveTextContent('412')
		expect(row.querySelector('a')).toHaveAttribute(
			'href',
			'/acme/inventory/purchasing/suppliers/s1',
		)
	})

	it('shows only unpaid deliveries from the Unpaid link on Today', async () => {
		const request = region()
		renderPurchasing(request, {}, '/acme/inventory/purchasing?unpaid=1')
		await screen.findByTestId('delivery-row-d1')
		expect(
			request.mock.calls.some(([path]) => path.includes('unpaid=true')),
		).toBe(true)
		expect(screen.getByTestId('purchasing-unpaid-toggle')).toHaveAttribute(
			'aria-pressed',
			'true',
		)
	})

	it('has empty states for no deliveries and no suppliers', async () => {
		renderPurchasing(region({ deliveries: [], suppliers: [], unpaidMinor: 0 }))
		expect(await screen.findByText('No deliveries yet')).toBeInTheDocument()
		expect(screen.getByText('No suppliers yet')).toBeInTheDocument()
		expect(screen.queryByTestId('purchasing-owed')).toBeNull()
	})

	it('shows the error with Try again for each list', async () => {
		renderPurchasing(
			vi.fn<InventoryClient['request']>(async () => {
				throw new OperatorRequestError('down', 'inventory_unavailable', 503)
			}),
		)
		expect(await screen.findByTestId('deliveries-error')).toBeInTheDocument()
		expect(await screen.findByTestId('suppliers-error')).toBeInTheDocument()
	})

	it('opens a supplier sheet from the Add supplier button', async () => {
		renderPurchasing(region())
		await userEvent.click(await screen.findByTestId('suppliers-add'))
		expect(await screen.findByTestId('supplier-new-sheet')).toBeInTheDocument()
		const sheet = screen.getByTestId('supplier-new-sheet')
		expect(within(document.body).getByTestId('supplier-new-sheet')).toBe(sheet)
	})
})
