// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { ReviewOrderScreen } from './review-order-screen.tsx'

const toast = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

const print = vi.fn()
const open = vi.fn()
const writeText = vi.fn(async () => {})

beforeEach(() => {
	toast.success.mockReset()
	toast.error.mockReset()
	print.mockReset()
	open.mockReset()
	writeText.mockReset().mockResolvedValue(undefined)
	vi.stubGlobal('print', print)
	vi.stubGlobal('open', open)
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText },
		configurable: true,
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
})

function line(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		itemId: `i-${id}`,
		itemName: id === 'l1' ? 'Chicken thighs' : 'Garlic sauce',
		baseUnit: 'g',
		countUnit: 'kg',
		supplierProductId: `sp-${id}`,
		packName: id === 'l1' ? 'Box' : 'Tub',
		packBaseQuantity: id === 'l1' ? 10_000_000 : 5_000_000,
		pricedByWeight: false,
		packs: id === 'l1' ? 2 : 1,
		quantity: id === 'l1' ? 20_000_000 : 5_000_000,
		receivedQuantity: 0,
		suggestedPacks: id === 'l1' ? 2 : 1,
		onHand: 6_000_000,
		fillUpToQuantity: 30_000_000,
		packPriceMinor: id === 'l1' ? 28_000 : 10_000,
		lineTotalMinor: id === 'l1' ? 56_000 : 10_000,
		...overrides,
	}
}

function orderDetail(overrides: Record<string, unknown> = {}) {
	return {
		id: 'o1',
		number: 12,
		locationId: 'main',
		supplierId: 's1',
		supplierName: 'Al Watania',
		status: 'draft',
		expectedDate: '2026-11-12',
		cutoff: { date: '2026-11-11', time: '16:00' },
		note: null,
		createdBy: { kind: 'operator', id: 'u1' },
		createdAt: 1,
		sentAt: null,
		sentVia: null,
		closedAt: null,
		lineCount: 2,
		receivedLineCount: 0,
		version: 3,
		currency: 'SAR',
		totalMinor: 66_000,
		minimumOrderMinor: 100_000,
		shortOfMinimumMinor: 34_000,
		lines: [line('l1'), line('l2')],
		deliveries: [],
		supplierOrderChannel: 'email',
		supplierEmail: 'orders@watania.example',
		supplierPhone: '+966500000000',
		...overrides,
	}
}

function sendAnswer(overrides: Record<string, unknown> = {}) {
	return {
		locale: 'en',
		subject: 'Order 12 for Thu',
		text: 'Order 12\n2 Box Chicken thighs',
		waLink: 'https://wa.me/966500000000?text=Order',
		mailto: 'mailto:orders@watania.example?subject=Order',
		order: orderDetail({
			status: 'sent',
			sentAt: 9,
			sentVia: 'email',
			version: 4,
		}),
		channel: 'email',
		emailSent: true,
		emailSkipped: null,
		...overrides,
	}
}

const SUPPLIER = {
	id: 's1',
	name: 'Al Watania',
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
	productCount: 3,
	unpaidCount: 0,
	products: [
		{
			id: 'sp-l1',
			supplierId: 's1',
			itemId: 'i-l1',
			itemName: 'Chicken thighs',
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			pricedByWeight: false,
			sku: null,
			preferred: true,
			version: 1,
			priceMinor: 28_000,
		},
		{
			id: 'sp-new',
			supplierId: 's1',
			itemId: 'i-new',
			itemName: 'Pita bread',
			packName: 'Bag',
			packBaseQuantity: 1_000_000,
			pricedByWeight: false,
			sku: null,
			preferred: false,
			version: 1,
			priceMinor: 900,
		},
	],
}

type Region = {
	order?: Record<string, unknown>
	send?: () => unknown
	patch?: () => unknown
	text?: string
}

