// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { OrderDetail } from '#app/components/orders/order-detail.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { type Order } from '#app/utils/orders/order-model.ts'
import { renderStaff } from '#tests/staff-render.tsx'

function order(over: Partial<Order> = {}): Order {
	return {
		id: 'o1',
		customerKey: 'c_9',
		number: '20261019-9029',
		status: 'accepted',
		paymentStatus: 'paid',
		paymentMethod: 'online',
		paymentProcessor: 'stripe',
		subtotalCents: 3700,
		taxCents: 383,
		deliveryFeeCents: 0,
		tipCents: 500,
		tipPercent: 13,
		loyaltyDiscountCents: 0,
		totalCents: 4583,
		refundedCents: 0,
		currency: 'usd',
		createdAt: '2026-10-19T10:00:00.000Z',
		paidAt: '2026-10-19T10:01:00.000Z',
		contact: { name: 'Alex Turner', phone: '+15550100', email: 'a@x.test' },
		fulfillment: 'pickup',
		location: { id: 'l1', name: 'Main' },
		lines: [
			{
				itemName: 'Grilled Salmon',
				quantity: 1,
				unitPriceCents: 2600,
				totalCents: 2600,
				instructions: 'No lemon',
				options: [{ optionName: 'Rice', quantity: 1 }],
			},
		],
		pickup: { date: '2026-10-19', time: '18:30', timezone: 'UTC' },
		drop: null,
		delivery: null,
		timeZone: null,
		promisedAt: null,
		promisedUntil: null,
		promisedVersion: 0,
		promisedDelayMinutes: 0,
		attributionSource: 'direct',
		attribution: null,
		campaignName: null,
		...over,
	}
}

function show(
	o: Order,
	props: Partial<Parameters<typeof OrderDetail>[0]> = {},
) {
	const onUpdate = vi.fn()
	renderStaff(
		<OrderDetail
			order={o}
			orgSlug="acme"
			canWrite
			canViewCustomers
			busy={false}
			backHref="/acme/orders"
			onUpdate={onUpdate}
			{...props}
		/>,
	)
	return onUpdate
}

