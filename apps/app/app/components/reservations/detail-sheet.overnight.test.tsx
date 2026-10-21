// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const api = vi.hoisted(() => ({
	fetchReservationDetail: vi.fn(),
	updateReservation: vi.fn(),
}))

vi.mock('#app/utils/reservations/book-api.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/utils/reservations/book-api.ts')>()
	return {
		...actual,
		fetchReservationDetail: api.fetchReservationDetail,
		updateReservation: api.updateReservation,
	}
})

// An overnight booking: minute 1470 is 00:30 on the next calendar day.
const overnight = {
	id: 'rsv_1',
	version: 1,
	confirmationCode: 'ABC123',
	guestName: 'Ada Lovelace',
	guestPhone: '+15555550100',
	guestEmail: null,
	partySize: 2,
	businessDate: '2026-10-16',
	localStartMin: 1470,
	hhmm: '00:30',
	endHhmm: '02:00',
	durationMin: 90,
	status: 'booked',
	channel: 'host',
	client: 'web',
	locked: false,
	assignedTableIds: [],
	assignedTableLabels: [],
	dietaryCodes: [],
} as unknown as DayReservationView

function renderSheet() {
	renderStaff(
		<DetailSheet
			reservationId={overnight.id}
			fallbackReservation={overnight}
			onClose={vi.fn()}
			client={{} as ReservationsScopedClient}
			tables={[]}
			canManage
			onUpdated={vi.fn()}
		/>,
	)
}

describe('DetailSheet editing an overnight booking', () => {
	beforeEach(() => {
		for (const fn of Object.values(api)) fn.mockReset()
		api.fetchReservationDetail.mockRejectedValue(new Error('offline'))
		api.updateReservation.mockResolvedValue({
			reservation: overnight,
			moveNotices: [],
		})
	})

	it('a notes-only edit sends no time change', async () => {
		renderSheet()
		const time = (await screen.findByTestId(
			'detail-time-input',
		)) as HTMLInputElement
		expect(time.value).toBe('00:30')
		fireEvent.change(screen.getByTestId('detail-guest-notes-input'), {
			target: { value: 'Window seat' },
		})
		fireEvent.click(screen.getByTestId('detail-save-notes-btn'))
		await waitFor(() => expect(api.updateReservation).toHaveBeenCalled())
		const body = api.updateReservation.mock.calls[0]![2]
		expect(body).not.toHaveProperty('localStartMin')
		expect(body.guestNotes).toBe('Window seat')
	})

	it('changing the time to 00:45 saves minute 1485', async () => {
		renderSheet()
		fireEvent.change(await screen.findByTestId('detail-time-input'), {
			target: { value: '00:45' },
		})
		fireEvent.click(screen.getByTestId('detail-save-notes-btn'))
		await waitFor(() => expect(api.updateReservation).toHaveBeenCalled())
		expect(api.updateReservation.mock.calls[0]![2].localStartMin).toBe(1485)
	})
})