function region(options: Region = {}) {
	let current = orderDetail(options.order)
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path === '/orders/o1' && !init?.method) return current
		if (path === '/suppliers/s1') return SUPPLIER
		if (path === '/orders/o1' && init?.method === 'PATCH') {
			if (options.patch) return options.patch()
			const body = JSON.parse(String(init.body)) as {
				lines?: { packs: number; itemId: string }[]
				note?: string | null
			}
			current = orderDetail({
				...options.order,
				version: 4,
				note: body.note ?? null,
				lines: body.lines
					? body.lines.map((entry, index) =>
							line(entry.itemId === 'i-l1' ? 'l1' : 'l2', {
								id: `n${index}`,
								packs: entry.packs,
							}),
						)
					: current.lines,
			})
			return current
		}
		if (path === '/orders/o1/send') {
			return options.send?.() ?? sendAnswer()
		}
		if (path === '/orders/o1/cancel') {
			return orderDetail({ status: 'cancelled', version: 5 })
		}
		if (path.startsWith('/orders/o1/text')) {
			return {
				locale: 'en',
				subject: 'Order 12',
				text: options.text ?? 'Order 12\n2 Box Chicken thighs',
				waLink: null,
				mailto: null,
			}
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
	} = {},
) {
	return renderInventory(
		<ReviewOrderScreen
			orgSlug="acme"
			orderId="o1"
			currency="SAR"
			canEdit={props.canEdit ?? true}
			canSeeCost={props.canSeeCost ?? true}
			canManagePurchasing={props.canManagePurchasing ?? true}
			search=""
		/>,
		{ request },
	)
}

async function more(lineId: string) {
	const row = await screen.findByTestId(`order-line-${lineId}`)
	await userEvent.click(within(row).getByRole('button', { name: 'More' }))
}

