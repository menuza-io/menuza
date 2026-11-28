// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { OrderProblemsPanel, ProblemsInbox } from './order-problems.tsx'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

function problem(overrides: Record<string, unknown> = {}) {
	return {
		id: 'p1',
		orderId: 'o1',
		orderNumber: 'W-0042',
		locationId: 'loc1',
		locationName: 'Olaya',
		contactName: 'Layla',
		kind: 'missing_item',
		status: 'open',
		resolution: null,
		items: [
			{
				lineIndex: 0,
				itemId: 'i1',
				name: 'Burger',
				quantity: 1,
				amountCents: 1000,
			},
		],
		note: 'It never came <b>really</b>',
		photoUrl: 'https://bucket.test/p.jpg?signed=1',
		hasPhoto: true,
		createdAt: Date.now() - 60_000,
		updatedAt: Date.now() - 60_000,
		resolvedAt: null,
		unanswered: false,
		currency: 'USD',
		orderTotalCents: 2000,
		paymentMethod: 'handoff',
		paymentStatus: 'paid',
		affectedCents: 1000,
		refundableCents: 2000,
		refundCents: null,
		creditCents: null,
		creditExpiresAt: null,
		entries: [
			{
				id: 'e1',
				kind: 'report',
				author: 'guest',
				body: 'It never came <b>really</b>',
				at: Date.now() - 60_000,
			},
		],
		...overrides,
	}
}

function list(problems: unknown[]) {
	return {
		problems,
		counts: {
			open: problems.length,
			unanswered: 0,
		},
	}
}

