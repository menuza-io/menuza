// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { lintHours } from '@repo/common/hours-lint'
import { DAYS_OF_WEEK, type WeeklySchedule } from '@repo/common/location-types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HoursWarningsPanel } from './hours-warnings-panel.tsx'

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const week = (
	monday: Array<{ start: string; end: string }>,
	rest = [{ start: '10:00', end: '22:00' }],
): WeeklySchedule =>
	DAYS_OF_WEEK.map((day) => {
		const slots = day === 'monday' ? monday : rest
		return { day, isOpen: slots.length > 0, slots }
	})

function renderPanel(
	storeHours: WeeklySchedule,
	props: Partial<Parameters<typeof HoursWarningsPanel>[0]> = {},
) {
	const warnings = lintHours(
		{ storeHours, onlineHours: null, specialHours: null },
		{ now: new Date('2027-06-02T12:00:00Z') },
	)
	const onFix = vi.fn()
	render(
		<I18nProvider i18n={i18n}>
			<HoursWarningsPanel
				warnings={warnings}
				scopes={['store', 'online']}
				onFix={onFix}
				{...props}
			/>
		</I18nProvider>,
	)
	return { onFix, warnings }
}

describe('HoursWarningsPanel (#275)', () => {
	it('shows an AM and PM slip with "Did you mean 10:00 PM?" and applies the fix', () => {
		const { onFix } = renderPanel(week([{ start: '11:00', end: '10:00' }]))
		expect(screen.getByTestId('hours-warning').dataset.code).toBe(
			'closes_before_opens',
		)
		fireEvent.click(screen.getByRole('button', { name: /did you mean/i }))
		expect(onFix).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'set_slot_end', end: '22:00' }),
		)
	})

	it('shows a warning for a 2-hour day', () => {
		renderPanel(week([{ start: '10:00', end: '12:00' }]))
		expect(screen.getByTestId('hours-warning').dataset.code).toBe(
			'day_too_short',
		)
		expect(screen.getByText(/open for only 2 hours/i)).toBeTruthy()
	})

	it('renders nothing for overnight and 24-hour hours set on purpose', () => {
		renderPanel(
			week(
				[{ start: '00:00', end: '23:59' }],
				[{ start: '00:00', end: '23:59' }],
			),
		)
		expect(screen.queryByTestId('hours-warnings')).toBeNull()
		renderPanel(week([{ start: '22:00', end: '02:00' }]))
		expect(screen.queryByTestId('hours-warnings')).toBeNull()
	})

	it('offers a dismiss button that can be disabled with a reason', () => {
		const onDismiss = vi.fn()
		renderPanel(week([{ start: '10:00', end: '12:00' }]), {
			onDismiss,
			dismissDisabledReason: 'Save your changes first',
		})
		const button = screen.getByRole('button', {
			name: /dismiss until the hours change/i,
		}) as HTMLButtonElement
		expect(button).toBeDisabled()
		expect(screen.getByText('Save your changes first')).toBeTruthy()
	})
})
