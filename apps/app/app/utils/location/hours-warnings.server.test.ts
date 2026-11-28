import { describe, expect, it } from 'vitest'
import { savedHoursWarnings } from './hours-warnings.server.ts'

const week = (
	overrides: Record<string, Array<{ start: string; end: string }>> = {},
) =>
	JSON.stringify(
		[
			'monday',
			'tuesday',
			'wednesday',
			'thursday',
			'friday',
			'saturday',
			'sunday',
		].map((day) => {
			const slots = overrides[day] ?? [{ start: '10:00', end: '22:00' }]
			return { day, isOpen: slots.length > 0, slots }
		}),
	)

const now = new Date('2027-06-02T12:00:00Z')

describe('savedHoursWarnings (#275)', () => {
	it('is quiet for ordinary hours and for no hours at all', () => {
		expect(
			savedHoursWarnings(
				{
					storeHours: week(),
					onlineHours: null,
					specialHours: null,
					timezone: 'America/New_York',
				},
				now,
			).all,
		).toEqual([])
		expect(
			savedHoursWarnings(
				{ storeHours: null, onlineHours: null, specialHours: null },
				now,
			).all,
		).toEqual([])
	})

	it('reads the stored JSON: a 2-hour day and online hours outside store hours', () => {
		const result = savedHoursWarnings(
			{
				storeHours: week({ monday: [{ start: '10:00', end: '12:00' }] }),
				onlineHours: week({ tuesday: [{ start: '09:00', end: '23:00' }] }),
				specialHours: null,
				timezone: 'America/New_York',
			},
			now,
		)
		expect(result.all.map((w) => [w.scope, w.code, w.day])).toEqual([
			['store', 'day_too_short', 'monday'],
			['online', 'online_outside_store', 'monday'],
			['online', 'online_outside_store', 'tuesday'],
		])
	})

	it('shows nothing while the dismissal matches the saved hours, and again once they change', () => {
		const base = {
			storeHours: week({ monday: [{ start: '10:00', end: '12:00' }] }),
			onlineHours: null,
			specialHours: null,
			timezone: 'UTC',
		}
		const first = savedHoursWarnings(base, now)
		expect(first.visible).toHaveLength(1)
		const dismissed = savedHoursWarnings(
			{ ...base, hoursWarningsDismissedFor: first.fingerprint },
			now,
		)
		expect(dismissed.dismissed).toBe(true)
		expect(dismissed.visible).toEqual([])
		const changed = savedHoursWarnings(
			{
				...base,
				storeHours: week({ monday: [{ start: '10:00', end: '11:00' }] }),
				hoursWarningsDismissedFor: first.fingerprint,
			},
			now,
		)
		expect(changed.dismissed).toBe(false)
		expect(changed.visible).toHaveLength(1)
	})

	it('treats online hours equal to the store hours as following them', () => {
		const hours = week({ monday: [{ start: '10:00', end: '12:30' }] })
		const result = savedHoursWarnings(
			{ storeHours: hours, onlineHours: hours, specialHours: null },
			now,
		)
		// Only the store's own short day; nothing is doubled for online.
		expect(result.all.map((w) => w.scope)).toEqual(['store'])
	})

	it('reads special hours and skips past one-off entries', () => {
		const result = savedHoursWarnings(
			{
				storeHours: week(),
				onlineHours: null,
				specialHours: JSON.stringify([
					{ id: 'a', date: '2026-01-01', isOpen: true, slots: [] },
					{ id: 'b', date: '2027-12-25', isOpen: true, slots: [] },
				]),
				timezone: 'UTC',
			},
			now,
		)
		expect(result.all.map((w) => [w.code, w.date])).toEqual([
			['special_open_without_hours', '2027-12-25'],
		])
	})
})
