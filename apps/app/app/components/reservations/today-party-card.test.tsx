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

	it('puts the action in its own wrapping row, outside the name row', () => {
		renderStaff(
			<TodayPartyCard reservation={rsv()} kind="upcoming" {...props()} />,
		)
		const actions = screen.getByTestId('today-actions-r1')
		const name = screen.getByTestId('today-open-detail-r1')
		expect(actions.contains(screen.getByTestId('today-arrive-r1'))).toBe(true)
		expect(actions.contains(name)).toBe(false)
		expect(actions.className).toContain('flex-wrap')
		expect(actions.className).toContain('min-w-0')
	})
})
