// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { stockItem } from '#tests/inventory-fixtures.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { RecordDeliveryScreen } from './record-delivery-screen.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
	// cmdk measures and scrolls its list; jsdom has neither API.
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	Element.prototype.scrollIntoView = vi.fn()
	toast.success.mockReset()
	toast.error.mockReset()
})

afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

const CHICKEN = stockItem({
	costMicro: 2_500_000,
	valueMinor: 15_000,
	currency: 'SAR',
})

const SUPPLIER = {
	id: 's1',
	name: 'Al Watania',
	contactName: null,
	phone: null,
	email: null,
	orderChannel: 'phone',
	deliveryDays: [],
	cutoffTime: null,
	cutoffDaysBefore: null,
	currency: 'SAR',
	paymentTerms: null,
	vatNumber: null,
	notes: null,
	archived: false,
	version: 1,
	productCount: 1,
	unpaidCount: 0,
}

const PRODUCT = {
	id: 'sp_1',
	supplierId: 's1',
	itemId: 'itm_1',
	itemName: 'Chicken thighs',
	packName: 'Box',
	packBaseQuantity: 10_000_000,
	pricedByWeight: false,
	sku: null,
	preferred: true,
	version: 1,
	priceMinor: 28_000,
	currency: 'SAR',
}

function deliveryAnswer(priceChanges?: unknown[]) {
	return {
		delivery: {
			id: 'd1',
			locationId: 'main',
			supplierId: 's1',
			supplierName: 'Al Watania',
			status: 'received',
			invoiceNumber: null,
			invoiceDate: null,
			businessDate: '2026-11-09',
			source: 'operator',
			receivedAt: 1,
			receivedBy: { kind: 'operator', id: 'u1' },
			lineCount: 1,
			paid: false,
			paidAt: null,
			version: 1,
			zatcaReference: null,
			lines: [],
		},
		...(priceChanges ? { priceChanges } : {}),
	}
}

function region(
	options: {
		record?: () => unknown
		createItem?: () => unknown
		lastCostMicro?: number | null
	} = {},
) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path === '/suppliers') return { suppliers: [SUPPLIER] }
		if (path === '/suppliers/s1') return { ...SUPPLIER, products: [PRODUCT] }
		if (path.startsWith('/items?')) {
			return { items: [CHICKEN], total: 1, nextCursor: null }
		}
		if (path.startsWith('/items/itm_1')) {
			return {
				...CHICKEN,
				notes: null,
				places: [],
				onHandByLocation: [],
				suppliers: [],
				hasMovements: true,
				cost: {
					lastCostMicro: options.lastCostMicro ?? 2_500_000,
					lastPricedAt: 1,
					avgCostMicro: 2_500_000,
					currency: 'SAR',
					history: [],
				},
			}
		}
		if (path === '/items' && init?.method === 'POST') {
			return (
				options.createItem?.() ??
				stockItem({ id: 'itm_new', name: 'Saffron', baseUnit: 'g' })
			)
		}
		if (path === '/deliveries' && init?.method === 'POST') {
			return options.record?.() ?? deliveryAnswer()
		}
		throw new Error(`unexpected request ${path}`)
	})
}

function setup(
	request: InventoryClient['request'],
	props: {
		canEdit?: boolean
		canSeeCost?: boolean
		canManagePurchasing?: boolean
		dataRegion?: 'us' | 'ksa'
	} = {},
) {
	renderInventory(
		<RecordDeliveryScreen
			orgSlug="acme"
			locationId="main"
			currency="SAR"
			dataRegion={props.dataRegion ?? 'ksa'}
			canEdit={props.canEdit ?? true}
			canSeeCost={props.canSeeCost ?? true}
			canManagePurchasing={props.canManagePurchasing ?? true}
			search=""
		/>,
		{ request },
	)
}

async function chooseSupplier() {
	await userEvent.click(await screen.findByTestId('delivery-supplier'))
	await userEvent.click(
		await screen.findByRole('option', { name: 'Al Watania' }),
	)
}

async function addChicken() {
	await userEvent.click(screen.getByTestId('delivery-add-item'))
	await userEvent.click(
		await screen.findByTestId('delivery-add-item-option-itm_1'),
	)
	return screen.findByTestId(/^delivery-line-line-/)
}