describe('ProblemsInbox (#191)', () => {
	it('shows each report with its items, the guest’s words as text and the photo', async () => {
		const request = vi.fn(async () => list([problem()]))
		renderStaff(
			<ProblemsInbox orgSlug="acme" canWrite canRefund request={request} />,
		)
		const card = await screen.findByTestId('problem-card')
		expect(within(card).getByText('Missing item')).toBeInTheDocument()
		expect(within(card).getByTestId('problem-items')).toHaveTextContent(
			'1 × Burger',
		)
		// Guest words are text: markup in them is not rendered.
		expect(within(card).getByTestId('problem-note')).toHaveTextContent(
			'It never came <b>really</b>',
		)
		expect(card.querySelector('b')).toBeNull()
		expect(within(card).getByTestId('problem-photo').getAttribute('href')).toBe(
			'https://bucket.test/p.jpg?signed=1',
		)
		expect(within(card).getByRole('link', { name: /W-0042/ })).toHaveAttribute(
			'href',
			'/acme/orders/o1',
		)
	})

	it('refunds the affected items with one amount and sends it to the region', async () => {
		const user = userEvent.setup()
		const request = vi.fn(async (path: string, init?: { method?: string }) =>
			init?.method === 'POST'
				? { problem: problem({ status: 'answered', resolution: 'refund' }) }
				: list([problem()]),
		)
		renderStaff(
			<ProblemsInbox orgSlug="acme" canWrite canRefund request={request} />,
		)
		await user.click(await screen.findByTestId('problem-refund'))
		expect(screen.getByTestId('problem-amount')).toHaveValue('10.00')
		await user.type(screen.getByTestId('problem-message'), 'So sorry')
		await user.click(screen.getByTestId('problem-send'))
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith(
				'/problems/p1/answer',
				expect.objectContaining({ method: 'POST' }),
			),
		)
		const call = request.mock.calls.find(
			([, init]) =>
				(init as { method?: string } | undefined)?.method === 'POST',
		)!
		expect(JSON.parse(String((call[1] as { body: string }).body))).toEqual({
			action: 'refund',
			amountCents: 1000,
			message: 'So sorry',
		})
	})

	it('gives a credit with a number of days, replies, and closes', async () => {
		const user = userEvent.setup()
		const request = vi.fn(async (path: string, init?: { method?: string }) =>
			init?.method === 'POST' ? { problem: problem() } : list([problem()]),
		)
		renderStaff(
			<ProblemsInbox orgSlug="acme" canWrite canRefund request={request} />,
		)
		await user.click(await screen.findByTestId('problem-credit'))
		await user.clear(screen.getByTestId('problem-amount'))
		await user.type(screen.getByTestId('problem-amount'), '4.50')
		await user.clear(screen.getByTestId('problem-days'))
		await user.type(screen.getByTestId('problem-days'), '30')
		await user.click(screen.getByTestId('problem-send'))
		await waitFor(() => expect(request).toHaveBeenCalledTimes(3))
		const posts = request.mock.calls
			.filter(
				([, init]) =>
					(init as { method?: string } | undefined)?.method === 'POST',
			)
			.map(([, init]) => JSON.parse(String((init as { body: string }).body)))
		expect(posts[0]).toEqual({
			action: 'credit',
			amountCents: 450,
			validDays: 30,
		})
		await user.click(screen.getByTestId('problem-reply'))
		await user.click(screen.getByTestId('problem-send'))
		expect(
			await screen.findByText('Write the reply first.'),
		).toBeInTheDocument()
		await user.click(screen.getByTestId('problem-close'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(
					([, init]) =>
						(init as { body?: string } | undefined)?.body ===
						JSON.stringify({ action: 'close' }),
				),
			).toBe(true),
		)
	})

	it('keeps Refund off for an online payment without the refund right, and for an unpaid order', async () => {
		const request = vi.fn(async () =>
			list([
				problem({ id: 'online', paymentMethod: 'online' }),
				problem({ id: 'unpaid', paymentStatus: 'unpaid', orderNumber: 'W-2' }),
			]),
		)
		renderStaff(
			<ProblemsInbox
				orgSlug="acme"
				canWrite
				canRefund={false}
				request={request}
			/>,
		)
		const cards = await screen.findAllByTestId('problem-card')
		for (const card of cards) {
			expect(within(card).getByTestId('problem-refund')).toBeDisabled()
			expect(within(card).getByTestId('problem-credit')).toBeEnabled()
		}
	})

	it('shows a person who may only read no answer buttons, and says when a report is old', async () => {
		const request = vi.fn(async () => list([problem({ unanswered: true })]))
		renderStaff(
			<ProblemsInbox
				orgSlug="acme"
				canWrite={false}
				canRefund={false}
				request={request}
			/>,
		)
		const card = await screen.findByTestId('problem-card')
		expect(within(card).getByText('Waiting over a day')).toBeInTheDocument()
		expect(within(card).queryByTestId('problem-refund')).toBeNull()
		expect(within(card).queryByTestId('problem-close')).toBeNull()
	})

	it('says why an answer was refused', async () => {
		const user = userEvent.setup()
		const request = vi.fn(async (path: string, init?: { method?: string }) => {
			if (init?.method === 'POST') {
				throw new OperatorRequestError('x', 'refund_exceeds_payment', 422)
			}
			return list([problem()])
		})
		renderStaff(
			<ProblemsInbox orgSlug="acme" canWrite canRefund request={request} />,
		)
		await user.click(await screen.findByTestId('problem-refund'))
		await user.click(screen.getByTestId('problem-send'))
		expect(
			await screen.findByText(
				'That is more than is left to refund on this order.',
			),
		).toBeInTheDocument()
	})

	it('says nothing is waiting when there is nothing', async () => {
		renderStaff(
			<ProblemsInbox
				orgSlug="acme"
				canWrite
				canRefund
				request={vi.fn(async () => list([]))}
			/>,
		)
		expect(
			await screen.findByText('Nothing is waiting for an answer'),
		).toBeInTheDocument()
	})
})

describe('OrderProblemsPanel', () => {
	it('shows the reports of one order and nothing when there are none', async () => {
		const request = vi.fn(async () => list([problem()]))
		const { unmount } = renderStaff(
			<OrderProblemsPanel
				orgSlug="acme"
				orderId="o1"
				canWrite
				canRefund
				request={request}
			/>,
		)
		expect(
			await screen.findByTestId('order-problems-panel'),
		).toBeInTheDocument()
		expect(request).toHaveBeenCalledWith(
			'/problems?status=all&orderId=o1',
			expect.anything(),
		)
		unmount()
		renderStaff(
			<OrderProblemsPanel
				orgSlug="acme"
				orderId="o2"
				canWrite
				canRefund
				request={vi.fn(async () => list([]))}
			/>,
		)
		await waitFor(() =>
			expect(screen.queryByTestId('order-problems-panel')).toBeNull(),
		)
	})
})
