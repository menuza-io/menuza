// @vitest-environment jsdom

import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScopeWordingProvider } from '#app/components/staff/scope-wording-provider.tsx'
import { type ForecastDayRow } from '#app/utils/staffing/labor-types.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { bookedUnitsOf, ForecastCells } from './forecast-strip.tsx'

function dayWith(
	bookedVisits: Record<number, number>,
	status: ForecastDayRow['hours'][number]['status'] = 'ok',
): ForecastDayRow {
	return {
		date: '2026-03-09',
		hours: Array.from({ length: 24 }, (_, hour) => ({
			hour,
			orders: 0,
			booked: 0,
			unitsBySource: { visits: bookedVisits[hour] ?? 0 },
			bookedBySource: { orders: 0, visits: bookedVisits[hour] ?? 0 },
			needed: 0,
			scheduled: 0,
			short: 0,
			surplus: 0,
			status,
		})),
		neededHours: 0,
		scheduledHours: 0,
		shortHours: 0,
		surplusHours: 0,
		unpositionedHours: 0,
		byPosition: [],
	}
}

function show(
	node: React.ReactNode,
	wording: 'location' | 'workplace' = 'location',
) {
	renderStaff(
		<ScopeWordingProvider wording={wording}>{node}</ScopeWordingProvider>,
	)
}

describe('booked units in the forecast strip', () => {
	it('sums the visits booked across the day', () => {
		expect(bookedUnitsOf(dayWith({ 19: 6, 20: 4 }))).toBe(10)
		expect(bookedUnitsOf(dayWith({}))).toBe(0)
	})

	it('says "N covers booked" for a restaurant (VAL-FCST-002)', () => {
		show(<ForecastCells day={dayWith({ 19: 6, 20: 4 })} />)
		expect(screen.getByText('10 covers booked')).toBeTruthy()
	})

	it('says one cover in the singular and nothing when no one is booked', () => {
		const { unmount } = renderStaff(
			<ScopeWordingProvider wording="location">
				<ForecastCells day={dayWith({ 19: 1 })} />
			</ScopeWordingProvider>,
		)
		expect(screen.getByText('1 cover booked')).toBeTruthy()
		unmount()
		show(<ForecastCells day={dayWith({})} />)
		expect(screen.queryByText(/booked/)).toBeNull()
	})

	it('says visits for a business that is not a restaurant', () => {
		show(<ForecastCells day={dayWith({ 19: 3 })} />, 'workplace')
		expect(screen.getByText('3 visits booked')).toBeTruthy()
		expect(screen.queryByText(/covers/)).toBeNull()
	})

	it('shows only the count, no hour cells, until a standard is set', () => {
		show(<ForecastCells day={dayWith({ 19: 5 })} configured={false} />)
		expect(screen.getByText('5 covers booked')).toBeTruthy()
		expect(screen.queryByRole('img')).toBeNull()
	})

	it('keeps the hour cells and the booked count together once configured', () => {
		show(<ForecastCells day={dayWith({ 19: 5 })} />)
		expect(screen.getByRole('img')).toBeTruthy()
		expect(screen.getByText('5 covers booked')).toBeTruthy()
	})
})