describe('OrderDetail', () => {
	it('links the customer name to the profile only with a customerKey', () => {
		show(order())
		expect(screen.getByTestId('order-customer-link')).toHaveAttribute(
			'href',
			'/acme/customers/c_9',
		)
		expect(screen.getByTestId('order-customer-orders')).toBeInTheDocument()
	})

	it('shows plain text and a no-profile note for a guest without a match', () => {
		show(order({ customerKey: null }))
		expect(screen.queryByTestId('order-customer-link')).toBeNull()
		expect(screen.getByTestId('order-customer-kind')).toHaveTextContent(
			'Guest checkout',
		)
		expect(screen.getByTestId('order-no-profile')).toHaveTextContent(
			'No customer profile',
		)
	})

	it('does not link or label customers without Customers access', () => {
		show(order(), { canViewCustomers: false })
		expect(screen.queryByTestId('order-customer-link')).toBeNull()
		expect(screen.queryByTestId('order-customer-kind')).toBeNull()
	})

	it('formats the totals breakdown with the order currency', () => {
		show(order())
		const totals = screen.getByTestId('order-totals')
		expect(totals).toHaveTextContent('Subtotal$37.00')
		expect(totals).toHaveTextContent('Tax$3.83')
		expect(totals).toHaveTextContent('Tip (13%)$5.00')
		expect(screen.getByTestId('order-total')).toHaveTextContent('$45.83')
	})

	it('lists a loyalty reward discount between subtotal and tax', () => {
		show(
			order({
				subtotalCents: 3700,
				loyaltyDiscountCents: 500,
				taxCents: 333,
				tipCents: 0,
				tipPercent: null,
				totalCents: 3533,
			}),
		)
		const totals = screen.getByTestId('order-totals')
		expect(totals).toHaveTextContent(
			'Subtotal$37.00Loyalty reward-$5.00Tax$3.33',
		)
		expect(screen.getByTestId('order-total')).toHaveTextContent('$35.33')
	})

	it('lists each applied discount with its code, the delivery discount and loyalty apart', () => {
		show(
			order({
				subtotalCents: 3700,
				discountCents: 400,
				deliveryDiscountCents: 300,
				loyaltyDiscountCents: 500,
				discounts: [
					{
						discountId: 'd1',
						version: 1,
						name: 'Lunch deal',
						code: 'LUNCH',
						amountMinor: 400,
						deliveryAmountMinor: 0,
						allocation: [],
					},
					{
						discountId: 'd2',
						name: 'Free delivery',
						code: null,
						amountMinor: 0,
						deliveryAmountMinor: 300,
					},
					'junk',
					{ nope: true },
				],
				taxCents: 300,
				tipCents: 0,
				tipPercent: null,
				totalCents: 2800,
			}),
		)
		const totals = screen.getByTestId('order-totals')
		expect(totals).toHaveTextContent('Lunch deal (LUNCH)-$4.00')
		expect(totals).toHaveTextContent('Delivery discount · Free delivery-$3.00')
		expect(totals).toHaveTextContent('Loyalty reward-$5.00')
		expect(screen.getAllByTestId('order-discount-row')).toHaveLength(1)
		expect(screen.getAllByTestId('order-delivery-discount-row')).toHaveLength(1)
	})

	it('falls back to totals when the discount list is missing', () => {
		show(order({ discountCents: 250, deliveryDiscountCents: 100 }))
		const totals = screen.getByTestId('order-totals')
		expect(totals).toHaveTextContent('Discount-$2.50')
		expect(totals).toHaveTextContent('Delivery discount-$1.00')
	})

	it('shows no discount rows when there are none', () => {
		show(order())
		expect(screen.queryByTestId('order-discount-row')).toBeNull()
		expect(screen.queryByTestId('order-free-badge')).toBeNull()
	})

	it('marks a free order and never asks for handoff payment', () => {
		const onUpdate = show(
			order({
				status: 'ready',
				paymentStatus: 'not_required',
				paymentMethod: 'handoff',
				paymentProcessor: null,
				paidAt: null,
				totalCents: 0,
			}),
		)
		expect(screen.getByTestId('order-free-badge')).toHaveTextContent(
			'Free order',
		)
		expect(screen.getByTestId('order-payment-status')).toHaveTextContent(
			'No payment needed',
		)
		expect(screen.getByTestId('order-payment-summary')).toHaveTextContent(
			'No payment needed',
		)
		expect(screen.queryByText('I have received payment at handoff')).toBeNull()
		const complete = screen.getByRole('button', { name: 'Complete order' })
		expect(complete).toBeEnabled()
		fireEvent.click(complete)
		expect(onUpdate).toHaveBeenCalledWith('completed', false)
	})

	it('explains a payment under review and offers the review actions', () => {
		const onUpdate = show(order({ status: 'payment_review' }))
		expect(screen.getByTestId('order-review-note')).toHaveTextContent(
			'Payment arrived after the hold',
		)
		fireEvent.click(
			screen.getByRole('button', { name: 'Accept and start preparing' }),
		)
		expect(onUpdate).toHaveBeenCalledWith('preparing', false)
		expect(screen.getByRole('button', { name: 'Cancel order' })).toBeEnabled()
	})

	it('shows two separate status labels', () => {
		show(order({ status: 'preparing', paymentStatus: 'pending' }))
		expect(screen.getByTestId('order-status')).toHaveTextContent('Preparing')
		expect(screen.getByTestId('order-payment-status')).toHaveTextContent(
			'Awaiting payment',
		)
	})

	it('hides the footer for a read-only member', () => {
		show(order(), { canWrite: false })
		expect(screen.queryByTestId('order-actions')).toBeNull()
	})

	it('hides actions for a completed order', () => {
		show(order({ status: 'completed' }))
		expect(screen.queryByTestId('order-actions')).toBeNull()
	})

	it('requires the handoff payment box before completing an unpaid order', () => {
		const onUpdate = show(
			order({
				status: 'ready',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
			}),
		)
		const complete = screen.getByRole('button', { name: 'Complete order' })
		expect(complete).toBeDisabled()
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(complete)
		expect(onUpdate).toHaveBeenCalledWith('completed', true)
	})

	async function chooseReason(label: string) {
		await userEvent.click(screen.getByTestId('order-cancel-reason'))
		await userEvent.click(await screen.findByRole('option', { name: label }))
	}

	it('needs a cancel reason and states the refund consequence', async () => {
		const onUpdate = show(order())
		fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }))
		expect(await screen.findByText(/\$45\.83 was received/)).toHaveTextContent(
			'Cancelling does not refund it',
		)
		const confirm = screen.getByRole('button', { name: 'Confirm cancellation' })
		expect(confirm).toBeDisabled()
		expect(screen.queryByTestId('order-cancel-refund')).toBeNull()
		await chooseReason('Out of stock')
		await userEvent.click(confirm)
		expect(onUpdate).toHaveBeenCalledWith('cancelled', false, {
			cancelReason: 'out_of_stock',
			refund: 'none',
		})
	})

	it('offers Full refund by default when cancelling a paid online order', async () => {
		const onUpdate = show(order(), { canRefund: true })
		fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }))
		expect(await screen.findByText('Refund the guest?')).toBeVisible()
		expect(screen.getByRole('radio', { name: 'Full refund' })).toBeChecked()
		await chooseReason('Kitchen closed')
		await userEvent.click(
			screen.getByRole('button', { name: 'Confirm cancellation' }),
		)
		expect(onUpdate).toHaveBeenCalledWith('cancelled', false, {
			cancelReason: 'kitchen_closed',
			refund: 'full',
		})
	})

	it('cancels without a refund when asked', async () => {
		const onUpdate = show(order(), { canRefund: true })
		fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }))
		await userEvent.click(
			await screen.findByRole('radio', { name: 'No refund' }),
		)
		await chooseReason('Duplicate order')
		await userEvent.click(
			screen.getByRole('button', { name: 'Confirm cancellation' }),
		)
		expect(onUpdate).toHaveBeenCalledWith('cancelled', false, {
			cancelReason: 'duplicate',
			refund: 'none',
		})
	})

	it('offers no refund choice on a disputed order', async () => {
		show(order({ disputed: true }), { canRefund: true })
		fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }))
		await screen.findByText(/\$45\.83 was received/)
		expect(screen.queryByTestId('order-cancel-refund')).toBeNull()
	})
})

