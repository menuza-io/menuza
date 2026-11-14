// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WaitingLane } from '#app/components/orders/waiting-lane.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { type Order, orderSchema } from '#app/utils/orders/order-model.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const chime = vi.hoisted(() => ({
	playChime: vi.fn(),
	unlockChime: vi.fn(),
	chimeReady: vi.fn(() => false),
	readSoundChoice: vi.fn(() => false),
	writeSoundChoice: vi.fn(),
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

function show(orders: Order[], request = vi.fn(), onChanged = vi.fn()) {
	renderStaff(
		<WaitingLane
			orgSlug="acme"
			orders={orders}
			canWrite
			request={request}
			onChanged={onChanged}
		/>,
	)
	return { request, onChanged }
}

describe('WaitingLane', () => {
	beforeEach(() => {
		vi.clearAllMocks()
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

	it('offers sound once and chimes only after it is on', async () => {
		show([waitingOrder()])
		expect(chime.playChime).not.toHaveBeenCalled()
		await userEvent.click(screen.getByTestId('waiting-sound-button'))
		expect(chime.unlockChime).toHaveBeenCalled()
		expect(chime.writeSoundChoice).toHaveBeenCalled()
		expect(screen.queryByTestId('waiting-sound-button')).toBeNull()
		expect(chime.playChime).toHaveBeenCalled()
	})

	it('hides the sound button when the audio is already allowed', async () => {
		chime.readSoundChoice.mockReturnValue(true)
		chime.chimeReady.mockReturnValue(true)
		show([waitingOrder()])
		await waitFor(() =>
			expect(screen.queryByTestId('waiting-sound-button')).toBeNull(),
		)
		expect(chime.playChime).toHaveBeenCalled()
	})
})
