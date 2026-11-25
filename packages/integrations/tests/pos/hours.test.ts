import { describe, expect, it } from 'vitest'
import { projectSpecialHoursForPlatform } from '../../src/pos/hours'

describe('projectSpecialHoursForPlatform (#96)', () => {
	it('projects closed days and changed slots in the location timezone and skips past dates', () => {
		// 2026-11-25T04:00:00Z is 2026-11-24 23:00 in America/New_York
		const now = new Date('2026-11-25T04:00:00.000Z')
		const input = JSON.stringify([
			{
				id: 'past',
				date: '2026-11-23',
				isOpen: false,
				slots: [],
			},
			{
				id: 'today-ny',
				date: '2026-11-24',
				isOpen: true,
				slots: [{ start: '11:00', end: '16:00' }],
			},
			{
				id: 'thanksgiving',
				date: '2026-11-26',
				isOpen: false,
				slots: [{ start: '09:00', end: '17:00' }],
			},
			{
				id: 'christmas-eve',
				date: '2026-12-24',
				isOpen: true,
				slots: [
					{ start: '10:00', end: '14:00' },
					{ start: '17:00', end: '20:00' },
				],
			},
		])

		const result = projectSpecialHoursForPlatform(
			input,
			'America/New_York',
			now,
		)

		expect(result).toEqual([
			{
				date: '2026-11-24',
				isOpen: true,
				intervals: [{ start: '11:00', end: '16:00' }],
				timezone: 'America/New_York',
			},
			{
				date: '2026-11-26',
				isOpen: false,
				intervals: [],
				timezone: 'America/New_York',
			},
			{
				date: '2026-12-24',
				isOpen: true,
				intervals: [
					{ start: '10:00', end: '14:00' },
					{ start: '17:00', end: '20:00' },
				],
				timezone: 'America/New_York',
			},
		])
	})

	it('skips today-ny when in UTC it is already 2026-11-25', () => {
		const now = new Date('2026-11-25T04:00:00.000Z')
		const result = projectSpecialHoursForPlatform(
			[
				{
					id: 'yesterday-utc',
					date: '2026-11-24',
					isOpen: false,
					slots: [],
				},
				{
					id: 'today-utc',
					date: '2026-11-25',
					isOpen: false,
					slots: [],
				},
			],
			'UTC',
			now,
		)
		expect(result).toEqual([
			{
				date: '2026-11-25',
				isOpen: false,
				intervals: [],
				timezone: 'UTC',
			},
		])
	})

	it('returns empty array for invalid JSON or invalid entries', () => {
		expect(projectSpecialHoursForPlatform('{bad json', 'UTC')).toEqual([])
		expect(
			projectSpecialHoursForPlatform(
				[{ id: '1', date: 'not-a-date', isOpen: false, slots: [] }],
				'UTC',
			),
		).toEqual([])
	})
})