describe('ReviewOrderScreen: editing a draft', () => {
	it('shows the lines in packs with the total, the minimum and the cut-off', async () => {
		setup(region())
		await screen.findByTestId('order-lines')
		expect(screen.getByTestId('order-status')).toHaveTextContent('Draft')
		expect(screen.getByTestId('order-line-packs-l1')).toHaveValue('2')
		expect(screen.getByTestId('order-line-l1')).toHaveTextContent('Box · 10 kg')
		expect(screen.getByTestId('order-line-l1')).toHaveTextContent('20 kg')
		expect(screen.getByTestId('order-total')).toHaveTextContent('660')
		expect(screen.getByTestId('order-minimum')).toHaveTextContent('340')
		expect(screen.getByTestId('order-minimum')).toHaveTextContent('1,000')
		expect(screen.getByTestId('order-cutoff')).toHaveTextContent(
			/Order by Wed.*4:00\s?PM/,
		)
		expect(screen.getByTestId('order-item-count')).toHaveTextContent('2')
	})

	it('moves the total with a stepper and drops the minimum warning once it is met', async () => {
		setup(region())
		await more('l1')
		await more('l1')
		await more('l1')
		await more('l1')
		await waitFor(() =>
			expect(screen.getByTestId('order-line-packs-l1')).toHaveValue('6'),
		)
		// 6 boxes x 280 + 1 tub x 100 = 1,780.
		expect(screen.getByTestId('order-total')).toHaveTextContent('1,780')
		expect(screen.queryByTestId('order-minimum')).toBeNull()
		expect(screen.getByTestId('order-line-suggested-l1')).toHaveTextContent(
			'Suggested 2',
		)
	})

	it('saves a draft with the lines as typed and the version it read', async () => {
		const request = region()
		setup(request)
		await more('l1')
		await userEvent.type(screen.getByTestId('order-note'), 'Call on arrival')
		await userEvent.click(screen.getByRole('button', { name: 'Save draft' }))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Draft saved.'),
		)
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/orders/o1' && init?.method === 'PATCH',
		)
		expect(sentJson(request, index)).toEqual({
			expectedVersion: 3,
			lines: [
				{ itemId: 'i-l1', supplierProductId: 'sp-l1', packs: 3 },
				{ itemId: 'i-l2', supplierProductId: 'sp-l2', packs: 1 },
			],
			note: 'Call on arrival',
		})
	})

	it('has nothing to save until something changes', async () => {
		setup(region())
		await screen.findByTestId('order-lines')
		expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
	})

	it('adds an item the supplier sells and removes a line', async () => {
		const request = region()
		setup(request)
		await userEvent.click(await screen.findByTestId('order-add-item'))
		await userEvent.click(
			await screen.findByRole('option', { name: /Pita bread/ }),
		)
		expect(await screen.findByText('Pita bread')).toBeInTheDocument()
		await userEvent.click(screen.getByTestId('order-line-remove-l2'))
		expect(screen.queryByTestId('order-line-l2')).toBeNull()
		await userEvent.click(screen.getByRole('button', { name: 'Save draft' }))
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/orders/o1' && init?.method === 'PATCH',
		)
		expect(sentJson(request, index)).toMatchObject({
			lines: [
				{ itemId: 'i-l1', packs: 2 },
				{ itemId: 'i-new', supplierProductId: 'sp-new', packs: 1 },
			],
		})
	})

	it('shows no money without the cost grant', async () => {
		setup(
			region({
				order: {
					totalMinor: undefined,
					minimumOrderMinor: undefined,
					currency: undefined,
					lines: [
						line('l1', {
							packPriceMinor: undefined,
							lineTotalMinor: undefined,
						}),
					],
				},
			}),
			{ canSeeCost: false },
		)
		await screen.findByTestId('order-lines')
		expect(screen.queryByTestId('order-total')).toBeNull()
		expect(screen.getByTestId('review-order').textContent).not.toMatch(
			/\d{2,}[.,]\d{2}/,
		)
	})

	it('is read-only, and cannot send, without the purchasing role', async () => {
		setup(region(), { canManagePurchasing: false })
		await screen.findByTestId('order-lines')
		expect(screen.getByTestId('order-read-only')).toBeInTheDocument()
		expect(screen.queryByTestId('order-send-menu')).toBeNull()
		expect(screen.queryByTestId('order-line-packs-l1')).toBeNull()
		expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
	})

	it('explains a failed save and keeps what was typed', async () => {
		setup(
			region({
				patch: () => {
					throw new OperatorRequestError('x', 'stale_version', 409)
				},
			}),
		)
		await more('l1')
		await userEvent.click(screen.getByRole('button', { name: 'Save draft' }))
		expect(await screen.findByTestId('order-form-error')).toHaveTextContent(
			'Someone else changed this first',
		)
		expect(screen.getByTestId('order-line-packs-l1')).toHaveValue('3')
	})
})

async function openSend(channel: 'email' | 'whatsapp' | 'copy' | 'pdf') {
	await userEvent.click(await screen.findByTestId('order-send-menu'))
	await userEvent.click(await screen.findByTestId(`order-send-${channel}`))
	return screen.findByTestId('send-dialog')
}

