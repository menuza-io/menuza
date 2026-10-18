// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaymentPanel } from '#app/components/reservations/payment-panel.tsx'
import {
	apiError,
	createScriptedClient,
	type ScriptedCall,
} from '#app/components/reservations/scripted-test-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const NOW = 1_760_000_000_000

function row(over: Record<string, unknown> = {}) {
	return {
		id: 'pay_1',
		reservationId: 'rsv_1',
		kind: 'card_setup',
		purpose: 'guarantee',
		status: 'succeeded',
		amountMinor: 0,
		refundedMinor: 0,
		currency: 'USD',
		platformFeeBp: 0,
		platformFeeMinor: 0,
		attempt: 1,
		cardBrand: 'visa',
		cardLast4: '4242',
		cardExpMonth: 12,
		cardExpYear: 2030,
		declineCode: null,
		failureCode: null,
		disputeStatus: null,
		parentPaymentId: null,
		createdAt: NOW,
		updatedAt: NOW,
		...over,
	}
}

function list(
	payments: unknown[],
	reservation: Record<string, unknown> = {},
	policy: unknown = {
		kind: 'card_guarantee',
		noShowFeeMinor: 5000,
		lateCancelFeeMinor: 2500,
		currency: 'USD',
	},
) {
	return {
		reservation: {
			id: 'rsv_1',
			version: 7,
			status: 'no_show',
			paymentStatus: 'guaranteed',
			lateCancel: false,
			...reservation,
		},
		policy,
		payments,
	}
}

