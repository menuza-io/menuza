// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
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

	it('confirms a cancellation and states the refund consequence', async () => {
		const onUpdate = show(order())
		fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }))
		expect(await screen.findByText(/\$45\.83 was received/)).toHaveTextContent(
			'record the refund on this order',
		)
		fireEvent.click(
			screen.getByRole('button', { name: 'Confirm cancellation' }),
		)
		expect(onUpdate).toHaveBeenCalledWith('cancelled', false)
	})
})

describe('OrderDetail refunds', () => {
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
			order({
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
		show(order({ refundedCents: 4583 }), { onRecordRefund: vi.fn() })
		expect(screen.getByTestId('order-payment-status')).toHaveTextContent(
			/^Refunded$/,
		)
		expect(screen.queryByTestId('order-refund-open')).toBeNull()
	})

	it.each([
		['an order paid at handoff', { paymentMethod: 'handoff' as const }],
		['an unpaid order', { paymentStatus: 'pending' }],
		['a table round', { paymentMethod: 'handoff' as const, tabId: 'tab_1' }],
	])('offers no refund on %s', (_label, over) => {
		show(order(over), { onRecordRefund: vi.fn() })
		expect(screen.queryByTestId('order-refund-open')).toBeNull()
	})

	it('offers no refund to a member who cannot update orders', () => {
		show(order(), { canWrite: false, onRecordRefund: vi.fn() })
		expect(screen.queryByTestId('order-refund-open')).toBeNull()
	})

	it('records a full refund on a completed order with a note and a key', async () => {
		const onRecordRefund = vi.fn().mockResolvedValue(undefined)
		show(order({ status: 'completed' }), { onRecordRefund })
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
		show(order({ refundedCents: 500 }), { onRecordRefund })
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
		show(order({ refundedCents: 4000 }), { onRecordRefund })
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
		show(order({ totalCents: 60_000 }), { onRecordRefund })
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
		show(order(), { onRecordRefund })
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
		show(order(), { onRecordRefund })
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
