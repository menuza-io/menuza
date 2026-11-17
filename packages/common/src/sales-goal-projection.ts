/**
 * Monthly sales goal progress from a daily run rate (#377). Pure math.
 */

/** Minimum elapsed fraction of month (day 3) before projecting. */
export const PROJECTION_MIN_MONTH_FRACTION = 3 / 31

export type SalesGoalProjectionInput = {
	/** Calendar day of month, 1–31. */
	dayOfMonth: number
	daysInMonth: number
	actualMinor: number
	goalMinor: number
}

export type SalesGoalProjection =
	| { kind: 'too_early' }
	| {
			kind: 'on_track'
			projectedMinor: number
			percentOfGoal: number
			runRateMinor: number
	  }

export function projectMonthlySales(
	input: SalesGoalProjectionInput,
): SalesGoalProjection {
	const { dayOfMonth, daysInMonth, actualMinor, goalMinor } = input
	if (goalMinor <= 0) return { kind: 'too_early' }
	const elapsed = dayOfMonth / daysInMonth
	if (elapsed < PROJECTION_MIN_MONTH_FRACTION) return { kind: 'too_early' }
	const runRate = actualMinor / dayOfMonth
	const projectedMinor = Math.round(runRate * daysInMonth)
	const percentOfGoal = projectedMinor / goalMinor
	return {
		kind: 'on_track',
		projectedMinor,
		percentOfGoal,
		runRateMinor: Math.round(runRate),
	}
}