const FEE_RECORDED = {
	feeId: 'pay_fee',
	amountMinor: 5000,
	currency: 'USD',
	kind: 'no_show_fee',
	attempt: 1,
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function setup(options: {
	reads: Array<unknown | ReturnType<typeof apiError>>
	posts?: (call: ScriptedCall) => unknown
	app?: (url: string, init: RequestInit) => Response | Promise<Response>
	canAct?: boolean
	reservationId?: string
}) {
	let read = 0
	const scripted = createScriptedClient((call) => {
		if (call.method === 'GET') {
			const next = options.reads[Math.min(read, options.reads.length - 1)]
			read += 1
			return next
		}
		return options.posts?.(call)
	})
	const app = vi.fn(
		options.app ??
			(async () =>
				jsonResponse({
					feeId: 'pay_fee',
					attempt: 1,
					status: 'succeeded',
					declineCode: null,
				})),
	)
	const props = {
		reservationId: options.reservationId ?? 'rsv_1',
		client: scripted.client,
		orgSlug: 'acme',
		canAct: options.canAct ?? true,
		guestLabel: 'Ada',
		fetchImpl: app as unknown as typeof fetch,
	}
	const view = renderStaff(<PaymentPanel {...props} />)
	return { ...scripted, app, view, props }
}

afterEach(() => {
	vi.useRealTimers()
})

describe('PaymentPanel rows', () => {
	it('lists every row with amounts, statuses and card display facts only', async () => {
		setup({
			reads: [
				list(
					[
						row(),
						row({
							id: 'pay_fee',
							kind: 'no_show_fee_charge',
							purpose: 'fee',
							status: 'succeeded',
							amountMinor: 5000,
							updatedAt: NOW + 1000,
						}),
						row({
							id: 'pay_ref',
							kind: 'refund',
							purpose: null,
							status: 'succeeded',
							amountMinor: 1250,
							cardBrand: null,
							cardLast4: null,
							updatedAt: NOW + 2000,
						}),
					],
					{ paymentStatus: 'fee_charged' },
				),
			],
		})
		const rows = await screen.findAllByTestId('payment-row')
		expect(rows).toHaveLength(3)
		expect(rows[0]!.textContent).toContain('Card guarantee')
		expect(rows[0]!.textContent).toContain('visa •••• 4242')
		expect(rows[1]!.textContent).toContain('No-show fee')
		expect(rows[1]!.textContent).toContain('$50.00')
		expect(rows[2]!.textContent).toContain('Refund')
		expect(rows[2]!.textContent).toContain('−$12.50')
		expect(screen.getByTestId('payment-panel').textContent).not.toMatch(
			/\d{12,}/,
		)
		expect(
			screen
				.getByTestId('payment-panel')
				.querySelector('[data-testid="payment-badge"]')?.textContent,
		).toBe('Fee charged')
	})

	it('shows the rows but no action controls without the payment grant', async () => {
		setup({
			canAct: false,
			reads: [list([row()], { paymentStatus: 'guaranteed' })],
		})
		await screen.findAllByTestId('payment-row')
		expect(screen.queryByTestId('payment-charge-fee')).toBeNull()
		expect(screen.queryByTestId('payment-refund')).toBeNull()
	})

	it('says a dispute is reported only', async () => {
		setup({
			reads: [
				list(
					[
						row({
							kind: 'deposit_charge',
							amountMinor: 2500,
							disputeStatus: 'opened',
						}),
					],
					{ paymentStatus: 'disputed', status: 'booked' },
				),
			],
		})
		const note = await screen.findByTestId('payment-dispute-note')
		expect(note.textContent).toMatch(/reports it only/)
		expect(screen.getByTestId('payment-badge').textContent).toBe('Disputed')
	})
})

describe('PaymentPanel fee', () => {
	it('records the fee with the booking version, then has the App charge it', async () => {
		const { calls, app } = setup({
			reads: [list([row()]), list([row()], { paymentStatus: 'fee_charged' })],
			posts: () => FEE_RECORDED,
		})
		fireEvent.click(await screen.findByTestId('payment-charge-fee'))
		const text = await screen.findByTestId('payment-confirm-text')
		expect(text.textContent).toContain('$50.00')
		expect(text.textContent).toContain('Ada')
		fireEvent.click(screen.getByTestId('payment-confirm-btn'))
		await waitFor(() => expect(app).toHaveBeenCalledTimes(1))
		const post = calls.find((call) => call.method === 'POST')!
		expect(post.path).toBe(
			'/operator/reservations/payments/reservations/rsv_1/fee',
		)
		expect(post.body).toEqual({ kind: 'no_show_fee', expectedVersion: 7 })
		expect(app.mock.calls[0]![0]).toBe(
			'/resources/reservations/payments/fee?orgSlug=acme',
		)
		expect(JSON.parse(String(app.mock.calls[0]![1]!.body))).toEqual({
			reservationId: 'rsv_1',
			feeId: 'pay_fee',
		})
		await waitFor(() =>
			expect(screen.getByTestId('payment-badge').textContent).toBe(
				'Fee charged',
			),
		)
	})

	it('lets the host lower the amount and refuses a typo', async () => {
		const { calls } = setup({
			reads: [list([row()])],
			posts: () => FEE_RECORDED,
		})
		fireEvent.click(await screen.findByTestId('payment-charge-fee'))
		const input = await screen.findByTestId('payment-amount-input')
		fireEvent.change(input, { target: { value: '12.345' } })
		fireEvent.click(screen.getByTestId('payment-confirm-btn'))
		expect(
			(await screen.findByTestId('payment-form-error')).textContent,
		).toMatch(/amount like 12.50/)
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
		fireEvent.change(input, { target: { value: '12.50' } })
		fireEvent.click(screen.getByTestId('payment-confirm-btn'))
		await waitFor(() =>
			expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1),
		)
		expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({
			amountMinor: 1250,
		})
	})

	it('keeps a recorded fee when the charge call fails and retries only the charge', async () => {
		let appCalls = 0
		const pendingFee = row({
			id: 'pay_fee',
			kind: 'no_show_fee_charge',
			purpose: 'fee',
			status: 'pending',
			amountMinor: 5000,
		})
		const { calls, app } = setup({
			reads: [
				list([row()]),
				list([row(), pendingFee], { paymentStatus: 'fee_pending' }),
				list([row(), { ...pendingFee, status: 'succeeded' }], {
					paymentStatus: 'fee_charged',
				}),
			],
			posts: () => FEE_RECORDED,
			app: async () => {
				appCalls += 1
				if (appCalls === 1) throw new TypeError('Failed to fetch')
				return jsonResponse({
					feeId: 'pay_fee',
					attempt: 1,
					status: 'succeeded',
					declineCode: null,
				})
			},
		})
		fireEvent.click(await screen.findByTestId('payment-charge-fee'))
		fireEvent.click(await screen.findByTestId('payment-confirm-btn'))
		const retry = await screen.findByTestId('payment-retry-fee')
		expect(screen.getByTestId('payment-panel-notice').textContent).toMatch(
			/Retry charge/,
		)
		fireEvent.click(retry)
		await waitFor(() => expect(app).toHaveBeenCalledTimes(2))
		// The decision was recorded once; the retry never posts a second fee.
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
		expect(
			(JSON.parse(String(app.mock.calls[1]![1]!.body)) as { feeId: string })
				.feeId,
		).toBe('pay_fee')
	})

	it('explains a card that needs the bank and one that was declined', async () => {
		setup({
			reads: [list([row()])],
			posts: () => FEE_RECORDED,
			app: async () =>
				jsonResponse({
					feeId: 'pay_fee',
					attempt: 1,
					status: 'failed',
					declineCode: 'insufficient_funds',
				}),
		})
		fireEvent.click(await screen.findByTestId('payment-charge-fee'))
		fireEvent.click(await screen.findByTestId('payment-confirm-btn'))
		expect(
			(await screen.findByTestId('payment-panel-notice')).textContent,
		).toBe('The card has insufficient funds.')
	})

	it('explains why the region refused a fee and stays usable', async () => {
		setup({
			reads: [list([row()])],
			posts: () => {
				throw Object.assign(apiError(409, 'fee_not_allowed'), {
					body: { error: 'fee_not_allowed', reason: 'already_charged' },
				})
			},
		})
		fireEvent.click(await screen.findByTestId('payment-charge-fee'))
		fireEvent.click(await screen.findByTestId('payment-confirm-btn'))
		expect(
			(await screen.findByTestId('payment-form-error')).textContent,
		).toMatch(/already charged/)
		expect(screen.getByTestId('payment-confirm-btn')).toBeEnabled()
	})
})