describe('OrderDetail refunds', () => {
	// Money handed back at the counter is recorded; online orders go through
	// the payment provider (see the provider refunds below).
	const handoff = (over: Partial<Order> = {}) =>
		order({ paymentMethod: 'handoff', paymentProcessor: null, ...over })

	async function openRefund(note: string) {
		await userEvent.click(screen.getByTestId('order-refund-open'))
		await userEvent.type(await screen.findByTestId('order-refund-note'), note)
	}

	async function choosePartial(amount: string) {
		await userEvent.click(screen.getByRole('combobox', { name: 'Refund' }))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Part of the payment' }),
		)
		await userEvent.type(screen.getByTestId('order-refund-amount'), amount)
	}

	it('reads Partly refunded and logs each refund with its note', () => {
		show(
			handoff({
				refundedCents: 1200,
				refunds: [
					{
						id: 'rf1',
						amountCents: 1200,
						note: 'Cold salmon',
						createdAt: '2026-10-19T11:00:00.000Z',
					},
				],
			}),
		)
		expect(screen.getByTestId('order-payment-status')).toHaveTextContent(
			'Partly refunded',
		)
		expect(screen.getByTestId('order-refunded')).toHaveTextContent(
			'$12.00 of $45.83',
		)
		const activity = screen.getByTestId('order-timeline')
		expect(activity).toHaveTextContent('Refund recorded: $12.00')
		expect(activity).toHaveTextContent('Cold salmon')
	})

	it('reads Refunded once everything paid came back and offers no more', () => {
		show(handoff({ refundedCents: 4583 }), { onRecordRefund: vi.fn() })
		expect(screen.getByTestId('order-payment-status')).toHaveTextContent(
			/^Refunded$/,
		)
		expect(screen.queryByTestId('order-refund-open')).toBeNull()
	})

	it.each([
		['an order paid online', {}],
		['an unpaid order', { paymentStatus: 'pending' }],
		['a table round', { paymentMethod: 'handoff' as const, tabId: 'tab_1' }],
	])('offers no refund on %s', (_label, over) => {
		show(order(over), { onRecordRefund: vi.fn() })
		expect(screen.queryByTestId('order-refund-open')).toBeNull()
	})

	it('offers no refund to a member who cannot update orders', () => {
		show(handoff(), { canWrite: false, onRecordRefund: vi.fn() })
		expect(screen.queryByTestId('order-refund-open')).toBeNull()
	})

	it('records a full refund on a completed order with a note and a key', async () => {
		const onRecordRefund = vi.fn().mockResolvedValue(undefined)
		show(handoff({ status: 'completed' }), { onRecordRefund })
		expect(screen.queryByTestId('order-actions')).toBeNull()
		await openRefund('Refunded in Stripe')
		expect(screen.getByTestId('order-refund-left')).toHaveTextContent('$45.83')
		await userEvent.click(screen.getByTestId('order-refund-submit'))

		await waitFor(() =>
			expect(onRecordRefund).toHaveBeenCalledWith(
				{ full: true, note: 'Refunded in Stripe' },
				expect.stringMatching(/^order-refund-/),
			),
		)
		expect(await screen.findByTestId('order-refund-notice')).toHaveTextContent(
			'Refund recorded.',
		)
		await waitFor(() =>
			expect(screen.queryByTestId('order-refund-dialog')).toBeNull(),
		)
	})

	it('records part of the payment in cents', async () => {
		const onRecordRefund = vi.fn().mockResolvedValue(undefined)
		show(handoff({ refundedCents: 500 }), { onRecordRefund })
		await openRefund('Cold fries')
		await choosePartial('4.50')
		await userEvent.click(screen.getByTestId('order-refund-submit'))

		await waitFor(() =>
			expect(onRecordRefund).toHaveBeenCalledWith(
				{ amountCents: 450, note: 'Cold fries' },
				expect.any(String),
			),
		)
	})

	it('refuses more than is left without calling the region', async () => {
		const onRecordRefund = vi.fn()
		show(handoff({ refundedCents: 4000 }), { onRecordRefund })
		await openRefund('Too much')
		await choosePartial('6.00')
		await userEvent.click(screen.getByTestId('order-refund-submit'))

		expect(
			await screen.findByText('That is more than what is left to refund.'),
		).toBeInTheDocument()
		expect(onRecordRefund).not.toHaveBeenCalled()
	})

	it('refuses a decimal comma instead of recording a hundred times the amount', async () => {
		const onRecordRefund = vi.fn()
		show(handoff({ totalCents: 60_000 }), { onRecordRefund })
		await openRefund('Cold fries')
		await choosePartial('4,50')
		await userEvent.click(screen.getByTestId('order-refund-submit'))

		expect(
			await screen.findByText('Enter the amount returned, for example 4.50.'),
		).toBeInTheDocument()
		expect(onRecordRefund).not.toHaveBeenCalled()
	})

	it('reads an amount typed in Arabic-Indic digits', async () => {
		const onRecordRefund = vi.fn().mockResolvedValue(undefined)
		show(handoff(), { onRecordRefund })
		await openRefund('Cold fries')
		await choosePartial('٤٫٥٠')
		await userEvent.click(screen.getByTestId('order-refund-submit'))

		await waitFor(() =>
			expect(onRecordRefund).toHaveBeenCalledWith(
				{ amountCents: 450, note: 'Cold fries' },
				expect.any(String),
			),
		)
	})

	it('retries with the same key after a lost response and names what is left', async () => {
		const onRecordRefund = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockRejectedValueOnce(
				new OperatorRequestError(
					'That is more than is left to refund.',
					'refund_exceeds_payment',
					422,
					{ error: 'refund_exceeds_payment', refundableCents: 300 },
				),
			)
		show(handoff(), { onRecordRefund })
		await openRefund('Refunded twice?')
		await userEvent.click(screen.getByTestId('order-refund-submit'))
		expect(await screen.findByTestId('order-refund-error')).toHaveTextContent(
			'Check your connection',
		)

		await userEvent.click(screen.getByTestId('order-refund-submit'))
		await waitFor(() =>
			expect(screen.getByTestId('order-refund-error')).toHaveTextContent(
				'At most $3.00 can still be refunded.',
			),
		)
		const [first, second] = onRecordRefund.mock.calls
		expect(second?.[1]).toBe(first?.[1])
	})

	describe('push back', () => {
		const promised = {
			promisedAt: '2026-10-19T18:40:00.000Z',
			promisedVersion: 3,
		}

		it('shows the promised time in the order time zone', () => {
			show(order(promised), { onPushBack: vi.fn() })
			expect(screen.getByTestId('order-promised')).toHaveTextContent(
				/Ready around 6:40\sPM/,
			)
		})

		it('uses the location zone for an ASAP order with no pickup window', () => {
			show(order({ ...promised, pickup: null, timeZone: 'Asia/Riyadh' }), {
				onPushBack: vi.fn(),
			})
			expect(screen.getByTestId('order-promised')).toHaveTextContent(
				/Ready around 9:40\sPM/,
			)
		})

		it('shows a delivery range', () => {
			show(
				order({
					...promised,
					fulfillment: 'delivery',
					promisedUntil: '2026-10-19T18:55:00.000Z',
				}),
				{ onPushBack: vi.fn() },
			)
			expect(screen.getByTestId('order-promised')).toHaveTextContent(
				/Arriving 6:40\sPM to 6:55\sPM/,
			)
		})

		it('is hidden without a promised time, when closed, or without write access', () => {
			const onPushBack = vi.fn()
			show(order(), { onPushBack })
			expect(screen.queryByTestId('order-push-back')).toBeNull()
			expect(screen.queryByTestId('order-promised')).toBeNull()
		})

		it.each(['completed', 'cancelled'])('is hidden when %s', (status) => {
			show(order({ ...promised, status }), { onPushBack: vi.fn() })
			expect(screen.queryByTestId('order-push-back')).toBeNull()
		})

		it('is hidden without write permission', () => {
			show(order(promised), { onPushBack: vi.fn(), canWrite: false })
			expect(screen.queryByTestId('order-push-back')).toBeNull()
		})

		it('sends the minutes for the order as it is shown', async () => {
			const onPushBack = vi.fn().mockResolvedValue(undefined)
			show(order(promised), { onPushBack })
			await userEvent.click(screen.getByRole('button', { name: '+10 min' }))
			expect(onPushBack).toHaveBeenCalledWith(10)
		})

		it('disables a step that would pass the 90 minute cap', () => {
			show(order({ ...promised, promisedDelayMinutes: 80 }), {
				onPushBack: vi.fn(),
			})
			expect(screen.getByRole('button', { name: '+5 min' })).toBeEnabled()
			expect(screen.getByRole('button', { name: '+10 min' })).toBeEnabled()
			expect(screen.getByRole('button', { name: '+15 min' })).toBeDisabled()
		})

		it('says so when nothing more can be added', () => {
			show(order({ ...promised, promisedDelayMinutes: 90 }), {
				onPushBack: vi.fn(),
			})
			expect(screen.getByTestId('order-push-back')).toHaveTextContent(
				"This order can't be pushed back any further.",
			)
			expect(screen.getByRole('button', { name: '+5 min' })).toBeDisabled()
		})

		it('reloads and explains a stale version', async () => {
			const onReload = vi.fn()
			const onPushBack = vi
				.fn()
				.mockRejectedValue(
					new OperatorRequestError('Conflict', 'stale_version', 409),
				)
			show(order(promised), { onPushBack, onReload })
			await userEvent.click(screen.getByRole('button', { name: '+5 min' }))
			expect(
				await screen.findByTestId('order-push-back-error'),
			).toHaveTextContent(
				'This order changed on another screen. Check the new time and try again.',
			)
			expect(onReload).toHaveBeenCalled()
		})

		it('explains a closed order and a generic failure', async () => {
			const onPushBack = vi
				.fn()
				.mockRejectedValueOnce(
					new OperatorRequestError('Conflict', 'order_closed', 409),
				)
				.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			show(order(promised), { onPushBack })
			await userEvent.click(screen.getByRole('button', { name: '+5 min' }))
			expect(
				await screen.findByTestId('order-push-back-error'),
			).toHaveTextContent("This order is finished, so its time can't change.")
			await userEvent.click(screen.getByRole('button', { name: '+5 min' }))
			await waitFor(() =>
				expect(screen.getByTestId('order-push-back-error')).toHaveTextContent(
					'Unable to update this order',
				),
			)
		})
	})
})

