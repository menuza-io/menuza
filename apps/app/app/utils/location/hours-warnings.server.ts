import {
	hoursFingerprint,
	lintHours,
	type HoursWarning,
} from '@repo/common/hours-lint'
import {
	type SpecialHour,
	type WeeklySchedule,
} from '@repo/common/location-types'
import { parseSpecialHours, parseWeeklyHours } from '@repo/opening-hours'

/**
 * The hours warnings of a saved location (#275): the same `lintHours` the
 * editor runs, read from the stored JSON, with the operator's "dismiss until the
 * hours change" applied. The launch checklist and Needs attention call this, so
 * all three agree.
 */
export type HoursWarningsLocation = {
	storeHours: string | null
	onlineHours: string | null
	specialHours: string | null
	timezone?: string | null
	prepTime?: number | null
	hoursWarningsDismissedFor?: string | null
}

export function savedHoursWarnings(
	location: HoursWarningsLocation,
	now: Date = new Date(),
): {
	/** Every warning, dismissed or not. */
	all: HoursWarning[]
	/** What is shown: nothing while the dismissal matches the saved hours. */
	visible: HoursWarning[]
	fingerprint: string
	dismissed: boolean
} {
	const store = parseWeeklyHours(location.storeHours)
	const online = parseWeeklyHours(location.onlineHours)
	const special = parseSpecialHours(location.specialHours)
	const input = {
		storeHours: store.value as WeeklySchedule | null,
		onlineHours: online.value as WeeklySchedule | null,
		specialHours: (special.value ?? null) as SpecialHour[] | null,
	}
	const fingerprint = hoursFingerprint(input)
	// Online hours that equal the store hours follow them: nothing to compare.
	const syncOnline =
		input.onlineHours === null ||
		JSON.stringify(input.onlineHours) === JSON.stringify(input.storeHours)
	const all = lintHours(input, {
		timeZone: location.timezone || 'UTC',
		now,
		syncOnline,
		prepMinutes: location.prepTime ?? null,
	})
	const dismissed = location.hoursWarningsDismissedFor === fingerprint
	return { all, visible: dismissed ? [] : all, fingerprint, dismissed }
}
