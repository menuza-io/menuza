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
})