describe('OrderDetail provider refunds', () => {
	const provider = (over: Partial<Order> = {}) => order(over)

	it('offers Refund on a paid online order with the permission', () => {
		show(provider(), { canRefund: true })
		expect(screen.getByTestId('order-provider-refund-open')).toHaveTextContent(
			'Refund',
		)
		expect(screen.queryByTestId('order-refund-open')).toBeNull()
	})

	it('offers nothing without the permission', () => {
		show(provider(), { canRefund: false })
		expect(screen.queryByTestId('order-provider-refund-open')).toBeNull()
	})

	it('hides refund actions and explains a dispute', () => {
		show(provider({ disputed: true, disputeStatus: 'open' }), {
			canRefund: true,
		})
		expect(screen.getByTestId('order-disputed-badge')).toHaveTextContent(
			'Disputed',
		)
		expect(screen.getByTestId('order-disputed-note')).toHaveTextContent(
			'disputed this payment with their card issuer',
		)
		expect(screen.queryByTestId('order-provider-refund-open')).toBeNull()
	})

	it('shows a pending refund and no new refund button', () => {
		show(
			provider({
				refundStatus: 'pending',
				refundPendingCents: 1000,
				refundableCents: 3583,
			}),
			{ canRefund: true },
		)
		expect(screen.getByTestId('order-refund-pending')).toHaveTextContent(
			'Refund pending ($10.00)',
		)
		expect(screen.queryByTestId('order-provider-refund-open')).toBeNull()
	})

	it('shows a failed refund in plain words with Try again', () => {
		show(
			provider({
				status: 'cancelled',
				refundStatus: 'failed',
				refundFailureCode: 'expired_or_canceled_card',
				refundableCents: 4583,
				cancelledBy: 'operator',
				cancelReason: 'out_of_stock',
				refunds: [
					{
						id: 'rf1',
						amountCents: 4583,
						note: null,
						createdAt: '2026-10-19T11:00:00.000Z',
						kind: 'provider',
						status: 'failed',
						failureCode: 'expired_or_canceled_card',
					},
				],
			}),
			{ canRefund: true },
		)
		expect(screen.getByTestId('order-refund-failed')).toHaveTextContent(
			"Refund failed. The guest's card is closed or expired.",
		)
		expect(screen.getByTestId('order-provider-refund-open')).toHaveTextContent(
			'Try again',
		)
		expect(screen.getByTestId('order-cancel-info')).toHaveTextContent(
			'Staff · Out of stock',
		)
		expect(screen.getByTestId('order-timeline')).toHaveTextContent(
			'Refund failed: $45.83',
		)
	})

	it('opens the provider dialog, never the record dialog, for an online order', async () => {
		show(provider(), { canRefund: true, onRecordRefund: vi.fn() })
		await userEvent.click(screen.getByTestId('order-provider-refund-open'))
		expect(await screen.findByTestId('provider-refund-dialog')).toBeVisible()
		expect(screen.queryByTestId('order-refund-dialog')).toBeNull()
	})

	describe('waiting for acceptance', () => {
		// Computed per call: a deadline taken when the file loads drifts by
		// the time the suite reaches this test.
		const waitingOrder = (over: Partial<Order> = {}) =>
			order({
				status: 'pending_acceptance',
				acceptanceDeadlineAt: new Date(Date.now() + 192_500).toISOString(),
				...over,
			})

		it('shows the countdown and Accept / Reject instead of the status buttons', () => {
			show(waitingOrder(), { onAccept: vi.fn(), onReject: vi.fn() })
			expect(screen.getByTestId('order-acceptance-banner')).toBeInTheDocument()
			expect(screen.getByTestId('acceptance-countdown')).toHaveTextContent(
				/Accept within 3:1\d/,
			)
			expect(screen.getByTestId('order-accept')).toBeInTheDocument()
			expect(screen.queryByTestId('order-actions')).toBeNull()
			expect(screen.queryByText('Cancel order')).toBeNull()
			expect(screen.queryByText('Start preparing')).toBeNull()
		})

		it('says time is up past the deadline but keeps Accept', () => {
			show(
				waitingOrder({
					acceptanceDeadlineAt: new Date(Date.now() - 5000).toISOString(),
				}),
				{ onAccept: vi.fn(), onReject: vi.fn() },
			)
			expect(screen.getByTestId('acceptance-countdown')).toHaveTextContent(
				'Time is up',
			)
			expect(screen.getByTestId('order-accept')).toBeEnabled()
		})

		it('accepts with one tap', async () => {
			const onAccept = vi.fn()
			show(waitingOrder(), { onAccept, onReject: vi.fn() })
			await userEvent.click(screen.getByTestId('order-accept'))
			expect(onAccept).toHaveBeenCalledTimes(1)
		})

		it('moves focus to the order heading when Accept removes the banner', async () => {
			function Harness() {
				const [current, setCurrent] = useState(waitingOrder())
				return (
					<OrderDetail
						order={current}
						orgSlug="acme"
						canWrite
						canViewCustomers
						busy={false}
						notice={current.status === 'accepted' ? 'Order accepted.' : null}
						backHref="/acme/orders"
						onUpdate={vi.fn()}
						onAccept={() => setCurrent({ ...current, status: 'accepted' })}
						onReject={vi.fn()}
					/>
				)
			}
			renderStaff(<Harness />)
			const accept = screen.getByTestId('order-accept')
			accept.focus()
			await userEvent.click(accept)
			await waitFor(() =>
				expect(screen.queryByTestId('order-acceptance-banner')).toBeNull(),
			)
			expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
			// The notice sits in the live region that was already on the page.
			expect(screen.getByTestId('order-refund-notice')).toHaveAttribute(
				'aria-live',
				'polite',
			)
			expect(screen.getByTestId('order-refund-notice')).toHaveTextContent(
				'Order accepted.',
			)
		})

		it('leaves focus alone when it is already elsewhere as the banner goes', async () => {
			function Harness() {
				const [current, setCurrent] = useState(waitingOrder())
				return (
					<>
						<button
							type="button"
							data-testid="elsewhere"
							onClick={() => setCurrent({ ...current, status: 'accepted' })}
						>
							Someone else accepted
						</button>
						<OrderDetail
							order={current}
							orgSlug="acme"
							canWrite
							canViewCustomers
							busy={false}
							backHref="/acme/orders"
							onUpdate={vi.fn()}
						/>
					</>
				)
			}
			renderStaff(<Harness />)
			await userEvent.click(screen.getByTestId('elsewhere'))
			await waitFor(() =>
				expect(screen.queryByTestId('order-acceptance-banner')).toBeNull(),
			)
			expect(screen.getByTestId('elsewhere')).toHaveFocus()
		})

		it('rejects only with a reason and tells about the refund', async () => {
			const onReject = vi.fn()
			show(waitingOrder(), { onAccept: vi.fn(), onReject })
			await userEvent.click(screen.getByTestId('order-reject'))
			expect(
				await screen.findByTestId('order-reject-refund-note'),
			).toHaveTextContent('The guest is refunded in full.')
			expect(
				screen.getByRole('button', { name: 'Reject order' }),
			).toBeDisabled()
			await userEvent.click(screen.getByTestId('order-reject-reason'))
			await userEvent.click(
				await screen.findByRole('option', { name: 'Kitchen closed' }),
			)
			await userEvent.click(
				screen.getByRole('button', { name: 'Reject order' }),
			)
			expect(onReject).toHaveBeenCalledWith('kitchen_closed')
		})

		it('does not promise a refund for an unpaid order', async () => {
			show(
				waitingOrder({ paymentStatus: 'unpaid', paymentMethod: 'handoff' }),
				{
					onAccept: vi.fn(),
					onReject: vi.fn(),
				},
			)
			await userEvent.click(screen.getByTestId('order-reject'))
			await screen.findByTestId('order-reject-reason')
			expect(screen.queryByTestId('order-reject-refund-note')).toBeNull()
		})

		it('hides the buttons without write access', () => {
			show(waitingOrder(), { canWrite: false })
			expect(screen.getByTestId('order-acceptance-banner')).toBeInTheDocument()
			expect(screen.queryByTestId('order-accept')).toBeNull()
		})

		it('reads Rejected with the reason, and Not accepted in time', () => {
			const { unmount } = renderStaff(
				<OrderDetail
					order={order({
						status: 'cancelled',
						cancelReason: 'out_of_stock',
						rejectedReason: 'out_of_stock',
						cancelledBy: 'operator',
					})}
					orgSlug="acme"
					canWrite
					canViewCustomers
					busy={false}
					backHref="/acme/orders"
					onUpdate={vi.fn()}
				/>,
			)
			expect(screen.getByTestId('order-cancel-info')).toHaveTextContent(
				'Rejected: Out of stock',
			)
			unmount()
			show(
				order({
					status: 'cancelled',
					cancelReason: 'not_accepted_in_time',
					rejectedReason: 'not_accepted_in_time',
					cancelledBy: 'system',
				}),
			)
			expect(screen.getByTestId('order-cancel-info')).toHaveTextContent(
				'Not accepted in time',
			)
		})
	})
})