describe('ReviewOrderScreen: sending', () => {
	it('asks once more and sends nothing until Send is pressed', async () => {
		const request = region()
		setup(request)
		const dialog = await openSend('email')
		expect(dialog).toHaveTextContent('orders@watania.example')
		expect(
			request.mock.calls.some(([path]) => path === '/orders/o1/send'),
		).toBe(false)
	})

	it('emails the order and says it was sent', async () => {
		const request = region()
		setup(request)
		await openSend('email')
		await userEvent.click(screen.getByTestId('send-confirm'))
		expect(await screen.findByTestId('send-email-sent')).toHaveTextContent(
			'orders@watania.example',
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/orders/o1/send',
		)
		expect(sentJson(request, index)).toEqual({
			expectedVersion: 3,
			channel: 'email',
			locale: 'en',
		})
	})

	it('saves unsaved changes first and sends with the new version', async () => {
		const request = region()
		setup(request)
		await more('l1')
		await openSend('email')
		await userEvent.click(screen.getByTestId('send-confirm'))
		await screen.findByTestId('send-result')
		const paths = request.mock.calls
			.filter(([, init]) => init?.method)
			.map(([path, init]) => `${init?.method} ${path}`)
		expect(paths).toEqual(['PATCH /orders/o1', 'POST /orders/o1/send'])
		const send = request.mock.calls.findIndex(
			([path]) => path === '/orders/o1/send',
		)
		expect(sentJson(request, send)).toMatchObject({ expectedVersion: 4 })
	})

	it('falls back to the email app, in plain words, when the region could not email', async () => {
		setup(
			region({
				send: () =>
					sendAnswer({ emailSent: false, emailSkipped: 'no_supplier_email' }),
			}),
		)
		await openSend('email')
		await userEvent.click(screen.getByTestId('send-confirm'))
		const fallback = await screen.findByTestId('send-email-fallback')
		expect(fallback).toHaveTextContent(
			'This supplier has no email address yet.',
		)
		expect(fallback).toHaveTextContent('Nothing was emailed')
		expect(screen.getByTestId('message-mailto')).toHaveAttribute(
			'href',
			'mailto:orders@watania.example?subject=Order',
		)
		await userEvent.click(screen.getByTestId('message-copy'))
		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith('Order 12\n2 Box Chicken thighs'),
		)
	})

	it('opens WhatsApp with the order written out', async () => {
		setup(region({ send: () => sendAnswer({ channel: 'whatsapp' }) }))
		await openSend('whatsapp')
		await userEvent.click(screen.getByTestId('send-confirm'))
		await screen.findByTestId('send-result')
		expect(open).toHaveBeenCalledWith(
			'https://wa.me/966500000000?text=Order',
			'_blank',
			'noopener,noreferrer',
		)
		expect(screen.getByTestId('message-whatsapp')).toHaveAttribute(
			'href',
			'https://wa.me/966500000000?text=Order',
		)
	})

	it('copies the text when the order is too long for a WhatsApp link', async () => {
		setup(
			region({ send: () => sendAnswer({ channel: 'whatsapp', waLink: null }) }),
		)
		await openSend('whatsapp')
		await userEvent.click(screen.getByTestId('send-confirm'))
		const result = await screen.findByTestId('send-result')
		expect(result).toHaveTextContent('too long for a WhatsApp link')
		expect(open).not.toHaveBeenCalled()
		expect(screen.queryByTestId('message-whatsapp')).toBeNull()
		expect(screen.getByTestId('message-copy')).toBeInTheDocument()
	})

	it('copies the order text', async () => {
		setup(region({ send: () => sendAnswer({ channel: 'copy' }) }))
		await openSend('copy')
		await userEvent.click(screen.getByTestId('send-confirm'))
		expect(await screen.findByTestId('send-copy-note')).toHaveTextContent(
			'The order text is copied.',
		)
		expect(writeText).toHaveBeenCalledWith('Order 12\n2 Box Chicken thighs')
	})

	it('prints the same text for a PDF', async () => {
		setup(region({ send: () => sendAnswer({ channel: 'pdf' }) }))
		await openSend('pdf')
		await userEvent.click(screen.getByTestId('send-confirm'))
		await waitFor(() => expect(print).toHaveBeenCalledTimes(1))
		expect(screen.getByTestId('order-print-sheet')).toHaveTextContent(
			'2 Box Chicken thighs',
		)
		expect(screen.getByTestId('order-print-sheet')).toHaveTextContent(
			'Order 12 for Al Watania',
		)
	})

	it('keeps the order a draft and says why when sending fails', async () => {
		setup(
			region({
				send: () => {
					throw new OperatorRequestError('x', 'email_failed', 502)
				},
			}),
		)
		await openSend('email')
		await userEvent.click(screen.getByTestId('send-confirm'))
		expect(await screen.findByTestId('send-error')).toHaveTextContent(
			'The email could not be sent',
		)
		expect(screen.queryByTestId('send-result')).toBeNull()
	})

	it('cannot send an order with no items', async () => {
		setup(
			region({
				order: {
					lines: [],
					lineCount: 0,
					totalMinor: 0,
					shortOfMinimumMinor: 100_000,
				},
			}),
		)
		await screen.findByTestId('order-no-lines')
		expect(screen.getByTestId('order-send-menu')).toBeDisabled()
	})

	it('prints the order from the page too', async () => {
		setup(region())
		await userEvent.click(await screen.findByTestId('order-print'))
		await waitFor(() => expect(print).toHaveBeenCalled())
	})
})

