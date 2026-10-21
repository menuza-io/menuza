import { addDays, daysBetween } from '@repo/zoned-time'
import {
	LOCATION_DAY_NAMES,
	buildEffectiveDay,
	hasConfiguredHours,
	weeklyDayHasHours,
	weeklyOpenAtMinute,
	type LocationHours,
} from '../rules/location-hours.ts'
import { type ConfigValidationIssue } from './validate.ts'

/**
 * Setup checks of the reservation services against the location hours
 * (the single source of "when are we open"). Plain codes; the App maps them
 * in `describeSetupIssues`.
 */
export const LOCATION_HOURS_ISSUE_CODES = {
	/** warning: a service seats guests on a weekday the location is closed. */
	serviceOnClosedWeekday: 'service_on_closed_weekday',
	/** warning: a service seating start falls outside the location's weekly hours. */
	serviceOutsideLocationHours: 'service_outside_location_hours',
	/** warning: the location is inactive, so no reservation is offered. */
	locationInactive: 'location_inactive',
	/** warning: the location has no opening hours configured at all. */
	locationNoHours: 'location_no_hours',
	/** info: a reservations `closed` special day on dates the location is already closed. */
	specialDayRedundantClosed: 'special_day_redundant_closed',
} as const

export type LocationHoursIssueInfo = {
	code: typeof LOCATION_HOURS_ISSUE_CODES.specialDayRedundantClosed
	severity: 'info'
	entityId: string
	details?: Record<string, unknown>
}

export type LocationHoursValidationInput = {
	hours: LocationHours
	dayStartMin: number
	/** Today's business date (`YYYY-MM-DD`): redundant-closure checks look forward from it. */
	today: string
	services: ReadonlyArray<{
		id: string
		name: string
		/** Bit 0 = Monday ... bit 6 = Sunday. */
		daysMask: number
		firstSeatingMin: number
		lastSeatingMin: number
		active?: boolean
	}>
	specialDays: ReadonlyArray<{
		id: string
		kind: string
		fromDate: string
		toDate: string
		name?: string | null
	}>
}

const REDUNDANT_LOOKAHEAD_DAYS = 400

export function validateLocationHoursSetup(
	input: LocationHoursValidationInput,
): { issues: ConfigValidationIssue[]; infos: LocationHoursIssueInfo[] } {
	const { hours } = input
	const issues: ConfigValidationIssue[] = []
	const infos: LocationHoursIssueInfo[] = []

	if (hours.isActive === false) {
		issues.push({
			code: LOCATION_HOURS_ISSUE_CODES.locationInactive,
			severity: 'warning',
		})
	}
	if (!hasConfiguredHours(hours)) {
		issues.push({
			code: LOCATION_HOURS_ISSUE_CODES.locationNoHours,
			severity: 'warning',
			details: { hint: 'Add opening hours in Location settings' },
		})
	} else {
		for (const service of input.services) {
			if (service.active === false) continue
			for (let monday = 0; monday < 7; monday++) {
				if ((service.daysMask & (1 << monday)) === 0) continue
				const weekday = (monday + 1) % 7 // Monday-first bit -> 0 = Sunday
				const day = LOCATION_DAY_NAMES[weekday]!
				if (!weeklyDayHasHours(hours, weekday)) {
					issues.push({
						code: LOCATION_HOURS_ISSUE_CODES.serviceOnClosedWeekday,
						severity: 'warning',
						entityId: service.id,
						serviceId: service.id,
						details: { serviceName: service.name, day },
					})
					continue
				}
				const outside = [service.firstSeatingMin, service.lastSeatingMin].some(
					(min) => !weeklyOpenAtMinute(hours, weekday, min),
				)
				if (outside) {
					issues.push({
						code: LOCATION_HOURS_ISSUE_CODES.serviceOutsideLocationHours,
						severity: 'warning',
						entityId: service.id,
						serviceId: service.id,
						details: { serviceName: service.name, day },
					})
				}
			}
		}
	}

	for (const sd of input.specialDays) {
		if (sd.kind !== 'closed') continue
		const from = sd.fromDate > input.today ? sd.fromDate : input.today
		const horizon = addDays(input.today, REDUNDANT_LOOKAHEAD_DAYS)
		const to = sd.toDate < horizon ? sd.toDate : horizon
		if (to < from) continue
		const span = daysBetween(from, to)
		let allClosed = true
		for (let i = 0; i <= span && allClosed; i++) {
			const day = buildEffectiveDay({
				businessDate: addDays(from, i),
				hours,
				dayStartMin: input.dayStartMin,
				reservation: { closed: false, onlineClosed: false },
			})
			if (day.source !== 'location_closed') allClosed = false
		}
		if (allClosed) {
			infos.push({
				code: LOCATION_HOURS_ISSUE_CODES.specialDayRedundantClosed,
				severity: 'info',
				entityId: sd.id,
				details: {
					fromDate: sd.fromDate,
					toDate: sd.toDate,
					name: sd.name ?? null,
				},
			})
		}
	}

	return { issues, infos }
}
