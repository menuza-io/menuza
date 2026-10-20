// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OrderDetail } from '#app/components/orders/order-detail.tsx'
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
		totalCents: 4583,
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
		expect(await screen.findByText(/\$45\.83 was received/)).toBeInTheDocument()
		fireEvent.click(
			screen.getByRole('button', { name: 'Confirm cancellation' }),
		)
		expect(onUpdate).toHaveBeenCalledWith('cancelled', false)
	})
})