describe('OrderDetail checkout rules (#251, #257, #355, #408)', () => {
	it('shows the packaging fee as its own row, under the name the guest saw', () => {
		show(
			order({
				packagingFeeCents: 100,
				packagingFeeLabel: 'Bag fee',
				totalCents: 4683,
			}),
		)
		const row = screen.getByTestId('order-packaging-fee-row')
		expect(row).toHaveTextContent('Bag fee')
		expect(row).toHaveTextContent('1.00')
	})

	it('reads the default packaging name in the operator language', () => {
		show(
			order({
				packagingFeeCents: 100,
				packagingFeeLabel: 'Packaging fee',
				totalCents: 4683,
			}),
		)
		expect(screen.getByTestId('order-packaging-fee-row')).toHaveTextContent(
			'Packaging fee',
		)
	})

	it('shows no packaging row when none was charged', () => {
		show(order())
		expect(screen.queryByTestId('order-packaging-fee-row')).toBeNull()
		show(order({ packagingFeeCents: 0 }))
		expect(screen.queryByTestId('order-packaging-fee-row')).toBeNull()
	})

	it('says what the guest chose about utensils, and nothing when it was not asked', () => {
		const { unmount } = renderStaff(
			<OrderDetail
				order={order({ utensilsRequested: true })}
				orgSlug="acme"
				canWrite
				canViewCustomers
				busy={false}
				backHref="/acme/orders"
				onUpdate={vi.fn()}
			/>,
		)
		expect(screen.getByTestId('order-utensils')).toHaveTextContent(
			'Utensils: yes',
		)
		unmount()
		show(order({ utensilsRequested: false }))
		expect(screen.getByTestId('order-utensils')).toHaveTextContent(
			'No utensils',
		)
	})

	it('shows no utensils line when the question was not asked', () => {
		show(order({ utensilsRequested: null }))
		expect(screen.queryByTestId('order-utensils')).toBeNull()
	})

	it('keeps the pickup text the guest saw, with its line breaks, as plain text', () => {
		show(
			order({
				pickupInstructions: 'Park in the side lot.\nAsk for <b>Sam</b>.',
			}),
		)
		const text = screen.getByTestId('order-pickup-instructions')
		expect(text).toHaveTextContent('Park in the side lot.')
		expect(text.textContent).toContain('<b>Sam</b>')
		expect(text.querySelector('b')).toBeNull()
		expect(text).toHaveAttribute('dir', 'auto')
	})

	it('labels a large order with its extra minutes', () => {
		show(order({ largeOrderExtraMinutes: 15 }))
		expect(screen.getByTestId('order-large-order')).toHaveTextContent(
			'Large order +15 min',
		)
	})

	it('badges custom open-price items on order lines (#171)', () => {
		show(
			order({
				lines: [
					{
						kind: 'custom',
						itemName: 'Corkage fee',
						quantity: 1,
						unitPriceCents: 1500,
						totalCents: 1500,
						instructions: null,
						options: [],
					},
				],
			}),
		)
		expect(screen.getByTestId('order-line')).toHaveTextContent('Custom item')
	})

	it('shows where the order came from (#115)', () => {
		show(order())
		expect(screen.getByTestId('order-came-from')).toHaveTextContent(
			'Came from: Direct',
		)
	})

	it('names the campaign of an order that came from a campaign email', () => {
		show(
			order({
				attributionSource: 'email',
				campaignName: 'Spring brunch',
				attribution: { utmSource: 'menuza' },
			}),
		)
		expect(screen.getByTestId('order-came-from')).toHaveTextContent(
			'Came from: Email campaign · Spring brunch',
		)
	})

	it('shows another site as the UTM source it was stored with', () => {
		show(
			order({
				attributionSource: 'newsletter',
				attribution: { utmSource: 'newsletter' },
			}),
		)
		expect(screen.getByTestId('order-came-from')).toHaveTextContent(
			'Came from: newsletter',
		)
	})
})
