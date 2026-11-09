// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { RecordDeliveryScreen } from './record-delivery-screen.tsx'

const toast = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

const writeText = vi.fn(async () => {})

beforeEach(() => {
	for (const fn of Object.values(toast)) fn.mockReset()
	writeText.mockReset().mockResolvedValue(undefined)
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	URL.createObjectURL = vi.fn(() => 'blob:invoice')
	URL.revokeObjectURL = vi.fn()
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText },
		configurable: true,
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const PREFILL = {
	orderId: 'o1',
	number: 12,
	locationId: 'main',
	supplierId: 's1',
	supplierName: 'Al Watania',
	status: 'sent',
	expectedDate: '2026-11-12',
	currency: 'SAR',
	lines: [
		{
			orderLineId: 'ol1',
			itemId: 'itm_1',
			itemName: 'Chicken thighs',
			baseUnit: 'g',
			countUnit: 'kg',
			supplierProductId: 'sp_1',
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			pricedByWeight: false,
			orderedPacks: 3,
			orderedQuantity: 30_000_000,
			receivedQuantity: 10_000_000,
			outstandingQuantity: 20_000_000,
			outstandingPacks: 2,
			packPriceMinor: 28_000,
			lineTotalMinor: 56_000,
		},
		{
			orderLineId: 'ol2',
			itemId: 'itm_2',
			itemName: 'Garlic sauce',
			baseUnit: 'g',
			countUnit: 'kg',
			supplierProductId: 'sp_2',
			packName: 'Tub',
			packBaseQuantity: 5_000_000,
			pricedByWeight: false,
			orderedPacks: 1,
			orderedQuantity: 5_000_000,
			receivedQuantity: 0,
			outstandingQuantity: 5_000_000,
			outstandingPacks: 1,
			packPriceMinor: 10_000,
			lineTotalMinor: 10_000,
		},
	],
}

function orderSummary(status: string) {
	return {
		id: 'o1',
		number: 12,
		locationId: 'main',
		supplierId: 's1',
		supplierName: 'Al Watania',
		status,
		expectedDate: '2026-11-12',
		cutoff: null,
		note: null,
		createdBy: { kind: 'operator', id: 'u1' },
		createdAt: 1,
		sentAt: 2,
		sentVia: 'email',
		closedAt: status === 'received' ? 9 : null,
		lineCount: 2,
		receivedLineCount: 1,
		version: 5,
	}
}

function deliveryAnswer(status = 'partly_received') {
	return {
		delivery: {
			id: 'd1',
			locationId: 'main',
			supplierId: 's1',
			supplierName: 'Al Watania',
			status: 'received',
			invoiceNumber: null,
			invoiceDate: null,
			businessDate: '2026-11-12',
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
		order: orderSummary(status),
	}
}

const CREDIT = {
	locale: 'en',
	subject: 'Order 12: short delivery',
	text: 'Hello, order 12 arrived short:\n- Garlic sauce: 1 Tub missing',
	waLink: 'https://wa.me/966500000000?text=short',
	mailto: 'mailto:orders@watania.example?subject=short',
	deliveryId: 'd1',
	orderId: 'o1',
	supplierName: 'Al Watania',
	lines: [],
	totalMinor: 10_000,
	currency: 'SAR',
}

type Region = {
	prefill?: () => unknown
	record?: () => unknown
	put?: () => Response
}

function region(options: Region = {}) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path === '/suppliers') return { suppliers: [] }
		if (path === '/suppliers/s1') return { products: [] }
		if (path === '/orders/o1/receive-prefill') {
			return options.prefill?.() ?? PREFILL
		}
		if (path === '/deliveries' && init?.method === 'POST') {
			return options.record?.() ?? deliveryAnswer()
		}
		if (path === '/deliveries/d1/credit-message') return CREDIT
		if (path === '/deliveries/d1/invoice-photo') {
			return {
				key: 'inventory-invoices/o/d1/abc.jpg',
				method: 'PUT',
				uploadUrl: 'https://files.example/upload',
				headers: { 'Content-Type': 'image/jpeg' },
				expiresAt: 5,
				maxBytes: 5_242_880,
			}
		}
		if (path === '/deliveries/d1/invoice-photo/confirm') {
			return { ...deliveryAnswer().delivery, hasPhoto: true }
		}
		throw new Error(`unexpected request ${path}`)
	})
}

function setup(
	request: InventoryClient['request'],
	props: {
		canSeeCost?: boolean
		purchasingEnabled?: boolean
		orderId?: string | null
	} = {},
) {
	return renderInventory(
		<RecordDeliveryScreen
			orgSlug="acme"
			locationId="main"
			currency="SAR"
			dataRegion="ksa"
			canEdit
			canSeeCost={props.canSeeCost ?? true}
			canManagePurchasing={props.canSeeCost ?? true}
			purchasingEnabled={props.purchasingEnabled ?? true}
			orderId={props.orderId === undefined ? 'o1' : props.orderId}
			search=""
		/>,
		{ request },
	)
}

async function lines() {
	return screen.findByTestId('delivery-lines')
}

