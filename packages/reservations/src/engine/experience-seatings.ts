import { dayOfWeek } from '@repo/zoned-time'

/**
 * Pure helpers for Experience schedules (`architecture.md` 4.1 and 6.3): which
 * seatings a schedule offers on a date and how many covers are left under the
 * per-seating and per-day caps. No I/O: the caller supplies the booked covers.
 */

/** The seating count a single schedule may generate (explicit or stepped). */
export const MAX_EXPERIENCE_SEATINGS_PER_SCHEDULE = 48

export type ExperienceScheduleInput = {
	id: string
	fromDate: string
	toDate: string
	/** Bit 0 = Monday ... bit 6 = Sunday, like service templates. */
	daysMask: number
	seatingMins: readonly number[] | null
	startMin: number | null
	endMin: number | null
	intervalMin: number | null
	turnMin: number
	coversCapPerSeating: number | null
	coversCapPerDay: number | null
	areaIds: readonly string[] | null
	serviceId: string | null
}

/** Explicit seatings win; otherwise `start..end` stepped by `interval` (end inclusive). Sorted, unique. */
export function scheduleSeatingMins(
	schedule: Pick<
		ExperienceScheduleInput,
		'seatingMins' | 'startMin' | 'endMin' | 'intervalMin'
	>,
): number[] {
	const out = new Set<number>()
	if (schedule.seatingMins && schedule.seatingMins.length > 0) {
		for (const m of schedule.seatingMins) out.add(m)
	} else if (
		schedule.startMin !== null &&
		schedule.endMin !== null &&
		schedule.intervalMin !== null &&
		schedule.intervalMin > 0
	) {
		for (
			let m = schedule.startMin;
			m <= schedule.endMin && out.size < MAX_EXPERIENCE_SEATINGS_PER_SCHEDULE;
			m += schedule.intervalMin
		) {
			out.add(m)
		}
	}
	return [...out].sort((a, b) => a - b)
}

export function scheduleAppliesOn(
	schedule: Pick<ExperienceScheduleInput, 'fromDate' | 'toDate' | 'daysMask'>,
	businessDate: string,
): boolean {
	if (businessDate < schedule.fromDate || businessDate > schedule.toDate) {
		return false
	}
	const mondayZero = (dayOfWeek(businessDate) + 6) % 7
	return (schedule.daysMask & (1 << mondayZero)) !== 0
}

export type ExperienceDaySeating = {
	scheduleId: string
	seatingMin: number
}

/**
 * Seatings of every schedule that applies on `businessDate`. A start minute
 * offered by two schedules belongs to the first one (the caller orders them).
 */
export function experienceSeatingsOn(
	schedules: readonly ExperienceScheduleInput[],
	businessDate: string,
): ExperienceDaySeating[] {
	const seen = new Set<number>()
	const out: ExperienceDaySeating[] = []
	for (const schedule of schedules) {
		if (!scheduleAppliesOn(schedule, businessDate)) continue
		for (const seatingMin of scheduleSeatingMins(schedule)) {
			if (seen.has(seatingMin)) continue
			seen.add(seatingMin)
			out.push({ scheduleId: schedule.id, seatingMin })
		}
	}
	return out.sort((a, b) => a.seatingMin - b.seatingMin)
}

/**
 * Covers still sellable at one seating: the tighter of the per-seating cap and
 * the per-day cap (summed over the schedule's seatings that day). `null` caps
 * do not bind; with neither cap the result is `Infinity`.
 */
export function experienceRemainingCovers(input: {
	schedule: Pick<
		ExperienceScheduleInput,
		'coversCapPerSeating' | 'coversCapPerDay' | 'seatingMins'
	> &
		Pick<ExperienceScheduleInput, 'startMin' | 'endMin' | 'intervalMin'>
	seatingMin: number
	/** Booked covers (live holds + capacity-status reservations) by seating start minute. */
	bookedBySeating: ReadonlyMap<number, number>
}): number {
	const { schedule, seatingMin, bookedBySeating } = input
	let remaining = Number.POSITIVE_INFINITY
	if (schedule.coversCapPerSeating !== null) {
		remaining = Math.min(
			remaining,
			schedule.coversCapPerSeating - (bookedBySeating.get(seatingMin) ?? 0),
		)
	}
	if (schedule.coversCapPerDay !== null) {
		let day = 0
		for (const m of scheduleSeatingMins(schedule)) {
			day += bookedBySeating.get(m) ?? 0
		}
		remaining = Math.min(remaining, schedule.coversCapPerDay - day)
	}
	return remaining
}
