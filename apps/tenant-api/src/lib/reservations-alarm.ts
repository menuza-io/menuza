import { type OrgTickModule } from './org-alarm.ts'

/** Sub-hourly timing for reservations on the Durable Object runtime. */
export const RESERVATIONS_ALARM_INTERVAL_MS = 2 * 60 * 1000

/** Requests that show an organization is taking bookings or running a floor. */
export function isReservationsActivityPath(pathname: string): boolean {
	return (
		pathname === '/reservations' ||
		pathname.startsWith('/reservations/') ||
		pathname === '/operator/reservations' ||
		pathname.startsWith('/operator/reservations/') ||
		pathname === '/api/reservations/tick'
	)
}

export function createReservationsTickModule(
	run: (
		orgId: string,
		now: number,
	) => Promise<{
		needsFollowUp: boolean
		nextDueAt: number | null
	}>,
): OrgTickModule {
	return {
		name: 'reservations',
		tickPath: '/api/reservations/tick',
		intervalMs: RESERVATIONS_ALARM_INTERVAL_MS,
		isActivityPath: isReservationsActivityPath,
		run: async (orgId, now) => {
			const result = await run(orgId, now)
			return {
				needsFollowUp: result.needsFollowUp,
				nextDueAt: result.nextDueAt,
			}
		},
	}
}