function deliveryPost(request: ReturnType<typeof region>) {
	return request.mock.calls.findIndex(
		([path, init]) => path === '/deliveries' && init?.method === 'POST',
	)
}

describe('receiving against an order', () => {
	it('starts each line at what is still to come, at the supplier price, with what was ordered beside it', async () => {
		setup(region())
		await lines()
		expect(screen.getByTestId('receive-order-info')).toHaveTextContent(
			'Order 12 from Al Watania',
		)
		expect(screen.getByTestId('delivery-line-packs-ol1')).toHaveValue('2')
		expect(screen.getByTestId('delivery-line-price-ol1')).toHaveValue('280.00')
		expect(screen.getByTestId('delivery-line-ordered-ol1')).toHaveTextContent(
			'Ordered 3 × Box · 30 kg',
		)
		expect(screen.getByTestId('delivery-line-ordered-ol1')).toHaveTextContent(
			'already received 10 kg',
		)
		expect(screen.getByTestId('delivery-line-packs-ol2')).toHaveValue('1')
		// The order decides the items and the supplier.
		expect(screen.queryByTestId('delivery-add-item')).toBeNull()
		expect(screen.queryByTestId('delivery-supplier')).toBeNull()
		expect(screen.getByRole('button', { name: 'Save delivery' })).toBeEnabled()
	})

	it('highlights a price that moved against the supplier price', async () => {
		setup(region())
		await lines()
		const price = screen.getByTestId('delivery-line-price-ol1')
		await userEvent.clear(price)
		await userEvent.type(price, '308')
		expect(
			await screen.findByTestId('delivery-line-change-ol1'),
		).toHaveTextContent('+10%')
	})

	it('records the delivery against the order, line by line', async () => {
		const request = region()
		setup(request)
		await lines()
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				'Delivery recorded.',
				expect.anything(),
			),
		)
		const body = sentJson(request, deliveryPost(request)) as {
			lines: Record<string, unknown>[]
		}
		expect(body).toMatchObject({
			supplierId: 's1',
			orderId: 'o1',
			currency: 'SAR',
			paid: false,
		})
		expect(body).not.toHaveProperty('closeOrder')
		expect(body.lines).toEqual([
			expect.objectContaining({
				itemId: 'itm_1',
				orderLineId: 'ol1',
				orderedQuantity: 30_000_000,
				quantity: 20_000_000,
				packs: 2,
				packPriceMinor: 28_000,
				lineTotalMinor: 56_000,
			}),
			expect.objectContaining({
				itemId: 'itm_2',
				orderLineId: 'ol2',
				quantity: 5_000_000,
			}),
		])
	})

	it('leaves out a line nothing arrived for, and says it came short', async () => {
		const request = region()
		setup(request)
		await lines()
		await userEvent.clear(screen.getByTestId('delivery-line-packs-ol2'))
		const short = await screen.findByTestId('delivery-short-lines')
		expect(short).toHaveTextContent('Garlic sauce')
		expect(short).toHaveTextContent('Missing')
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(3))
		const body = sentJson(request, deliveryPost(request)) as {
			lines: { itemId: string }[]
		}
		expect(body.lines.map((entry) => entry.itemId)).toEqual(['itm_1'])
	})

	it('closes the order short, then offers the credit message to copy or open', async () => {
		const request = region({ record: () => deliveryAnswer('received') })
		setup(request)
		await lines()
		await userEvent.clear(screen.getByTestId('delivery-line-packs-ol2'))
		await userEvent.click(screen.getByTestId('delivery-close-order'))
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		expect(
			sentJson(
				request,
				await waitFor(() => {
					const index = deliveryPost(request)
					expect(index).toBeGreaterThanOrEqual(0)
					return index
				}),
			),
		).toMatchObject({ closeOrder: true })
		const text = await screen.findByTestId('credit-text')
		expect(text).toHaveValue(CREDIT.text)
		expect(screen.getByTestId('credit-dialog')).toHaveTextContent('100')
		expect(screen.getByTestId('message-whatsapp')).toHaveAttribute(
			'href',
			CREDIT.waLink,
		)
		expect(screen.getByTestId('message-mailto')).toHaveAttribute(
			'href',
			CREDIT.mailto,
		)
		await userEvent.click(screen.getByTestId('message-copy'))
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(CREDIT.text))
		const creditCall = request.mock.calls.find(
			([path]) => path === '/deliveries/d1/credit-message',
		)
		expect(JSON.parse(String(creditCall?.[1]?.body))).toEqual({ locale: 'en' })
	})

	it('does not offer credit when the order is still open', async () => {
		const request = region()
		setup(request)
		await lines()
		await userEvent.clear(screen.getByTestId('delivery-line-packs-ol2'))
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
		expect(screen.queryByTestId('credit-dialog')).toBeNull()
	})

	it('says an order that is already closed cannot be received', async () => {
		setup(
			region({
				prefill: () => {
					throw new OperatorRequestError('x', 'order_closed', 409)
				},
			}),
		)
		expect(
			await screen.findByTestId('receive-prefill-error'),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Save delivery' })).toBeDisabled()
	})

	it('is not available while the purchasing flag is off', async () => {
		setup(region(), { purchasingEnabled: false })
		expect(await screen.findByTestId('delivery-needs-cost')).toHaveTextContent(
			'not turned on',
		)
	})
})

