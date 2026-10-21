// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { type DayWaitlistView } from '#app/utils/reservations/book-api.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { TodayWaitlistCard } from './today-waitlist-card.tsx'

const entry = (overrides: Partial<DayWaitlistView> & { id: string }) =>
	({
		locationId: 'loc_1',
		serviceId: null,
		areaId: null,
		guestId: null,
		guestName: `Guest ${overrides.id}`,
		guestPhone: '',
		partySize: 2,
		businessDate: '2026-04-20',
		windowStartMin: 0,
		windowEndMin: 0,
		quotedWaitMin: 25,
		status: 'waiting',
		position: 1,
		notes: null,
		notifiedAt: null,
		offerExpiresAt: null,
		seatedReservationId: null,
		createdAt: 0,
		...overrides,
	}) as DayWaitlistView

describe('TodayWaitlistCard', () => {
	it('shows the live queue in order, read only, and hides finished parties', () => {
		renderStaff(
			<TodayWaitlistCard
				orgSlug="acme"
				entries={[
					entry({
						id: 'b',
						guestName: 'Omar',
						position: 2,
						quotedWaitMin: null,
					}),
					entry({ id: 'a', guestName: 'Rana', position: 1 }),
					entry({ id: 'c', guestName: 'Gone', status: 'seated', position: 3 }),
				]}
			/>,
		)
		expect(screen.getByTestId('today-waitlist-count')).toHaveTextContent('2')
		const rows = screen.getAllByTestId(/^today-waitlist-row-/)
		expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
			'today-waitlist-row-a',
			'today-waitlist-row-b',
		])
		expect(rows[0]).toHaveTextContent('#1')
		expect(rows[0]).toHaveTextContent('Rana')
		expect(rows[0]).toHaveTextContent('2 guests')
		expect(rows[0]).toHaveTextContent('Quoted 25 min')
		expect(rows[1]).toHaveTextContent('No quote')
		expect(screen.queryByRole('button', { name: /notify|seat/i })).toBeNull()
		expect(screen.getByTestId('today-waitlist-open')).toHaveAttribute(
			'href',
			'/acme/reservations/waitlist',
		)
	})

	it('shows an empty state', () => {
		renderStaff(<TodayWaitlistCard orgSlug="acme" entries={[]} />)
		expect(screen.getByTestId('today-waitlist-empty')).toBeTruthy()
		expect(screen.getByTestId('today-waitlist-count')).toHaveTextContent('0')
	})
})
