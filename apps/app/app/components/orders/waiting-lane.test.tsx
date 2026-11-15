// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WaitingLane } from '#app/components/orders/waiting-lane.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { type Order, orderSchema } from '#app/utils/orders/order-model.ts'
import { recordServerClock, resetServerClock } from '#app/utils/server-clock.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const chime = vi.hoisted(() => ({
	playChime: vi.fn(),
	unlockChime: vi.fn(),
	chimeReady: vi.fn(() => false),
	readSoundChoice: vi.fn(() => false),
	writeSoundChoice: vi.fn(),
	clearSoundChoice: vi.fn(),
}))
vi.mock('#app/utils/orders/waiting-chime.ts', () => chime)

function waitingOrder(over: Partial<Order> = {}): Order {
	return orderSchema.parse({
		id: 'o1',
		number: '20261019-0001',
		status: 'pending_acceptance',
		paymentStatus: 'paid',
		paymentMethod: 'online',
		loyaltyDiscountCents: 0,
		totalCents: 2500,
		refundedCents: 0,
		currency: 'usd',
		createdAt: '2026-10-19T10:00:00.000Z',
		contact: { name: 'Alex', phone: '+1555', email: null },
		fulfillment: 'pickup',
		location: { id: 'l1', name: 'Main' },
		lines: [],
		pickup: null,
		drop: null,
		delivery: null,
		acceptanceDeadlineAt: new Date(Date.now() + 192_000).toISOString(),
		...over,
	})
}

/** `emptyAfterChange` plays the refreshed list: nothing waits any more. */
function Harness({
	initial,
	request,
	onChanged,
	emptyAfterChange,
}: {
	initial: Order[]
	request: Parameters<typeof WaitingLane>[0]['request']
	onChanged: () => void
	emptyAfterChange: boolean
}) {
	const [orders, setOrders] = useState(initial)
	return (
		<WaitingLane
			orgSlug="acme"
			orders={orders}
			canWrite
			request={request}
			onChanged={() => {
				onChanged()
				if (emptyAfterChange) setOrders([])
			}}
		/>
	)
}

function show(
	orders: Order[],
	request = vi.fn(),
	onChanged = vi.fn(),
	emptyAfterChange = false,
) {
	renderStaff(
		<Harness
			initial={orders}
			request={request}
			onChanged={onChanged}
			emptyAfterChange={emptyAfterChange}
		/>,
	)
	return { request, onChanged }
}