describe('recording quantities only, without the cost grant', () => {
	it('asks for how much arrived and no prices, VAT or paid', async () => {
		setup(region(), { canSeeCost: false })
		await lines()
		expect(screen.getByTestId('delivery-quantity-only')).toBeInTheDocument()
		expect(screen.queryByTestId('delivery-line-price-ol1')).toBeNull()
		expect(screen.queryByTestId('delivery-line-total-ol1')).toBeNull()
		expect(screen.queryByTestId('delivery-vat')).toBeNull()
		expect(screen.queryByTestId('delivery-invoice-total')).toBeNull()
		expect(screen.queryByTestId('delivery-paid')).toBeNull()
		expect(screen.queryByTestId('delivery-summary')).toBeNull()
		expect(screen.getByTestId('record-delivery').textContent).not.toMatch(
			/\d{2,}[.,]\d{2}/,
		)
	})

	it('sends quantities and the order, and no money', async () => {
		const request = region()
		setup(request, { canSeeCost: false })
		await lines()
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Delivery recorded.', {
				description: 'Prices still need to be confirmed.',
			}),
		)
		const body = sentJson(request, deliveryPost(request)) as Record<
			string,
			unknown
		> & { lines: Record<string, unknown>[] }
		expect(body).toMatchObject({
			quantityOnly: true,
			orderId: 'o1',
			paid: false,
		})
		for (const key of ['currency', 'vatMinor', 'totalMinor']) {
			expect(body).not.toHaveProperty(key)
		}
		for (const entry of body.lines) {
			expect(entry).not.toHaveProperty('lineTotalMinor')
			expect(entry).not.toHaveProperty('packPriceMinor')
		}
	})

	it('records a plain delivery as quantities only too', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path, init) => {
			if (path === '/suppliers') {
				return {
					suppliers: [
						{
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
							productCount: 0,
							unpaidCount: 0,
						},
					],
				}
			}
			if (path === '/deliveries' && init?.method === 'POST') {
				return deliveryAnswer()
			}
			return { suppliers: [] }
		})
		setup(request, { canSeeCost: false, orderId: null })
		expect(
			await screen.findByTestId('delivery-quantity-only'),
		).toBeInTheDocument()
		expect(screen.queryByTestId('delivery-line-price-x')).toBeNull()
	})
})

describe('the invoice photo', () => {
	function photoFile() {
		return new File([new Uint8Array(2000)], 'invoice.jpg', {
			type: 'image/jpeg',
		})
	}

	it('previews the chosen photo, then uploads it straight to storage once the delivery is saved', async () => {
		const request = region()
		const put = vi.fn(async () => new Response(null, { status: 200 }))
		vi.stubGlobal('fetch', put)
		setup(request)
		await lines()
		await userEvent.upload(
			screen.getByTestId('delivery-photo-input'),
			photoFile(),
		)
		expect(await screen.findByTestId('delivery-photo-preview')).toHaveAttribute(
			'src',
			'blob:invoice',
		)
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
		expect(put).toHaveBeenCalledWith(
			'https://files.example/upload',
			expect.objectContaining({ method: 'PUT' }),
		)
		const paths = request.mock.calls.map(([path]) => path)
		expect(paths).toEqual(
			expect.arrayContaining([
				'/deliveries/d1/invoice-photo',
				'/deliveries/d1/invoice-photo/confirm',
			]),
		)
		expect(toast.warning).not.toHaveBeenCalled()
	})

	it('keeps the delivery and says so when the photo could not be uploaded', async () => {
		const request = region()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 500 })),
		)
		setup(request)
		await lines()
		await userEvent.upload(
			screen.getByTestId('delivery-photo-input'),
			photoFile(),
		)
		await userEvent.click(screen.getByRole('button', { name: 'Save delivery' }))
		await waitFor(() => expect(toast.warning).toHaveBeenCalled())
		expect(toast.warning.mock.calls[0]?.[0]).toContain('delivery is saved')
		expect(request.mock.calls.some(([path]) => path.endsWith('/confirm'))).toBe(
			false,
		)
	})

	it('can be removed before saving, and refuses another kind of file', async () => {
		setup(region())
		await lines()
		const input = screen.getByTestId('delivery-photo-input')
		await userEvent.upload(input, photoFile())
		await userEvent.click(await screen.findByTestId('delivery-photo-remove'))
		expect(screen.queryByTestId('delivery-photo-preview')).toBeNull()
		await userEvent.upload(
			input,
			new File(['x'], 'invoice.pdf', { type: 'application/pdf' }),
			{ applyAccept: false },
		)
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'JPEG, PNG or WebP',
		)
		expect(
			within(screen.getByTestId('record-delivery')).queryByTestId(
				'delivery-photo-preview',
			),
		).toBeNull()
	})
})
