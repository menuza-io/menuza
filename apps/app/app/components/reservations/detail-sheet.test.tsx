// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const fetchReservationDetail = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/reservations/book-api.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/utils/reservations/book-api.ts')>()
	return { ...actual, fetchReservationDetail }
})

function makeReservation(
	overrides: Partial<DayReservationView> = {},
): DayReservationView {
	return {
		id: 'rsv_1',
		version: 1,
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
		locked: false,
		assignedTableIds: [],
		assignedTableLabels: [],
		serverLabel: null,
		courseStage: null,
		dietaryCodes: [],
		guestNotes: null,
		internalNotes: null,
		runningLateMin: null,
		contactStatus: null,
		...overrides,
	} as unknown as DayReservationView
}

function renderSheet(initial: DayReservationView) {
	let push: (next: DayReservationView) => void = () => {}
	function Harness() {
		const [reservation, setReservation] = useState(initial)
		push = setReservation
		return (
			<DetailSheet
				reservationId={reservation.id}
				fallbackReservation={reservation}
				onClose={vi.fn()}
				client={{} as ReservationsScopedClient}
				tables={[]}
				onUpdated={vi.fn()}
			/>
		)
	}
	renderStaff(<Harness />)
	return {
		rerenderWith(next: DayReservationView) {
			act(() => push(next))
		},
	}
}

describe('DetailSheet unsaved edits', () => {
	beforeEach(() => {
		fetchReservationDetail.mockReset()
		fetchReservationDetail.mockRejectedValue(new Error('offline'))
	})

	it('keeps edited notes, party size and time when the reservation prop refreshes', async () => {
		const view = renderSheet(makeReservation())

		const notes = await screen.findByTestId('detail-guest-notes-input')
		fireEvent.change(notes, { target: { value: 'Window seat please' } })
		fireEvent.change(screen.getByTestId('detail-party-size-input'), {
			target: { value: '6' },
		})
		fireEvent.change(screen.getByTestId('detail-time-input'), {
			target: { value: '20:15' },
		})

		view.rerenderWith(
			makeReservation({
				version: 2,
				guestNotes: 'Server-side note',
				partySize: 3,
				hhmm: '19:30',
				localStartMin: 19 * 60 + 30,
			}),
		)

		await waitFor(() =>
			expect(
				(screen.getByTestId('detail-guest-notes-input') as HTMLTextAreaElement)
					.value,
			).toBe('Window seat please'),
		)
		expect(
			(screen.getByTestId('detail-party-size-input') as HTMLInputElement).value,
		).toBe('6')
		expect(
			(screen.getByTestId('detail-time-input') as HTMLInputElement).value,
		).toBe('20:15')
	})

	it('applies refreshed values to fields the operator did not edit', async () => {
		const view = renderSheet(makeReservation())
		await screen.findByTestId('detail-guest-notes-input')

		view.rerenderWith(makeReservation({ version: 2, internalNotes: 'VIP' }))

		await waitFor(() =>
			expect(
				(
					screen.getByTestId(
						'detail-internal-notes-input',
					) as HTMLTextAreaElement
				).value,
			).toBe('VIP'),
		)
	})
})
