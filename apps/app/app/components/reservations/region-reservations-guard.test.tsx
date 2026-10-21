// @vitest-environment jsdom

import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ReservationsSummary } from '#app/utils/reservations/region-confirmation.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	RegionReservationsGuard,
	type RegionReservationsGuardState,
} from './region-reservations-guard.tsx'

const SUMMARY: ReservationsSummary = {
	reservations: 18,
	upcomingReservations: 6,
	guests: 14,
	waitlistEntries: 3,
	holds: 1,
	tables: 12,
	experiences: 0,
	payments: 0,
	auditEntries: 40,
}

const ready = (
	overrides: Partial<RegionReservationsGuardState> = {},
): RegionReservationsGuardState => ({
	status: 'ready',
	summary: SUMMARY,
	requiresConfirmation: true,
	...overrides,
})

function renderGuard(
	state: RegionReservationsGuardState,
	props: {
		typed?: string
		onTypedChange?: (value: string) => void
		showConfirmInput?: boolean
	} = {},
) {
	return renderStaff(
		<RegionReservationsGuard
			orgSlug="acme"
			state={state}
			typed={props.typed ?? ''}
			onTypedChange={props.onTypedChange ?? (() => {})}
			showConfirmInput={props.showConfirmInput}
		/>,
	)
}

describe('RegionReservationsGuard', () => {
	it('shows loading status while counts load', () => {
		renderGuard({
			status: 'loading',
			summary: null,
			requiresConfirmation: false,
		})
		expect(screen.getByRole('status').textContent).toMatch(/Checking/)
		expect(screen.queryByLabelText('Organization slug')).toBeNull()
	})

	it('renders nothing when the region holds no reservation data', () => {
		const { container } = renderGuard(
			ready({ requiresConfirmation: false, summary: null }),
		)
		expect(container.textContent).toBe('')
	})

	it('shows reservation, guest, table, waitlist, and hold counts', () => {
		renderGuard(ready())
		const text = document.body.textContent ?? ''
		expect(text).toContain('Reservations: 18')
		expect(text).toContain('6 upcoming')
		expect(text).toContain('Guests: 14')
		expect(text).toContain('Tables: 12')
		expect(text).toContain('Waitlist entries: 3')
		expect(text).toContain('Active holds: 1')
	})

	it('treats an unknown summary as requiring confirmation', () => {
		renderGuard(ready({ summary: null }))
		expect(document.body.textContent).toMatch(/could not check/)
		expect(screen.getByLabelText('Organization slug')).toBeTruthy()
	})

	it('updates typed confirmation value', () => {
		const onTypedChange = vi.fn()
		renderGuard(ready(), { onTypedChange })
		fireEvent.change(screen.getByLabelText('Organization slug'), {
			target: { value: 'acme' },
		})
		expect(onTypedChange).toHaveBeenCalledWith('acme')
	})
})
