// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const api = vi.hoisted(() => ({
	fetchReservationDetail: vi.fn(),
	transition: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('#app/utils/reservations/book-api.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/utils/reservations/book-api.ts')>()
	return {
		...actual,
		fetchReservationDetail: api.fetchReservationDetail,
		transitionReservationStatus: api.transition,
	}
})

function makeReservation(
	overrides: Partial<DayReservationView> = {},
): DayReservationView {
	return {
		id: 'rsv_1',
		version: 4,
		confirmationCode: 'ABC123',
		guestName: 'Ada Lovelace',
		guestPhone: '+15555550100',
		guestEmail: null,
		partySize: 2,
		businessDate: '2026-10-16',
		localStartMin: 19 * 60,
		hhmm: '19:00',
		endHhmm: '20:30',
		durationMin: 90,
		status: 'booked',
		channel: 'online',
		client: 'web',
		locked: false,
		assignedTableIds: [],
		assignedTableLabels: [],
		dietaryCodes: [],
		paymentStatus: 'none',
		experienceId: null,
		...overrides,
	} as unknown as DayReservationView
}

function renderSheet(reservation: DayReservationView) {
	renderStaff(
		<DetailSheet
			reservationId={reservation.id}
			fallbackReservation={reservation}
			onClose={vi.fn()}
			client={{} as ReservationsScopedClient}
			tables={[]}
			canManage
			onUpdated={vi.fn()}
		/>,
	)
}

describe('DetailSheet cancel reason', () => {
	beforeEach(() => {
		for (const fn of Object.values(api)) fn.mockReset()
		api.fetchReservationDetail.mockRejectedValue(new Error('offline'))
		api.transition.mockResolvedValue({
			reservation: makeReservation({ status: 'cancelled', version: 5 }),
			undoToken: 'undo',
			undoExpiresAt: Date.now() + 60_000,
			moveNotices: [],
		})
	})

	it('asks before cancelling and passes the typed reason to the cancel call', async () => {
		renderSheet(makeReservation())
		fireEvent.click(await screen.findByTestId('detail-status-cancelled'))
		expect(api.transition).not.toHaveBeenCalled()
		await screen.findByTestId('detail-cancel-dialog')
		fireEvent.change(screen.getByTestId('detail-cancel-reason'), {
			target: { value: '  Guest called, sick child  ' },
		})
		fireEvent.click(screen.getByTestId('detail-cancel-confirm'))
		await waitFor(() => expect(api.transition).toHaveBeenCalledTimes(1))
		expect(api.transition).toHaveBeenCalledWith(
			expect.anything(),
			'rsv_1',
			expect.objectContaining({
				to: 'cancelled',
				expectedVersion: 4,
				reason: 'Guest called, sick child',
			}),
		)
	})

	it('cancels without a reason when the field is left empty', async () => {
		renderSheet(makeReservation())
		fireEvent.click(await screen.findByTestId('detail-status-cancelled'))
		await screen.findByTestId('detail-cancel-dialog')
		fireEvent.change(screen.getByTestId('detail-cancel-reason'), {
			target: { value: '   ' },
		})
		fireEvent.click(screen.getByTestId('detail-cancel-confirm'))
		await waitFor(() => expect(api.transition).toHaveBeenCalledTimes(1))
		expect(api.transition.mock.calls[0]![2]).not.toHaveProperty('reason')
	})

	it('keeps the booking when the dialog is dismissed', async () => {
		renderSheet(makeReservation())
		fireEvent.click(await screen.findByTestId('detail-status-cancelled'))
		await screen.findByTestId('detail-cancel-dialog')
		fireEvent.click(screen.getByRole('button', { name: 'Keep reservation' }))
		await waitFor(() =>
			expect(screen.queryByTestId('detail-cancel-dialog')).toBeNull(),
		)
		expect(api.transition).not.toHaveBeenCalled()
	})

	it('does not reuse an earlier reason for the next cancellation', async () => {
		renderSheet(makeReservation())
		fireEvent.click(await screen.findByTestId('detail-status-cancelled'))
		await screen.findByTestId('detail-cancel-dialog')
		fireEvent.change(screen.getByTestId('detail-cancel-reason'), {
			target: { value: 'first reason' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Keep reservation' }))
		await waitFor(() =>
			expect(screen.queryByTestId('detail-cancel-dialog')).toBeNull(),
		)
		fireEvent.click(screen.getByTestId('detail-status-cancelled'))
		const field = (await screen.findByTestId(
			'detail-cancel-reason',
		)) as HTMLTextAreaElement
		expect(field.value).toBe('')
	})
})

describe('DetailSheet payment badge', () => {
	beforeEach(() => {
		api.fetchReservationDetail.mockReset()
		api.fetchReservationDetail.mockRejectedValue(new Error('offline'))
	})

	it('shows the same badge as the list row and the experience label', async () => {
		renderSheet(
			makeReservation({ paymentStatus: 'paid', experienceId: 'exp_1' }),
		)
		expect((await screen.findByTestId('payment-badge')).textContent).toBe(
			'Prepaid',
		)
		expect(screen.getByTestId('detail-experience-badge')).toBeTruthy()
	})

	it('shows no payment badge for a booking without a payment', async () => {
		renderSheet(makeReservation())
		await screen.findByTestId('detail-guest-name')
		expect(screen.queryByTestId('payment-badge')).toBeNull()
	})
})