describe('PaymentPanel refund', () => {
	const paid = row({
		id: 'pay_dep',
		kind: 'deposit_charge',
		purpose: 'deposit',
		amountMinor: 10000,
		cardBrand: 'visa',
	})

	it('needs a reason and an amount within what is left', async () => {
		const { calls } = setup({
			reads: [list([paid], { status: 'booked', paymentStatus: 'paid' })],
			posts: () => ({ refundId: 'pay_ref', amountMinor: 4000 }),
			app: async () => jsonResponse({ refunds: 1, pending: 0, failed: 0 }),
		})
		fireEvent.click(await screen.findByTestId('payment-refund'))
		fireEvent.click(await screen.findByTestId('payment-confirm-btn'))
		expect(
			(await screen.findByTestId('payment-form-error')).textContent,
		).toMatch(/reason/)
		fireEvent.change(screen.getByTestId('payment-reason-input'), {
			target: { value: 'Guest sick' },
		})
		fireEvent.change(screen.getByTestId('payment-amount-input'), {
			target: { value: '100.01' },
		})
		fireEvent.click(screen.getByTestId('payment-confirm-btn'))
		expect(
			(await screen.findByTestId('payment-form-error')).textContent,
		).toMatch(/up to what is left/)
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
	})

	it('records a partial refund and has the App run it', async () => {
		const { calls, app } = setup({
			reads: [list([paid], { status: 'booked', paymentStatus: 'paid' })],
			posts: () => ({ refundId: 'pay_ref', amountMinor: 4000 }),
			app: async () => jsonResponse({ refunds: 1, pending: 0, failed: 0 }),
		})
		fireEvent.click(await screen.findByTestId('payment-refund'))
		await screen.findByTestId('payment-confirm-text')
		fireEvent.change(screen.getByTestId('payment-reason-input'), {
			target: { value: '  Guest sick  ' },
		})
		fireEvent.change(screen.getByTestId('payment-amount-input'), {
			target: { value: '40' },
		})
		expect(screen.getByTestId('payment-confirm-text').textContent).toContain(
			'$40.00',
		)
		fireEvent.click(screen.getByTestId('payment-confirm-btn'))
		await waitFor(() => expect(app).toHaveBeenCalledTimes(1))
		expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
			amountMinor: 4000,
			reason: 'Guest sick',
		})
		expect(app.mock.calls[0]![0]).toBe(
			'/resources/reservations/payments/refund?orgSlug=acme',
		)
		expect(JSON.parse(String(app.mock.calls[0]![1]!.body))).toEqual({
			refundRequestId: 'pay_ref',
		})
	})

	it('runs a queued refund now', async () => {
		const queued = row({
			id: 'pay_q',
			kind: 'refund',
			status: 'requested',
			amountMinor: 10000,
			parentPaymentId: 'pay_dep',
			cardBrand: null,
			cardLast4: null,
		})
		const { app } = setup({
			reads: [
				list([paid, queued], {
					status: 'cancelled',
					paymentStatus: 'refund_pending',
				}),
			],
			app: async () => jsonResponse({ refunds: 1, pending: 1, failed: 0 }),
		})
		fireEvent.click(await screen.findByTestId('payment-process-refund'))
		await waitFor(() => expect(app).toHaveBeenCalledTimes(1))
		expect(JSON.parse(String(app.mock.calls[0]![1]!.body))).toEqual({
			refundRequestId: 'pay_q',
		})
		expect(
			(await screen.findByTestId('payment-panel-notice')).textContent,
		).toMatch(/still processing/)
	})
})

