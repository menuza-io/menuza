// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type SpecialHour } from '@repo/common/location-types'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpecialHoursPicker } from './special-hours-picker.tsx'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2027-03-01T12:00:00Z'))
})

afterEach(() => {
	vi.useRealTimers()
})

const christmas: SpecialHour = {
	id: 'xmas',
	date: '2026-12-25',
	isOpen: false,
	slots: [],
	note: 'Christmas',
	repeatsYearly: true,
}
const oldOneOff: SpecialHour = {
	id: 'old',
	date: '2026-07-04',
	isOpen: false,
	slots: [],
	note: 'Old party',
}
const upcomingOneOff: SpecialHour = {
	id: 'soon',
	date: '2027-05-01',
	isOpen: false,
	slots: [],
}

function renderPicker(specialHours: SpecialHour[]) {
	return render(
		<I18nProvider i18n={i18n}>
			<SpecialHoursPicker specialHours={specialHours} onChange={() => {}} />
		</I18nProvider>,
	)
}

describe('SpecialHoursPicker (#242)', () => {
	it('marks a repeating entry and shows the date it applies on next', () => {
		renderPicker([christmas])
		const row = screen.getByTestId('special-hours-row')
		expect(row.textContent).toContain('2027-12-25')
		expect(row.textContent).toContain('Every year')
	})

	it('hides past one-off entries until "Show past" is on, but keeps repeating ones', () => {
		renderPicker([christmas, oldOneOff, upcomingOneOff])
		expect(screen.getAllByTestId('special-hours-row')).toHaveLength(2)
		expect(screen.queryByText('Old party')).toBeNull()
		fireEvent.click(screen.getByRole('switch', { name: /show past/i }))
		expect(screen.getAllByTestId('special-hours-row')).toHaveLength(3)
		expect(screen.getByText('(Old party)')).toBeTruthy()
	})

	it('lists upcoming entries soonest first', () => {
		renderPicker([upcomingOneOff, christmas])
		const rows = screen.getAllByTestId('special-hours-row')
		expect(rows[0]?.textContent).toContain('2027-05-01')
		expect(rows[1]?.textContent).toContain('2027-12-25')
	})
})
