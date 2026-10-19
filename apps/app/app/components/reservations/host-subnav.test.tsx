// @vitest-environment jsdom
import { DirectionProvider } from '@repo/ui'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import {
	ReservationsShellProvider,
	type ReservationsShell,
} from '#app/components/reservations/shell-context.tsx'
import { HIDDEN_RESERVATIONS_NAV } from '#app/utils/reservations/nav.ts'
import {
	isHostRoute,
	reservationsRouteKey,
	reservationsSectionTab,
} from '#app/utils/reservations/shell-routes.ts'
import { renderStaff } from '#tests/staff-render.tsx'

const fullNav = {
	...HIDDEN_RESERVATIONS_NAV,
	visible: true,
	today: true,
	book: true,
	waitlist: true,
	guests: true,
	reports: true,
	settings: true,
}

function shell(overrides: Partial<ReservationsShell> = {}): ReservationsShell {
	return {
		orgSlug: 'acme',
		nav: fullNav,
		locations: [{ id: 'loc-1', name: 'Downtown' }],
		selectedLocationId: 'loc-1',
		onLocationChange: vi.fn(),
		actionsSlot: null,
		metaSlot: null,
		...overrides,
	}
}

describe('HostSubnav', () => {
	it('marks the active day view with aria-current and has no solid pill', () => {
		renderStaff(
			<HostSubnav
				orgSlug="acme"
				activeView="timeline"
				businessDate="2026-10-20"
			/>,
		)
		const nav = screen.getByRole('navigation', { name: 'Day views' })
		const active = nav.querySelectorAll('[aria-current="page"]')
		expect(active).toHaveLength(1)
		expect(active[0]?.textContent).toBe('Timeline')
		expect(nav.innerHTML).not.toMatch(/bg-primary/)
		expect(screen.getByTestId('host-view-tab-today').textContent).toBe('Board')
		expect(screen.getByTestId('host-view-tab-book').textContent).toBe('List')
	})

	it('hides the day views on Calendar, which is its own section tab', () => {
		renderStaff(
			<HostSubnav
				orgSlug="acme"
				activeView="calendar"
				businessDate="2026-10-20"
			/>,
		)
		expect(screen.queryByRole('navigation', { name: 'Day views' })).toBeNull()
	})

	it('hides the day stepper, service and area filters on Calendar', () => {
		renderStaff(
			<HostSubnav
				orgSlug="acme"
				activeView="calendar"
				businessDate="2026-10-20"
				onDateChange={() => {}}
				services={[{ id: 's1', name: 'Dinner' } as never]}
				onServiceChange={() => {}}
				areas={[{ id: 'a1', name: 'Main' } as never]}
				onAreaChange={() => {}}
			/>,
		)
		expect(screen.queryByTestId('host-service-select')).toBeNull()
		expect(screen.queryByTestId('host-area-select')).toBeNull()
		expect(screen.queryByTestId('host-prev-day-btn')).toBeNull()
	})

	it('hides views the member cannot open', () => {
		renderStaff(
			<ReservationsShellProvider
				value={shell({ nav: { ...fullNav, book: false } })}
			>
				<HostSubnav
					orgSlug="acme"
					activeView="today"
					businessDate="2026-10-20"
				/>
			</ReservationsShellProvider>,
		)
		expect(screen.queryByTestId('host-view-tab-timeline')).toBeNull()
	})

	it('shows Location only for several locations, in the context bar', () => {
		const one = renderStaff(
			<ReservationsShellProvider value={shell()}>
				<HostSubnav
					orgSlug="acme"
					activeView="today"
					businessDate="2026-10-20"
				/>
			</ReservationsShellProvider>,
		)
		expect(screen.queryByLabelText('Location')).toBeNull()
		one.unmount()
		renderStaff(
			<ReservationsShellProvider
				value={shell({
					locations: [
						{ id: 'loc-1', name: 'Downtown' },
						{ id: 'loc-2', name: 'Harbor' },
					],
				})}
			>
				<HostSubnav
					orgSlug="acme"
					activeView="today"
					businessDate="2026-10-20"
				/>
			</ReservationsShellProvider>,
		)
		expect(screen.getByLabelText('Location')).toBeTruthy()
	})

	it('steps the date and jumps back to today', () => {
		const onDateChange = vi.fn()
		renderStaff(
			<HostSubnav
				orgSlug="acme"
				activeView="today"
				businessDate="2026-10-20"
				todayDate="2026-10-18"
				onDateChange={onDateChange}
			/>,
		)
		fireEvent.click(screen.getByLabelText('Next day'))
		expect(onDateChange).toHaveBeenLastCalledWith('2026-10-21')
		fireEvent.click(screen.getByLabelText('Previous day'))
		expect(onDateChange).toHaveBeenLastCalledWith('2026-10-19')
		fireEvent.click(screen.getByTestId('host-today-jump-btn'))
		expect(onDateChange).toHaveBeenLastCalledWith('2026-10-18')
	})

	it('shows Today only away from today', () => {
		const props = {
			orgSlug: 'acme',
			activeView: 'today' as const,
			todayDate: '2026-10-18',
			onDateChange: vi.fn(),
		}
		const away = renderStaff(
			<HostSubnav {...props} businessDate="2026-10-20" />,
		)
		expect(screen.getByTestId('host-today-jump-btn')).toBeTruthy()
		away.unmount()
		renderStaff(<HostSubnav {...props} businessDate="2026-10-18" />)
		expect(screen.queryByTestId('host-today-jump-btn')).toBeNull()
	})

	it('collapses service and area into one Filters control, hidden for a single choice', async () => {
		const services = [
			{ id: 's1', name: 'Dinner' },
			{ id: 's2', name: 'Lunch' },
		] as never[]
		const areas = [
			{ id: 'a1', name: 'Main room' },
			{ id: 'a2', name: 'Patio' },
		] as never[]
		const base = {
			orgSlug: 'acme',
			activeView: 'today' as const,
			businessDate: '2026-10-20',
			onDateChange: vi.fn(),
			onServiceChange: vi.fn(),
			onAreaChange: vi.fn(),
		}
		const one = renderStaff(
			<HostSubnav
				{...base}
				services={[services[0]!] as never[]}
				areas={[areas[0]!] as never[]}
			/>,
		)
		expect(screen.queryByTestId('host-filters-btn')).toBeNull()
		one.unmount()
		const idle = renderStaff(
			<HostSubnav {...base} services={services} areas={areas} />,
		)
		expect(screen.getByTestId('host-filters-btn').textContent).toBe('Filters')
		expect(screen.queryByTestId('host-filters-dot')).toBeNull()
		idle.unmount()
		renderStaff(
			<HostSubnav
				{...base}
				services={services}
				areas={areas}
				selectedServiceId="s1"
				selectedAreaId="a1"
			/>,
		)
		expect(screen.getByTestId('host-filters-btn').textContent).toBe(
			'Dinner \u00b7 Main room',
		)
		expect(screen.getByTestId('host-filters-dot')).toBeTruthy()
		fireEvent.click(screen.getByTestId('host-filters-btn'))
		expect(await screen.findByTestId('host-service-select')).toBeTruthy()
		expect(screen.getByTestId('host-area-select')).toBeTruthy()
	})

	it('names freshness on the refresh button and prints it only when stale', () => {
		const fresh = renderStaff(
			<HostSubnav
				orgSlug="acme"
				activeView="today"
				businessDate="2026-10-20"
				onRefresh={vi.fn()}
				lastUpdatedAt={Date.now()}
			/>,
		)
		expect(
			screen.getByTestId('host-refresh-btn').getAttribute('aria-label'),
		).toContain('Updated just now')
		expect(screen.queryByTestId('host-updated-ago')).toBeNull()
		fresh.unmount()
		renderStaff(
			<HostSubnav
				orgSlug="acme"
				activeView="today"
				businessDate="2026-10-20"
				onRefresh={vi.fn()}
				lastUpdatedAt={Date.now() - 180_000}
			/>,
		)
		expect(screen.getByTestId('host-updated-ago').textContent).toMatch(/3/)
	})

	it('shows one primary action and hides write actions for read-only members', () => {
		const props = {
			orgSlug: 'acme',
			activeView: 'today' as const,
			businessDate: '2026-10-20',
			onOpenBookingSheet: vi.fn(),
			onOpenWalkIn: vi.fn(),
			onOpenConflictPanel: vi.fn(),
		}
		const writable = renderStaff(<HostSubnav {...props} />)
		expect(screen.getByTestId('open-booking-sheet-btn')).toBeTruthy()
		expect(screen.getByTestId('open-walk-in-btn')).toBeTruthy()
		writable.unmount()
		renderStaff(<HostSubnav {...props} canManage={false} />)
		expect(screen.queryByTestId('open-booking-sheet-btn')).toBeNull()
		expect(screen.queryByTestId('open-walk-in-btn')).toBeNull()
		expect(screen.getByTestId('open-conflict-panel-btn')).toBeTruthy()
	})

	it('mirrors the date chevrons in right-to-left', () => {
		renderStaff(
			<DirectionProvider direction="rtl">
				<HostSubnav
					orgSlug="acme"
					activeView="today"
					businessDate="2026-10-20"
					onDateChange={vi.fn()}
				/>
			</DirectionProvider>,
		)
		// Previous points to the right (start side) in right-to-left.
		expect(screen.getByLabelText('Previous day').innerHTML).toContain(
			'chevron-right',
		)
		expect(screen.getByLabelText('Next day').innerHTML).toContain(
			'chevron-left',
		)
	})
})

describe('shell routes', () => {
	it.each([
		['/acme/reservations/today', 'today', true, 'today'],
		['/acme/reservations/book', 'book', true, 'today'],
		['/acme/reservations/timeline', 'timeline', true, 'today'],
		['/acme/reservations/floor', 'floor', true, 'today'],
		['/acme/reservations/overview', 'overview', true, 'today'],
		['/acme/reservations/calendar', 'calendar', true, 'calendar'],
		['/acme/reservations/waitlist', 'waitlist', false, 'waitlist'],
		['/acme/reservations/guests/g-1', 'guests', false, 'guests'],
		['/acme/reservations/experiences/e-1', 'experiences', false, 'experiences'],
		['/acme/reservations/settings/tables', 'settings', false, 'settings'],
	])('%s', (pathname, key, host, tab) => {
		const routeKey = reservationsRouteKey(pathname, 'acme')
		expect(routeKey).toBe(key)
		expect(isHostRoute(routeKey)).toBe(host)
		expect(reservationsSectionTab(routeKey)).toBe(tab)
	})
})
