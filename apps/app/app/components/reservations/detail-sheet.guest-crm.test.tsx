// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { Outlet, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import {
	normalizeGuestSummary,
	type DayReservationView,
} from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const fetchReservationDetail = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/reservations/book-api.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return { ...actual, fetchReservationDetail }
})

function reservation(): DayReservationView {
	const guest = normalizeGuestSummary({
		id: 'g_1',
		firstName: 'Ada',
		lastName: 'Lovelace',
		customerLinked: true,
		pinnedNotes: [{ id: 'n1', body: 'Celebrating an anniversary' }],
	})
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
		dietaryCodes: [],
		guest,
	} as unknown as DayReservationView
}

function renderSheet(nav: { guests: boolean }) {
	renderStaff(
		<Routes>
			<Route element={<Outlet context={{ orgSlug: 'acme', nav }} />} path="*">
				<Route
					index
					element={
						<DetailSheet
							reservationId="rsv_1"
							fallbackReservation={reservation()}
							onClose={vi.fn()}
							client={{} as ReservationsScopedClient}
							tables={[]}
							onUpdated={vi.fn()}
						/>
					}
				/>
			</Route>
		</Routes>,
	)
}

describe('DetailSheet guest summary', () => {
	beforeEach(() => {
		fetchReservationDetail.mockReset()
		fetchReservationDetail.mockRejectedValue(new Error('offline'))
	})

	it('shows pinned notes and the linked customer, with a link for guest readers', async () => {
		renderSheet({ guests: true })
		expect(
			await screen.findByTestId('detail-guest-pinned-notes'),
		).toHaveTextContent('Celebrating an anniversary')
		expect(
			screen.getByTestId('detail-guest-customer-linked'),
		).toBeInTheDocument()
		expect(screen.getByTestId('detail-guest-profile-link')).toHaveAttribute(
			'href',
			'/acme/reservations/guests/g_1',
		)
	})

	it('offers no profile link without the guest grant', async () => {
		renderSheet({ guests: false })
		await screen.findByTestId('detail-guest-pinned-notes')
		expect(
			screen.queryByTestId('detail-guest-profile-link'),
		).not.toBeInTheDocument()
		expect(
			screen.getByTestId('detail-guest-customer-linked'),
		).toBeInTheDocument()
	})
})