describe('ReviewOrderScreen: a sent order', () => {
	const sent = {
		status: 'sent',
		sentAt: Date.UTC(2026, 10, 10, 9),
		sentVia: 'email',
		cutoff: null,
		lines: [line('l1', { receivedQuantity: 10_000_000 }), line('l2')],
	}

	it('shows the lines as they were ordered, with what has arrived', async () => {
		setup(region({ order: sent }))
		await screen.findByTestId('order-lines')
		expect(screen.queryByTestId('order-line-packs-l1')).toBeNull()
		expect(screen.getByTestId('order-status')).toHaveTextContent('Sent')
		expect(screen.getByTestId('order-line-received-l1')).toHaveTextContent(
			'Received 10 kg',
		)
		expect(screen.getByTestId('order-line-l2')).toHaveTextContent(
			'Nothing received yet',
		)
		expect(screen.getByTestId('order-receive')).toHaveAttribute(
			'href',
			'/acme/inventory/purchasing/deliveries/new?orderId=o1',
		)
	})

	it('can be sent again, and its note can still change', async () => {
		const request = region({ order: sent })
		setup(request)
		await screen.findByTestId('order-lines')
		expect(screen.getByTestId('order-send-menu')).toHaveTextContent(
			'Send again',
		)
		await userEvent.type(screen.getByTestId('order-note'), 'Gate code 4411')
		await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Order updated.'),
		)
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/orders/o1' && init?.method === 'PATCH',
		)
		const body = sentJson(request, index) as Record<string, unknown>
		expect(body).toEqual({ expectedVersion: 3, note: 'Gate code 4411' })
	})

	it('cancels the order after asking', async () => {
		const request = region({ order: sent })
		setup(request)
		await userEvent.click(await screen.findByTestId('order-cancel'))
		await userEvent.type(
			screen.getByTestId('order-cancel-note'),
			'Wrong supplier',
		)
		await userEvent.click(screen.getByTestId('order-cancel-confirm'))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Order cancelled.'),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/orders/o1/cancel',
		)
		expect(sentJson(request, index)).toEqual({
			expectedVersion: 3,
			note: 'Wrong supplier',
		})
	})

	it('a received order can only be looked at', async () => {
		setup(region({ order: { ...sent, status: 'received' } }))
		await screen.findByTestId('order-lines')
		expect(screen.queryByTestId('order-send-menu')).toBeNull()
		expect(screen.queryByTestId('order-receive')).toBeNull()
		expect(screen.queryByTestId('order-cancel')).toBeNull()
		expect(screen.getByTestId('order-note')).toBeDisabled()
	})
})

describe('ReviewOrderScreen: loading', () => {
	it('says so, with a way back, when the order cannot be read', async () => {
		setup(
			vi.fn<InventoryClient['request']>(async () => {
				throw new OperatorRequestError('x', 'not_found', 404)
			}),
		)
		expect(await screen.findByTestId('order-load-error')).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: 'Back to purchasing' }),
		).toHaveAttribute('href', '/acme/inventory/purchasing')
	})
})