describe('RecordDeliveryScreen', () => {
	it('adds a line with the supplier pack and its remembered price', async () => {
		setup(region())
		await chooseSupplier()
		await addChicken()
		const price = await screen.findByTestId(/^delivery-line-price-/)
		await waitFor(() => expect(price).toHaveValue('280.00'))
		// Packs start blank: the person enters what really arrived.
		expect(screen.getByTestId(/^delivery-line-packs-/)).toHaveValue('')
		expect(screen.getByTestId('delivery-lines-total')).toHaveTextContent('0.00')
	})

	it('works out the line from packs times price and shows how the price moved', async () => {
		setup(region({ lastCostMicro: 2_500_000 }))
		await chooseSupplier()
		await addChicken()
		await userEvent.type(screen.getByTestId(/^delivery-line-packs-/), '2')
		expect(screen.getByTestId('delivery-lines-total')).toHaveTextContent(
			'560.00',
		)
		const change = await screen.findByTestId(/^delivery-line-change-/)
		expect(change).toHaveTextContent('+12%')
		expect(screen.getByTestId('delivery-price-moves')).toHaveTextContent(
			'Chicken thighs',
		)
	})

	it('checks the lines against the invoice total, VAT kept apart', async () => {
		setup(region())
		await chooseSupplier()
		await addChicken()
		await userEvent.type(screen.getByTestId(/^delivery-line-packs-/), '2')

		await userEvent.type(screen.getByTestId('delivery-invoice-total'), '568')
		expect(screen.getByTestId('delivery-total-check')).toHaveAttribute(
			'data-state',
			'apart',
		)
		expect(screen.getByTestId('delivery-total-check')).toHaveTextContent(
			'8.00 apart from the invoice',
		)

		await userEvent.type(screen.getByTestId('delivery-vat'), '8')
		expect(screen.getByTestId('delivery-total-check')).toHaveAttribute(
			'data-state',
			'match',
		)
		expect(screen.getByTestId('delivery-total-check')).toHaveTextContent(
			'Matches the invoice.',
		)
	})

	it('asks for the real weight on goods priced by weight', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path, init) => {
			if (path === '/suppliers/s1') {
				return {
					...SUPPLIER,
					products: [{ ...PRODUCT, pricedByWeight: true }],
				}
			}
			return region()(path, init)
		})
		setup(request)
		await chooseSupplier()
		await addChicken()
		const weight = await screen.findByTestId(/^delivery-line-weight-/)
		await userEvent.type(screen.getByTestId(/^delivery-line-packs-/), '1')
		await userEvent.type(weight, '10.4')
		expect(screen.getByTestId('delivery-lines-total')).toHaveTextContent(
			'291.20',
		)
	})

	it('saves the delivery and says how many prices were updated', async () => {
		const request = region({
			record: () =>
				deliveryAnswer([
					{
						itemId: 'itm_1',
						itemName: 'Chicken thighs',
						previousCostMicro: 2_500_000,
						costMicro: 2_800_000,
						changeBp: 1200,
					},
				]),
		})
		setup(request)
		await chooseSupplier()
		await addChicken()
		await userEvent.type(screen.getByTestId(/^delivery-line-packs-/), '2')
		await userEvent.type(screen.getByTestId('delivery-invoice-number'), 'INV-1')
		await userEvent.type(screen.getByTestId('delivery-zatca'), 'ZATCA-9')
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))

		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Delivery recorded.', {
				description: 'Prices updated for 1 item',
			}),
		)
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/deliveries' && init?.method === 'POST',
		)
		const body = sentJson(request, index) as Record<string, unknown>
		expect(body).toMatchObject({
			locationId: 'main',
			supplierId: 's1',
			invoiceNumber: 'INV-1',
			zatcaReference: 'ZATCA-9',
			currency: 'SAR',
			paid: false,
		})
		expect(String(body.clientId)).toMatch(/^d-/)
		expect(body.lines).toEqual([
			{
				itemId: 'itm_1',
				supplierProductId: 'sp_1',
				quantity: 20_000_000,
				packs: 2,
				packName: 'Box',
				packBaseQuantity: 10_000_000,
				packPriceMinor: 28_000,
				lineTotalMinor: 56_000,
			},
		])
	})

	it('does not toast price changes when none were reported (no cost grant answer)', async () => {
		setup(region())
		await chooseSupplier()
		await addChicken()
		await userEvent.type(screen.getByTestId(/^delivery-line-packs-/), '1')
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Delivery recorded.', {
				description: undefined,
			}),
		)
	})

	it('marks what is missing and sends nothing', async () => {
		const request = region()
		setup(request)
		await chooseSupplier()
		await addChicken()
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		expect(
			await screen.findByTestId('delivery-form-problems'),
		).toBeInTheDocument()
		expect(
			within(screen.getByTestId(/^delivery-line-line-/)).getByText(
				'Enter a number above zero.',
			),
		).toBeInTheDocument()
		expect(request.mock.calls.some(([path]) => path === '/deliveries')).toBe(
			false,
		)
	})

	it('needs at least one line', async () => {
		setup(region())
		await userEvent.click(
			await screen.findByRole('button', { name: 'Save delivery' }),
		)
		expect(
			await screen.findByText('Add at least one item.'),
		).toBeInTheDocument()
	})

	it('keeps the form and says so when saving fails, then retries the same delivery', async () => {
		let attempts = 0
		const request = region({
			record: () => {
				attempts += 1
				if (attempts === 1) {
					throw new TypeError('Failed to fetch')
				}
				return deliveryAnswer()
			},
		})
		setup(request)
		await chooseSupplier()
		await addChicken()
		await userEvent.type(screen.getByTestId(/^delivery-line-packs-/), '1')
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		expect(await screen.findByTestId('delivery-form-error')).toHaveTextContent(
			'We could not save this',
		)
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
		const posts = request.mock.calls
			.map(([path, init], index) => ({ path, init, index }))
			.filter((call) => call.path === '/deliveries')
		const ids = posts.map(
			(call) =>
				(sentJson(request, call.index) as { clientId: string }).clientId,
		)
		// A retry replays the same delivery, never a second one.
		expect(new Set(ids).size).toBe(1)
		expect(ids).toHaveLength(2)
	})

	it('adds an item that is not in Stock yet, right here', async () => {
		const request = region({
			createItem: () => stockItem({ id: 'itm_new', name: 'Saffron' }),
		})
		setup(request)
		await userEvent.click(await screen.findByTestId('delivery-new-item'))
		await userEvent.type(
			await screen.findByTestId('delivery-new-item-name'),
			'Saffron',
		)
		await userEvent.click(screen.getByTestId('delivery-new-item-submit'))
		await screen.findByText('Saffron', { selector: 'span.font-medium' })
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/items' && init?.method === 'POST',
		)
		expect(sentJson(request, index)).toMatchObject({
			name: 'Saffron',
			kind: 'bought',
			baseUnit: 'g',
			category: 'other',
			place: { locationId: 'main', countUnit: 'kg' },
		})
	})

	it('hides ZATCA outside the Kingdom', async () => {
		setup(region(), { dataRegion: 'us' })
		await screen.findByTestId('delivery-invoice-number')
		expect(screen.queryByTestId('delivery-zatca')).toBeNull()
	})

	it('saves as unpaid without the purchasing grant, and says why', async () => {
		setup(region(), { canManagePurchasing: false })
		await screen.findByTestId('delivery-invoice-number')
		expect(screen.getByTestId('delivery-paid')).toHaveAttribute('data-disabled')
	})

	it('explains that recording a delivery needs the cost grant', async () => {
		setup(region(), { canSeeCost: false })
		expect(await screen.findByTestId('delivery-needs-cost')).toHaveTextContent(
			'needs access to costs',
		)
		expect(screen.queryByTestId('record-delivery')).toBeNull()
	})

	it('a reader can look but not record', async () => {
		setup(region(), { canEdit: false })
		expect(await screen.findByTestId('delivery-needs-cost')).toHaveTextContent(
			'not record them',
		)
	})

	it('shows an error from the region instead of losing the lines', async () => {
		setup(
			region({
				record: () => {
					throw new OperatorRequestError('bad', 'invalid_request', 400)
				},
			}),
		)
		await chooseSupplier()
		await addChicken()
		await userEvent.type(screen.getByTestId(/^delivery-line-packs-/), '1')
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		expect(await screen.findByTestId('delivery-form-error')).toHaveTextContent(
			'not accepted',
		)
		expect(screen.getByTestId(/^delivery-line-line-/)).toBeInTheDocument()
	})
})