describe('PaymentPanel loading', () => {
	it('hides for good and stops polling after a 403', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		const pending = row({ kind: 'deposit_charge', status: 'pending' })
		const { request } = setup({
			reads: [
				list([pending], {
					status: 'pending_payment',
					paymentStatus: 'pending',
				}),
				apiError(403, 'forbidden'),
			],
		})
		await screen.findAllByTestId('payment-row')
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100)
		})
		await waitFor(() =>
			expect(screen.queryByTestId('payment-panel')).toBeNull(),
		)
		const afterDenied = request.mock.calls.length
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000)
		})
		expect(request.mock.calls).toHaveLength(afterDenied)
	})

	it('keeps polling while a payment is in flight and stops when it settles', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		const pending = row({ kind: 'deposit_charge', status: 'pending' })
		const { request } = setup({
			reads: [
				list([pending], {
					status: 'pending_payment',
					paymentStatus: 'pending',
				}),
				list([{ ...pending, status: 'succeeded' }], {
					status: 'booked',
					paymentStatus: 'paid',
				}),
			],
		})
		await screen.findAllByTestId('payment-row')
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_100)
		})
		await waitFor(() =>
			expect(screen.getByTestId('payment-badge').textContent).toBe(
				'Deposit paid',
			),
		)
		const settled = request.mock.calls.length
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000)
		})
		expect(request.mock.calls).toHaveLength(settled)
	})

	it('never lets a slow answer for another booking overwrite the current one', async () => {
		let resolveFirst: (value: unknown) => void = () => undefined
		const first = new Promise((resolve) => {
			resolveFirst = resolve
		})
		const scripted = createScriptedClient(async (call) => {
			if (call.path.endsWith('/rsv_old')) return first
			return list([row({ cardLast4: '1111' })], { id: 'rsv_new' })
		})
		function Harness() {
			const [id, setId] = useState('rsv_old')
			return (
				<>
					<button type="button" onClick={() => setId('rsv_new')}>
						switch
					</button>
					<PaymentPanel
						client={scripted.client}
						orgSlug="acme"
						canAct={false}
						guestLabel="Ada"
						reservationId={id}
					/>
				</>
			)
		}
		renderStaff(<Harness />)
		fireEvent.click(screen.getByRole('button', { name: 'switch' }))
		await screen.findAllByTestId('payment-row')
		expect(screen.getByTestId('payment-panel').textContent).toContain('1111')
		await act(async () => {
			resolveFirst(list([row({ cardLast4: '9999' })], { id: 'rsv_old' }))
			await first
		})
		expect(screen.getByTestId('payment-panel').textContent).toContain('1111')
		expect(screen.getByTestId('payment-panel').textContent).not.toContain(
			'9999',
		)
	})

	it('offers a retry when the first load fails', async () => {
		setup({
			reads: [apiError(500, 'server_error'), list([row()])],
		})
		const retry = await screen.findByRole('button', { name: 'Try again' })
		fireEvent.click(retry)
		await screen.findAllByTestId('payment-row')
	})
})
