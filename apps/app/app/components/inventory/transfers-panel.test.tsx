// @vitest-environment jsdom
import { type TransferDetail, type TransferSummary } from '@repo/inventory'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { stockItem } from '#tests/inventory-fixtures.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { TransfersPanel } from './transfers-panel.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const originalScrollIntoView = Element.prototype.scrollIntoView
beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	Element.prototype.scrollIntoView = vi.fn()
	window.localStorage.clear()
})
afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

const PLACES = [
	{ id: 'main', name: 'Downtown' },
	{ id: 'kitchen', name: 'Central kitchen' },
]

const summary = (over: Partial<TransferSummary> = {}): TransferSummary => ({
	id: 'tr1',
	number: 1,
	kind: 'request',
	status: 'requested',
	fromLocationId: 'kitchen',
	toLocationId: 'main',
	lineCount: 2,
	note: null,
	createdAt: 1,
	sentAt: null,
	receivedAt: null,
	missingLines: 0,
	version: 1,
	...over,
})

const detail = (over: Partial<TransferDetail> = {}): TransferDetail => ({
	...summary(),
	lines: [
		{
			itemId: 'itm_1',
			itemName: 'Chicken thighs',
			baseUnit: 'g',
			countUnit: 'kg',
			units: [],
			requestedQuantity: 5_000_000,
			sentQuantity: 4_000_000,
			receivedQuantity: null,
			missingQuantity: null,
			onHandAtSender: 9_000_000,
		},
	],
	...over,
})

function region(
	rows: TransferSummary[],
	extra: Partial<Record<string, () => unknown>> = {},
) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path.startsWith('/transfers?')) return { transfers: rows }
		if (path.startsWith('/items?')) {
			return { items: [stockItem()], total: 1, nextCursor: null }
		}
		for (const [key, answer] of Object.entries(extra)) {
			if (path === key) return answer?.()
		}
		if (path === '/transfers/tr1' && !init?.method) return detail()
		if (path === '/transfers' && init?.method === 'POST') return detail()
		if (path === '/transfers/tr1/send') return detail({ status: 'sent' })
		if (path === '/transfers/tr1/receive') return detail({ status: 'received' })
		if (path === '/transfers/tr1/cancel') return detail({ status: 'cancelled' })
		throw new Error(`unexpected request ${path}`)
	})
}

const draw = (
	request: InventoryClient['request'],
	props: Partial<React.ComponentProps<typeof TransfersPanel>> = {},
) =>
	renderInventory(
		<TransfersPanel
			locationId="main"
			places={PLACES}
			canEdit
			canSeeCost={false}
			currency="SAR"
			{...props}
		/>,
		{ request },
	)

