import { describe, expect, it } from 'vitest'
import { type LocationHours } from '../rules/location-hours.ts'
import { validateLocationHoursSetup } from './location-hours-validate.ts'

const DAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
] as const

function hours(over: Partial<LocationHours> = {}): LocationHours {
	return {
		timeZone: 'America/New_York',
		isActive: true,
		storeHours: DAYS.map((day) => ({
			day,
			isOpen: day !== 'monday',
			slots: day === 'monday' ? [] : [{ start: '17:00', end: '22:00' }],
		})),
		specialHours: null,
		...over,
	}
}

const dinner = {
	id: 'srv_dinner',
	name: 'Dinner',
	daysMask: 0b1111111,
	firstSeatingMin: 17 * 60,
	lastSeatingMin: 21 * 60,
}

const base = { dayStartMin: 240, today: '2026-06-01', specialDays: [] }

describe('validateLocationHoursSetup', () => {
	it('flags a service on a closed weekday and outside the weekly hours', () => {
		const { issues } = validateLocationHoursSetup({
			...base,
			hours: hours(),
			services: [
				dinner,
				{
					...dinner,
					id: 'late',
					name: 'Late',
					firstSeatingMin: 21 * 60,
					lastSeatingMin: 23 * 60,
					daysMask: 0b0000100,
				},
			],
		})
		expect(
			issues.filter((i) => i.code === 'service_on_closed_weekday'),
		).toEqual([
			expect.objectContaining({
				entityId: 'srv_dinner',
				details: { serviceName: 'Dinner', day: 'monday' },
			}),
		])
		expect(issues).toContainEqual(
			expect.objectContaining({
				code: 'service_outside_location_hours',
				details: { serviceName: 'Late', day: 'wednesday' },
			}),
		)
	})

	it('flags an inactive location and a location with no hours', () => {
		const inactive = validateLocationHoursSetup({
			...base,
			hours: hours({ isActive: false }),
			services: [],
		})
		expect(inactive.issues.map((i) => i.code)).toContain('location_inactive')
		const none = validateLocationHoursSetup({
			...base,
			hours: hours({ storeHours: null }),
			services: [dinner],
		})
		expect(none.issues).toEqual([
			expect.objectContaining({
				code: 'location_no_hours',
				severity: 'warning',
				details: { hint: 'Add opening hours in Location settings' },
			}),
		])
	})

	it('adds an info note for a closed special day on dates the location is already closed', () => {
		const h = hours({
			specialHours: [{ id: 's', date: '2026-12-25', isOpen: false, slots: [] }],
		})
		const { infos } = validateLocationHoursSetup({
			...base,
			hours: h,
			services: [],
			specialDays: [
				{
					id: 'sd1',
					kind: 'closed',
					fromDate: '2026-12-25',
					toDate: '2026-12-25',
				},
				{
					id: 'sd2',
					kind: 'closed',
					fromDate: '2026-12-24',
					toDate: '2026-12-25',
				},
				{
					id: 'sd3',
					kind: 'online_closed',
					fromDate: '2026-12-25',
					toDate: '2026-12-25',
				},
			],
		})
		expect(infos.map((i) => i.entityId)).toEqual(['sd1'])
		expect(infos[0]).toMatchObject({
			code: 'special_day_redundant_closed',
			severity: 'info',
		})
	})
})
