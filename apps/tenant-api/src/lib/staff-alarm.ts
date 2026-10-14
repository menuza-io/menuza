/**
 * Sub-hourly timing for the staff tick on the Durable Object runtime.
 *
 * The hourly cron is the only scheduled driver there is (no cron slot to spare),
 * so on its own a reminder or an automatic clock-out could lag an hour. Each
 * organization's Durable Object can wake itself with a storage alarm instead:
 * SQLite-backed Durable Objects support `setAlarm`, and `alarm()` runs in the
 * same object, next to the data.
 *
 * Arming is driven by activity, never by a timer that runs forever:
 * - a request that shows staffing is in use (a kiosk call, a staffing operator
 *   call, the hourly tick itself) arms an alarm if none is pending;
 * - the alarm runs the tick and arms the next one only while the tick reports
 *   something to watch (an open entry, a queued message, a shift soon). An
 *   organization with nothing going on goes quiet and costs nothing, and the
 *   hourly cron or the next kiosk call wakes it again.
 *
 * This file holds the logic with a narrow storage interface so it can be tested
 * without a Durable Object runtime; `workers/tenant-org.ts` is thin glue.
 */

export const STAFF_ALARM_INTERVAL_MS = 5 * 60 * 1000
export const STAFF_ALARM_ORG_KEY = 'staffTickOrgId'
export const STAFF_ALARM_FAILURES_KEY = 'staffTickFailures'
/** After this many failed alarms in a row the alarm stops re-arming itself. */
export const STAFF_ALARM_MAX_FAILURES = 6

export type AlarmStorage = {
	getAlarm(): Promise<number | null>
	setAlarm(scheduledTime: number): Promise<void>
	get<T = unknown>(key: string): Promise<T | undefined>
	put<T>(key: string, value: T): Promise<void>
	delete(key: string): Promise<boolean>
}

/** Requests that show an organization is using the staff features. */
export function isStaffActivityPath(pathname: string): boolean {
	return (
		pathname.startsWith('/kiosk/') ||
		pathname === '/operator/staff' ||
		pathname.startsWith('/operator/staff/') ||
		pathname === '/operator/timeclock' ||
		pathname.startsWith('/operator/timeclock/') ||
		pathname === '/operator/schedule' ||
		pathname.startsWith('/operator/schedule/') ||
		pathname === '/operator/labor' ||
		pathname.startsWith('/operator/labor/') ||
		pathname === '/operator/hiring' ||
		pathname.startsWith('/operator/hiring/') ||
		pathname.startsWith('/careers/') ||
		pathname === '/api/staff/tick'
	)
}

/**
 * Arms the next alarm unless one is already pending. Never moves an existing
 * alarm, so a busy kiosk cannot push the tick back indefinitely.
 */
export async function armStaffAlarm(
	storage: AlarmStorage,
	orgId: string,
	now: number,
	intervalMs = STAFF_ALARM_INTERVAL_MS,
): Promise<'armed' | 'already_armed'> {
	const existing = await storage.getAlarm()
	if (existing !== null && existing > now - intervalMs) return 'already_armed'
	if ((await storage.get<string>(STAFF_ALARM_ORG_KEY)) !== orgId) {
		await storage.put(STAFF_ALARM_ORG_KEY, orgId)
	}
	await storage.setAlarm(now + intervalMs)
	return 'armed'
}

export type AlarmOutcome =
	| { status: 'no_org' }
	| { status: 'ran'; rearmed: boolean }
	| { status: 'failed'; rearmed: boolean }

/**
 * What a Durable Object does when its alarm fires. A tick that throws does not
 * propagate: the platform would retry the alarm on its own schedule, so the
 * object re-arms (a bounded number of times) at the normal interval instead.
 */
export async function handleStaffAlarm(options: {
	storage: AlarmStorage
	now: number
	runTick: (orgId: string) => Promise<{ needsFollowUp: boolean }>
	intervalMs?: number
}): Promise<AlarmOutcome> {
	const { storage, now } = options
	const intervalMs = options.intervalMs ?? STAFF_ALARM_INTERVAL_MS
	const orgId = await storage.get<string>(STAFF_ALARM_ORG_KEY)
	if (!orgId) return { status: 'no_org' }

	try {
		const result = await options.runTick(orgId)
		await storage.delete(STAFF_ALARM_FAILURES_KEY)
		if (result.needsFollowUp) {
			await storage.setAlarm(now + intervalMs)
			return { status: 'ran', rearmed: true }
		}
		return { status: 'ran', rearmed: false }
	} catch (error) {
		console.error(
			'Staff alarm tick failed',
			error instanceof Error ? error.name : 'unknown',
		)
		const failures =
			((await storage.get<number>(STAFF_ALARM_FAILURES_KEY)) ?? 0) + 1
		await storage.put(STAFF_ALARM_FAILURES_KEY, failures)
		if (failures >= STAFF_ALARM_MAX_FAILURES) {
			return { status: 'failed', rearmed: false }
		}
		await storage.setAlarm(now + intervalMs)
		return { status: 'failed', rearmed: true }
	}
}
