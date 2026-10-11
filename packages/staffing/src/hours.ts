/**
 * Weekly hours above the organization's threshold are a scheduling warning and
 * an export column, not an overtime pay calculation for any jurisdiction.
 */
export function splitWeeklyThreshold(
	totalMinutes: number,
	weeklyThresholdHours: number | null,
) {
	if (weeklyThresholdHours === null) {
		return { regularMinutes: totalMinutes, overThresholdMinutes: 0 }
	}
	const limit = Math.round(weeklyThresholdHours * 60)
	return {
		regularMinutes: Math.min(totalMinutes, limit),
		overThresholdMinutes: Math.max(0, totalMinutes - limit),
	}
}

export function minutesToHours(minutes: number) {
	return Math.round((minutes / 60) * 100) / 100
}
