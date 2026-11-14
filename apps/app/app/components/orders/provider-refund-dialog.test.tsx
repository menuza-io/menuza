// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { ProviderRefundDialog } from './provider-refund-dialog.tsx'

const ORDER = {
	id: 'ord_1',
	currency: 'usd',
	totalCents: 2000,
	refundedCents: 500,
	refundPendingCents: 0,
	refundableCents: 1500,
}

const REFUND = {
	refundId: 'rf_1',
	orderId: 'ord_1',
	amountCents: 1500,
	currency: 'USD',
	status: 'succeeded',
	failureCode: null,
}

function reply(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function setup(order = ORDER) {
	const onDone = vi.fn()
	const onRefresh = vi.fn()
	const onOpenChange = vi.fn()
	const view = renderStaff(
		<ProviderRefundDialog
			order={order}
			orgSlug="acme"
			open
			onOpenChange={onOpenChange}
			onDone={onDone}
			onRefresh={onRefresh}
		/>,
	)
	return { onDone, onRefresh, onOpenChange, view }
}

async function submit(note = 'Cold fries') {
	await userEvent.type(screen.getByTestId('provider-refund-note'), note)
	await userEvent.click(screen.getByTestId('provider-refund-submit'))
}

function headersOf(fetchMock: ReturnType<typeof vi.fn>, call: number) {
	return (fetchMock.mock.calls[call]?.[1] as RequestInit).headers as Record<
		string,
		string
	>
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('ProviderRefundDialog', () => {
	it('says the money goes to the card and fees are usually kept', () => {
		vi.stubGlobal('fetch', vi.fn())
		setup()
		const dialog = screen.getByTestId('provider-refund-dialog')
		expect(dialog).toHaveTextContent(
			"The money goes back to the guest's card through your payment provider.",
		)
		expect(dialog).toHaveTextContent('fees are usually not returned to you')
		expect(screen.getByTestId('provider-refund-left')).toHaveTextContent(
			'$15.00',
		)
	})

	it('posts a full refund with a key and reports the answer', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(reply(200, { refund: REFUND, replayed: false }))
		vi.stubGlobal('fetch', fetchMock)
		const { onDone, onRefresh } = setup()
		await submit()
		await waitFor(() => expect(onDone).toHaveBeenCalled())
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/acme/orders/ord_1/refund')
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit
		expect(init.method).toBe('POST')
		expect(JSON.parse(init.body as string)).toEqual({
			full: true,
			note: 'Cold fries',
		})
		expect(headersOf(fetchMock, 0)['Idempotency-Key']).toMatch(/.{8,}/)
		expect(onDone.mock.calls[0]?.[0]).toMatchObject({
			delayed: false,
			refund: { status: 'succeeded' },
		})
		expect(onRefresh).toHaveBeenCalled()
	})

	it('posts part of the payment in cents', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(reply(200, { refund: REFUND, replayed: false }))
		vi.stubGlobal('fetch', fetchMock)
		const { onDone } = setup()
		await userEvent.click(screen.getByRole('combobox', { name: 'Refund' }))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Part of the payment' }),
		)
		await userEvent.type(screen.getByTestId('provider-refund-amount'), '4.50')
		await submit()
		await waitFor(() => expect(onDone).toHaveBeenCalled())
		expect(
			JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string),
		).toEqual({ amountCents: 450, note: 'Cold fries' })
	})

	it('refuses more than is left without calling the server', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		setup()
		await userEvent.click(screen.getByRole('combobox', { name: 'Refund' }))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Part of the payment' }),
		)
		await userEvent.type(screen.getByTestId('provider-refund-amount'), '20.00')
		await submit()
		expect(
			await screen.findByText('That is more than what is left to refund.'),
		).toBeInTheDocument()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('reads a delayed answer as pending', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				reply(202, {
					refund: { ...REFUND, status: 'pending' },
					replayed: false,
					delayed: true,
				}),
			),
		)
		const { onDone } = setup()
		await submit()
		await waitFor(() => expect(onDone).toHaveBeenCalled())
		expect(onDone.mock.calls[0]?.[0]).toMatchObject({ delayed: true })
	})

	it('keeps the key across a network retry and uses a new one after a final answer', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockResolvedValueOnce(reply(503, { error: 'regional_unavailable' }))
			.mockResolvedValueOnce(reply(409, { error: 'refund_pending' }))
			.mockResolvedValueOnce(reply(409, { error: 'refund_pending' }))
		vi.stubGlobal('fetch', fetchMock)
		const { onRefresh } = setup()
		await submit()
		expect(
			await screen.findByTestId('provider-refund-error'),
		).toHaveTextContent('trying again will not refund twice')
		await userEvent.click(screen.getByTestId('provider-refund-submit'))
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
		await userEvent.click(screen.getByTestId('provider-refund-submit'))
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
		const first = headersOf(fetchMock, 0)['Idempotency-Key']
		expect(headersOf(fetchMock, 1)['Idempotency-Key']).toBe(first)
		expect(headersOf(fetchMock, 2)['Idempotency-Key']).toBe(first)
		// The 409 was final: the next submit is a new refund.
		await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
		await userEvent.click(screen.getByTestId('provider-refund-submit'))
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
		expect(headersOf(fetchMock, 3)['Idempotency-Key']).not.toBe(first)
	})

	it.each([
		['refund_pending', 409, {}, 'Another refund for this order is still being'],
		['payment_disputed', 409, {}, 'disputed with the card issuer'],
		[
			'refund_exceeds_payment',
			422,
			{ refundableCents: 300 },
			'At most $3.00 can still be refunded.',
		],
		['impersonation_forbidden', 403, {}, 'viewing as another account'],
		['location_scope_unsupported', 403, {}, 'limited to some locations'],
		['regional_unavailable', 503, { retryable: true }, 'not reachable'],
		['refund_unavailable', 502, { retryable: true }, 'provider could not be'],
	])('words %s plainly', async (error, status, extra, text) => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(reply(status, { error, ...extra })),
		)
		const { onDone } = setup()
		await submit()
		expect(
			await screen.findByTestId('provider-refund-error'),
		).toHaveTextContent(text)
		expect(onDone).not.toHaveBeenCalled()
	})

	it('does not reload for an answer that leaves the order as it was', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(reply(403, { error: 'impersonation_forbidden' })),
		)
		const { onRefresh } = setup()
		await submit()
		await screen.findByTestId('provider-refund-error')
		expect(onRefresh).not.toHaveBeenCalled()
	})
})