describe('WaitingLane', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resetServerClock()
		chime.chimeReady.mockReturnValue(false)
		chime.readSoundChoice.mockReturnValue(false)
	})

	it('renders nothing when no order waits', () => {
		show([])
		expect(screen.queryByTestId('waiting-lane')).toBeNull()
	})

	it('shows a count badge and the live countdown', () => {
		show([waitingOrder(), waitingOrder({ id: 'o2' })])
		expect(screen.getByTestId('waiting-count')).toHaveTextContent('2')
		expect(screen.getAllByTestId('acceptance-countdown')[0]).toHaveTextContent(
			/Accept within 3:1\d/,
		)
	})

	it('counts down on the server clock when this computer is minutes off', () => {
		// This computer is 5 minutes fast: the server's "now" is 5 minutes behind
		// what the computer reads. Without the offset this would say time is up.
		const local = Date.now()
		const serverTime = local - 5 * 60_000
		recordServerClock(serverTime, local, local)
		show([
			waitingOrder({
				acceptanceDeadlineAt: new Date(serverTime + 192_000).toISOString(),
			}),
		])
		const countdown = screen.getByTestId('acceptance-countdown')
		expect(countdown).toHaveTextContent(/Accept within 3:1\d/)
		expect(countdown).toHaveAttribute('data-expired', 'false')
	})

	it('accepts through the region', async () => {
		const request = vi.fn().mockResolvedValue({})
		const { onChanged } = show([waitingOrder()], request)
		await userEvent.click(screen.getByTestId('waiting-accept'))
		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		expect(request).toHaveBeenCalledWith('/o1', {
			method: 'PATCH',
			body: JSON.stringify({ status: 'accepted' }),
		})
	})

	it('announces the accepted order and moves focus to the lane heading', async () => {
		const request = vi.fn().mockResolvedValue({})
		show([waitingOrder()], request)
		const accept = screen.getByTestId('waiting-accept')
		accept.focus()
		await userEvent.click(accept)
		const message = await screen.findByTestId('waiting-message')
		await waitFor(() => expect(message).toHaveTextContent('Order accepted.'))
		expect(message).toHaveAttribute('role', 'status')
		expect(
			screen.getByRole('heading', { name: /Waiting for you/ }),
		).toHaveFocus()
	})

	it('keeps the lane and its notice when the last waiting order is accepted', async () => {
		const request = vi.fn().mockResolvedValue({})
		show([waitingOrder()], request, vi.fn(), true)
		await userEvent.click(screen.getByTestId('waiting-accept'))
		// The refreshed list is empty: the lane stays just to say so.
		await screen.findByText('Order accepted.')
		expect(screen.getByTestId('waiting-lane')).toBeInTheDocument()
		expect(screen.getByTestId('waiting-message')).toHaveTextContent(
			'Order accepted.',
		)
		expect(screen.queryByTestId('waiting-row')).toBeNull()
	})

	it('rejects with the chosen reason', async () => {
		const request = vi.fn().mockResolvedValue({ refundIntent: { id: 'r1' } })
		const { onChanged } = show([waitingOrder()], request)
		await userEvent.click(screen.getByTestId('waiting-reject'))
		await userEvent.click(await screen.findByTestId('order-reject-reason'))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Too busy' }),
		)
		await userEvent.click(screen.getByRole('button', { name: 'Reject order' }))
		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		expect(request).toHaveBeenCalledWith('/o1', {
			method: 'PATCH',
			body: JSON.stringify({ status: 'cancelled', rejectReason: 'too_busy' }),
		})
		expect(screen.getByTestId('waiting-message')).toHaveTextContent(
			'Order rejected. Refund pending',
		)
	})

	it('says the order was already decided on order_not_pending and refreshes', async () => {
		const request = vi
			.fn()
			.mockRejectedValue(
				new OperatorRequestError('x', 'order_not_pending', 409),
			)
		const { onChanged } = show([waitingOrder()], request)
		await userEvent.click(screen.getByTestId('waiting-accept'))
		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		expect(screen.getByTestId('waiting-message')).toHaveTextContent(
			'already decided or it timed out',
		)
	})

	it('turns the sound on and off with a toggle that says which it is', async () => {
		show([waitingOrder()])
		const toggle = screen.getByTestId('waiting-sound-button')
		expect(toggle).toHaveAttribute('aria-pressed', 'false')
		expect(toggle).toHaveTextContent('Sound off')
		expect(chime.playChime).not.toHaveBeenCalled()

		await userEvent.click(toggle)
		expect(chime.unlockChime).toHaveBeenCalled()
		expect(chime.writeSoundChoice).toHaveBeenCalled()
		expect(toggle).toHaveAttribute('aria-pressed', 'true')
		expect(toggle).toHaveTextContent('Sound on')
		expect(chime.playChime).toHaveBeenCalledTimes(1)

		await userEvent.click(toggle)
		expect(chime.clearSoundChoice).toHaveBeenCalled()
		expect(toggle).toHaveAttribute('aria-pressed', 'false')
		expect(toggle).toHaveTextContent('Sound off')
	})

	it('stops the repeating chime when the sound is turned off', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		try {
			show([waitingOrder()])
			const toggle = screen.getByTestId('waiting-sound-button')
			await userEvent.click(toggle)
			expect(chime.playChime).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(6000)
			expect(chime.playChime).toHaveBeenCalledTimes(2)
			await userEvent.click(toggle)
			await vi.advanceTimersByTimeAsync(30_000)
			expect(chime.playChime).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it('shows the sound as on when the audio is already allowed', async () => {
		chime.readSoundChoice.mockReturnValue(true)
		chime.chimeReady.mockReturnValue(true)
		show([waitingOrder()])
		await waitFor(() =>
			expect(screen.getByTestId('waiting-sound-button')).toHaveAttribute(
				'aria-pressed',
				'true',
			),
		)
		expect(chime.playChime).toHaveBeenCalled()
	})
})