describe('TransfersPanel', () => {
	it('says when nothing is moving', async () => {
		draw(region([]))
		expect(await screen.findByTestId('transfers-empty')).toBeInTheDocument()
	})

	it('lists what is moving with the buttons this place may press', async () => {
		draw(
			region([
				summary(),
				summary({
					id: 'tr2',
					number: 2,
					kind: 'transfer',
					status: 'sent',
					fromLocationId: 'kitchen',
					toLocationId: 'main',
				}),
				summary({
					id: 'tr3',
					number: 3,
					kind: 'transfer',
					status: 'draft',
					fromLocationId: 'main',
					toLocationId: 'kitchen',
				}),
			]),
		)
		const asked = await screen.findByTestId('transfer-tr1')
		expect(asked).toHaveTextContent('You asked Central kitchen')
		expect(within(asked).getByText('Requested')).toBeInTheDocument()
		expect(within(asked).getByTestId('transfer-cancel-tr1')).toBeVisible()
		expect(within(asked).queryByTestId('transfer-send-tr1')).toBeNull()

		const incoming = screen.getByTestId('transfer-tr2')
		expect(incoming).toHaveTextContent('From Central kitchen')
		expect(within(incoming).getByTestId('transfer-receive-tr2')).toBeVisible()
		expect(within(incoming).queryByTestId('transfer-cancel-tr2')).toBeNull()

		const outgoing = screen.getByTestId('transfer-tr3')
		expect(outgoing).toHaveTextContent('To Central kitchen')
		expect(within(outgoing).getByTestId('transfer-send-tr3')).toBeVisible()
		expect(within(outgoing).getByTestId('transfer-cancel-tr3')).toBeVisible()
	})

	it('shows no buttons to someone who may only look', async () => {
		draw(region([summary({ status: 'sent' })]), { canEdit: false })
		await screen.findByTestId('transfer-tr1')
		expect(screen.queryByTestId('transfer-receive-tr1')).toBeNull()
		expect(screen.queryByTestId('transfers-ask')).toBeNull()
	})

	it('confirms a receipt with the sent amount, and leaves untouched amounts to the region', async () => {
		const request = region([summary({ status: 'sent' })])
		draw(request)
		await userEvent.click(await screen.findByTestId('transfer-receive-tr1'))
		const dialog = await screen.findByTestId('confirm-transfer-dialog')
		expect(dialog).toHaveTextContent('Sent 4 kg')
		await userEvent.click(within(dialog).getByTestId('confirm-transfer-submit'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([p]) => p === '/transfers/tr1/receive'),
			).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([p]) => p === '/transfers/tr1/receive',
		)
		expect(sentJson(request, index)).toEqual({ expectedVersion: 1 })
	})

	it('sends less than asked when the amount is changed', async () => {
		const request = region([
			summary({ fromLocationId: 'main', toLocationId: 'kitchen' }),
		])
		draw(request)
		await userEvent.click(await screen.findByTestId('transfer-send-tr1'))
		const dialog = await screen.findByTestId('confirm-transfer-dialog')
		expect(dialog).toHaveTextContent('Asked 5 kg, you have 9 kg')
		const amount = within(dialog).getByTestId('confirm-transfer-amount-itm_1')
		await userEvent.clear(amount)
		await userEvent.type(amount, '3')
		await userEvent.click(within(dialog).getByTestId('confirm-transfer-submit'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([p]) => p === '/transfers/tr1/send'),
			).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([p]) => p === '/transfers/tr1/send',
		)
		expect(sentJson(request, index)).toEqual({
			expectedVersion: 1,
			lines: [{ itemId: 'itm_1', amount: 3, unit: 'kg' }],
		})
	})

	it('cancels a request this place made, with the version it read', async () => {
		const request = region([summary()])
		draw(request)
		await userEvent.click(await screen.findByTestId('transfer-cancel-tr1'))
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith('/transfers/tr1/cancel', {
				method: 'POST',
				body: JSON.stringify({ expectedVersion: 1 }),
			}),
		)
	})

	it('makes a request: the other place gives, this place receives', async () => {
		const request = region([])
		draw(request)
		await userEvent.click(await screen.findByTestId('transfers-ask'))
		const dialog = await screen.findByTestId('create-transfer-dialog')
		// Nothing is sent until the form is complete.
		await userEvent.click(within(dialog).getByTestId('create-transfer-submit'))
		expect(request.mock.calls.some(([p]) => p === '/transfers')).toBe(false)

		await userEvent.click(within(dialog).getByTestId('transfer-place'))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Central kitchen' }),
		)
		await userEvent.click(within(dialog).getByTestId('transfer-line-0-item'))
		await userEvent.click(
			await screen.findByTestId('transfer-line-0-item-option-itm_1'),
		)
		await userEvent.type(
			within(dialog).getByTestId('transfer-line-0-amount'),
			'2',
		)
		await userEvent.click(within(dialog).getByTestId('create-transfer-submit'))
		await waitFor(() =>
			expect(request.mock.calls.some(([p]) => p === '/transfers')).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([p, init]) => p === '/transfers' && init?.method === 'POST',
		)
		expect(sentJson(request, index)).toEqual({
			clientId: expect.stringMatching(/^t-/),
			kind: 'request',
			fromLocationId: 'kitchen',
			toLocationId: 'main',
			lines: [{ itemId: 'itm_1', amount: 2, unit: 'kg' }],
		})
	})

	it('shows the region failing without hiding the list behind it', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => {
			throw new OperatorRequestError('boom', 'feature_disabled', 503)
		})
		draw(request)
		expect(await screen.findByTestId('transfers-error')).toBeVisible()
	})
})
