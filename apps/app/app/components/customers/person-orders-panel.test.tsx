// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PersonOrdersPanel } from '#app/components/customers/person-orders-panel.tsx'
import {
	type PeopleClient,
	type PersonOrder,
} from '#app/utils/people/people-api.ts'
import { renderStaff } from '#tests/staff-render.tsx'

function order(id: string, over: Partial<PersonOrder> = {}): PersonOrder {
	return {
		id,
		number: `A-${id}`,
		status: 'completed',
		paymentStatus: 'paid',
		fulfillment: 'pickup',
		currency: 'usd',
		totalCents: 1250,
		refundedCents: 0,
		itemCount: 3,
		createdAt: '2026-03-04T10:00:00.000Z',
		matchedBy: 'customer',
		...over,
	}
}

function render(request: ReturnType<typeof vi.fn>) {
	return renderStaff(
		<PersonOrdersPanel
			client={{ request } as unknown as PeopleClient}
			orgSlug="acme"
			personKey="c_1"
		/>,
	)
}

describe('PersonOrdersPanel', () => {
	it('lists orders with totals, links to the Orders page and pages with Load more', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				orders: [order('1'), order('2', { fulfillment: 'delivery' })],
				nextCursor: 'next',
				totals: { count: 3, spend: [{ currency: 'usd', cents: 3750 }] },
			})
			.mockResolvedValueOnce({
				orders: [order('2'), order('3')],
				nextCursor: null,
				totals: { count: 3, spend: [{ currency: 'usd', cents: 3750 }] },
			})
		render(request)
		expect(await screen.findByTestId('person-order-1')).toBeInTheDocument()
		expect(screen.getByTestId('person-orders-totals')).toHaveTextContent(
			'3 orders',
		)
		expect(screen.getByTestId('person-orders-totals')).toHaveTextContent(
			'$37.50',
		)
		expect(screen.getByRole('link', { name: 'A-1' })).toHaveAttribute(
			'href',
			'/acme/orders/1',
		)
		fireEvent.click(screen.getByTestId('person-orders-more'))
		expect(await screen.findByTestId('person-order-3')).toBeInTheDocument()
		// The overlapping order is not repeated and the button goes away.
		expect(screen.getAllByTestId('person-order-2')).toHaveLength(1)
		expect(screen.queryByTestId('person-orders-more')).toBeNull()
		expect(request).toHaveBeenLastCalledWith(
			'/c_1/orders',
			expect.objectContaining({
				query: expect.objectContaining({ cursor: 'next' }),
			}),
		)
	})

	it('marks orders whose money came back', async () => {
		render(
			vi.fn().mockResolvedValue({
				orders: [
					order('1', { refundedCents: 1250 }),
					order('2', { refundedCents: 250 }),
					order('3'),
				],
				nextCursor: null,
				totals: { count: 3, spend: [{ currency: 'usd', cents: 3750 }] },
			}),
		)
		expect(await screen.findByTestId('person-order-1')).toHaveTextContent(
			/Refunded/,
		)
		expect(screen.getByTestId('person-order-2')).toHaveTextContent(
			'Partly refunded',
		)
		expect(screen.getByTestId('person-order-3')).toHaveTextContent('Paid')
	})

	it('shows an empty state', async () => {
		render(
			vi.fn().mockResolvedValue({
				orders: [],
				nextCursor: null,
				totals: { count: 0, spend: [] },
			}),
		)
		expect(await screen.findByTestId('person-orders-empty')).toBeInTheDocument()
	})
})
