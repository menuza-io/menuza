/**
 * Operator-channel pacing check shared by the booking write path and the
 * operator availability grid, so a slot flagged before submit is the slot the
 * write rejects (`pacing_exceeded` / `pacing_parties_exceeded`).
 */

export const ACTIVE_OCCUPANCY_STATUSES: ReadonlySet<string> = new Set([
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
	'arrived',
	'seated',
])

export type OperatorPacingRule = {
	serviceId: string
	fromMin: number | null
	toMin: number | null
	bucketMin: number | null
	maxCovers: number | null
	maxParties: number | null
}

export type OperatorPacingBreachCode =
	'pacing_exceeded' | 'pacing_parties_exceeded'

export function findOperatorPacingBreaches(input: {
	rules: readonly OperatorPacingRule[]
	serviceId: string | null
	localStartMin: number
	partySize: number
	activeReservations: ReadonlyArray<{
		localStartMin: number
		partySize: number
	}>
}): OperatorPacingBreachCode[] {
	const breaches: OperatorPacingBreachCode[] = []
	for (const pr of input.rules) {
		if (input.serviceId && pr.serviceId !== input.serviceId) continue
		if (pr.fromMin !== null && input.localStartMin < pr.fromMin) continue
		if (pr.toMin !== null && input.localStartMin >= pr.toMin) continue
		const bucketMin = pr.bucketMin || 15
		const bucketStart = Math.floor(input.localStartMin / bucketMin) * bucketMin
		const bucketEnd = bucketStart + bucketMin
		const inBucket = input.activeReservations.filter(
			(r) => r.localStartMin >= bucketStart && r.localStartMin < bucketEnd,
		)
		const bucketCovers = inBucket.reduce((s, r) => s + r.partySize, 0)
		if (
			pr.maxCovers !== null &&
			bucketCovers + input.partySize > pr.maxCovers
		) {
			breaches.push('pacing_exceeded')
		}
		if (pr.maxParties !== null && inBucket.length + 1 > pr.maxParties) {
			breaches.push('pacing_parties_exceeded')
		}
	}
	return breaches
}
