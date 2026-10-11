import { z } from 'zod'
import {
	addDays,
	localDateSchema,
	localTimeSchema,
	minutesBetween,
	shiftInstants,
} from './time.ts'

const id = z.string().trim().min(1).max(64)

export const shiftInputSchema = z
	.object({
		locationId: id,
		staffId: id.nullable(),
		positionId: id.nullable(),
		localDate: localDateSchema,
		startTime: localTimeSchema,
		endTime: localTimeSchema,
		unpaidBreakMinutes: z.number().int().min(0).max(480).default(0),
		note: z.string().trim().max(500).default(''),
	})
	.refine((shift) => shift.startTime !== shift.endTime, {
		message: 'zero_length',
		path: ['endTime'],
	})
export type ShiftInput = z.infer<typeof shiftInputSchema>

type Interval = {
	id: string
	staffId: string | null
	startAt: Date
	endAt: Date
}

/** IDs of assigned shifts that overlap another shift for the same person. */
export function findOverlappingShiftIds(shifts: readonly Interval[]) {
	const overlapping = new Set<string>()
	const byStaff = new Map<string, Interval[]>()
	for (const shift of shifts) {
		if (!shift.staffId) continue
		const list = byStaff.get(shift.staffId) ?? []
		list.push(shift)
		byStaff.set(shift.staffId, list)
	}
	for (const list of byStaff.values()) {
		list.sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
		let latest: Interval | null = null
		for (const shift of list) {
			if (latest && shift.startAt.getTime() < latest.endAt.getTime()) {
				overlapping.add(shift.id)
				overlapping.add(latest.id)
			}
			if (!latest || shift.endAt.getTime() > latest.endAt.getTime()) {
				latest = shift
			}
		}
	}
	return overlapping
}

/** Paid minutes for a shift or time entry after its unpaid break. */
export function paidMinutes(entry: {
	startAt: Date
	endAt: Date
	unpaidBreakMinutes: number
}) {
	return Math.max(
		0,
		minutesBetween(entry.startAt, entry.endAt) - entry.unpaidBreakMinutes,
	)
}

/**
 * Re-anchors a shift's wall-clock times onto another week. Instants are
 * recomputed in the location's zone so copies across DST keep local times.
 */
export function copyShiftToWeek(
	shift: {
		localDate: string
		startTime: string
		endTime: string
		timeZone: string
	},
	weekOffsetDays: number,
) {
	const localDate = addDays(shift.localDate, weekOffsetDays)
	return {
		localDate,
		...shiftInstants({ ...shift, localDate }),
	}
}

export type DaySummary = { minutes: number; headcount: number }

/** Paid minutes per person per day, and distinct people per day. */
export function summarizeSchedule(
	shifts: readonly {
		staffId: string | null
		localDate: string
		startAt: Date
		endAt: Date
		unpaidBreakMinutes: number
	}[],
) {
	const byStaff = new Map<string, Map<string, number>>()
	const peopleByDay = new Map<string, Set<string>>()
	const minutesByDay = new Map<string, number>()
	for (const shift of shifts) {
		const minutes = paidMinutes(shift)
		minutesByDay.set(
			shift.localDate,
			(minutesByDay.get(shift.localDate) ?? 0) + minutes,
		)
		if (!shift.staffId) continue
		const days = byStaff.get(shift.staffId) ?? new Map<string, number>()
		days.set(shift.localDate, (days.get(shift.localDate) ?? 0) + minutes)
		byStaff.set(shift.staffId, days)
		const people = peopleByDay.get(shift.localDate) ?? new Set<string>()
		people.add(shift.staffId)
		peopleByDay.set(shift.localDate, people)
	}
	const days = new Map<string, DaySummary>()
	for (const [date, minutes] of minutesByDay) {
		days.set(date, { minutes, headcount: peopleByDay.get(date)?.size ?? 0 })
	}
	const staffTotals = new Map<string, number>()
	for (const [staffId, perDay] of byStaff) {
		staffTotals.set(
			staffId,
			[...perDay.values()].reduce((sum, value) => sum + value, 0),
		)
	}
	return { byStaff, staffTotals, days }
}
