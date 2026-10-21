// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type DayReservationView } from '#app/utils/reservations/book-api.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { TodayPartyCard } from './today-party-card.tsx'

const rsv = (over: Partial<DayReservationView> = {}) =>
	({
		id: 'r1',
		guestName: 'Amal Khan',
		partySize: 4,
		hhmm: '19:00',
		status: 'confirmed',
		channel: 'online',
		assignedTableLabels: [],
		dietaryCodes: [],
		guestNotes: null,
		occasion: null,
		lateRisk: true,
		runningLateMin: null,
		paymentStatus: 'none',
		experienceId: null,
		guest: { vipTier: 'gold' },
		durationMin: 90,
		completedAt: null,
		...over,
	}) as unknown as DayReservationView

const props = () => ({
	canManage: true,
	busy: false,
	nowMs: 0,
	onOpenDetail: vi.fn(),
	onAction: vi.fn(),
	onRunningLate: vi.fn(),
})

describe('TodayPartyCard', () => {
	it('shows one primary action, a name link, and at most two badges', () => {
		const p = props()
		const { container } = renderStaff(
			<TodayPartyCard reservation={rsv()} kind="upcoming" {...p} />,
		)
		expect(screen.getByTestId('today-arrive-r1')).toBeTruthy()
		expect(screen.queryByTestId('today-seat-r1')).toBeNull()
		expect(
			container.querySelectorAll('[data-slot="badge"]').length,
		).toBeLessThanOrEqual(2)
		fireEvent.click(screen.getByTestId('today-open-detail-r1'))
		expect(p.onOpenDetail).toHaveBeenCalledWith('r1')
		fireEvent.click(screen.getByTestId('today-arrive-r1'))
		expect(p.onAction).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'r1' }),
			expect.objectContaining({ action: 'arrive', to: 'arrived' }),
		)
	})

	it('labels the primary action of a confirmed party with a verb, not a status', () => {
		renderStaff(
			<TodayPartyCard reservation={rsv()} kind="upcoming" {...props()} />,
		)
		expect(screen.getByTestId('today-arrive-r1').textContent).toBe(
			'Mark arrived',
		)
	})

	it('offers Seat for an arrived party and hides actions when read-only', () => {
		renderStaff(
			<TodayPartyCard
				reservation={rsv({ status: 'arrived' })}
				kind="upcoming"
				{...props()}
			/>,
		)
		expect(screen.getByTestId('today-seat-r1')).toBeTruthy()
	})

	it('has no action buttons without manage rights', () => {
		renderStaff(
			<TodayPartyCard
				reservation={rsv()}
				kind="upcoming"
				{...props()}
				canManage={false}
			/>,
		)
		expect(screen.queryByTestId('today-arrive-r1')).toBeNull()
		expect(screen.queryByTestId('today-menu-r1')).toBeNull()
	})

	it('puts the action and the menu at the end of the first line, beside the time', () => {
		renderStaff(
			<TodayPartyCard reservation={rsv()} kind="upcoming" {...props()} />,
		)
		const actions = screen.getByTestId('today-actions-r1')
		const name = screen.getByTestId('today-open-detail-r1')
		const time = screen.getByTestId('today-time-r1')
		expect(actions.contains(screen.getByTestId('today-arrive-r1'))).toBe(true)
		expect(actions.contains(screen.getByTestId('today-menu-r1'))).toBe(true)
		expect(actions.contains(name)).toBe(false)
		// Same row as the time, so the card needs no separate action column.
		expect(actions.parentElement).toBe(time.parentElement)
		expect(actions.className).toContain('shrink-0')
	})

	it('shows the allergen in full and VIP as chips on the card', () => {
		renderStaff(
			<TodayPartyCard
				reservation={rsv({
					hasAllergy: true,
					dietaryCodes: ['shellfish_allergy'],
					guest: { vipTier: 'vip' } as never,
				})}
				kind="upcoming"
				{...props()}
			/>,
		)
		expect(screen.getByTestId('guest-flag-allergy').textContent).toContain(
			'Shellfish Allergy',
		)
		expect(screen.getByTestId('guest-flag-vip')).toBeTruthy()
	})

	it('puts the time and guest count on their own line, apart from the name link', () => {
		renderStaff(
			<TodayPartyCard
				reservation={rsv({ guestName: 'Layla Al-Mansoor', partySize: 2 })}
				kind="upcoming"
				{...props()}
			/>,
		)
		const time = screen.getByTestId('today-time-r1')
		expect(time.textContent).toContain('19:00')
		expect(time.textContent).toContain('2 guests')
		const name = screen.getByTestId('today-open-detail-r1')
		expect(name.textContent).toBe('Layla Al-Mansoor')
	})

	it('keeps notes and the booking channel off the card', () => {
		renderStaff(
			<TodayPartyCard
				reservation={rsv({
					guestNotes: 'Window table please',
					channel: 'host_stand',
				})}
				kind="upcoming"
				{...props()}
			/>,
		)
		expect(screen.queryByTestId('today-notes-r1')).toBeNull()
		expect(screen.queryByTestId('today-channel-r1')).toBeNull()
		expect(screen.queryByText(/Window table/)).toBeNull()
	})

	it('shows one status line: table and status, with elapsed time when seated', () => {
		renderStaff(
			<TodayPartyCard
				reservation={rsv({
					status: 'seated',
					assignedTableLabels: ['T2'],
					durationMin: 90,
				})}
				kind="seated"
				elapsedMin={182}
				{...props()}
			/>,
		)
		expect(screen.getByTestId('today-time-r1').textContent).toContain('T2')
		const elapsed = screen.getByTestId('today-elapsed-r1')
		expect(elapsed.textContent).toBe('182m / 90m')
		expect(elapsed.parentElement?.textContent).toContain('Seated')
		expect(elapsed.className).toContain('text-warning')
	})
})
