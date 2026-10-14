import { eq } from 'drizzle-orm'
import {
	parseDate,
	STAFFING_PERMISSIONS as P,
	type StaffingPermission,
	zonedLocalToUtc,
} from '@repo/staffing'
import {
	staffJobs,
	staffMembers,
	staffPositions,
	timeEntries,
} from '@repo/tenant-db'
import {
	type ClockHarness,
	type SeedStaff,
	ORG_A,
} from './timeclock-harness.ts'

export {
	createClockHarness,
	LOC_1,
	LOC_2,
	LOC_3,
	ORG_A,
	ORG_B,
} from './timeclock-harness.ts'
export type { ClockHarness } from './timeclock-harness.ts'

/** Hours only: names and times, no wage. */
export const TS_VIEW: StaffingPermission[] = [P.READ_STAFF, P.READ_TIMESHEET]
export const TS_EDIT: StaffingPermission[] = [...TS_VIEW, P.UPDATE_TIMESHEET]
export const TS_APPROVE: StaffingPermission[] = [
	...TS_EDIT,
	P.APPROVE_TIMESHEET,
]
/** Everything a general manager holds for the time clock, wages included. */
export const TS_PAY: StaffingPermission[] = [
	...TS_APPROVE,
	P.READ_STAFF_PAY,
	P.READ_LABOR,
	P.READ_LABOR_POLICY,
	P.UPDATE_LABOR_POLICY,
]

export const CHI = 'America/Chicago'

/** The instant of `hhmm` on `date` in `tz`. */
export function at(date: string, hhmm: string, tz = CHI): number {
	const { year, month, day } = parseDate(date)
	const [h, m] = hhmm.split(':').map(Number) as [number, number]
	return zonedLocalToUtc(year, month, day, h, m, tz)
}

export type TimesheetFixture = {
	h: ClockHarness
	/** Writes a labor policy patch for a scope through the real route. */
	setPolicy: (
		scopeId: string,
		patch: Record<string, unknown>,
		orgId?: string,
	) => Promise<void>
	staff: (
		input?: SeedStaff,
		orgId?: string,
	) => Promise<{ staffId: string; positionIds: string[] }>
	/** Creates a card through the real route with the pay-capable token. */
	card: (
		input: Record<string, unknown>,
		options?: {
			grants?: readonly string[]
			scopeIds?: readonly string[] | null
		},
	) => Promise<{ status: number; body: any }>
	/** `GET /timesheets/...` with a token. */
	get: (
		path: string,
		options?: {
			grants?: readonly string[]
			scopeIds?: readonly string[] | null
			orgId?: string
			token?: string | null
			impersonated?: boolean
		},
	) => ReturnType<ClockHarness['operator']>
	send: (
		method: string,
		path: string,
		body?: unknown,
		options?: {
			grants?: readonly string[]
			scopeIds?: readonly string[] | null
			orgId?: string
			token?: string | null
			impersonated?: boolean
		},
	) => ReturnType<ClockHarness['operator']>
}

export function timesheetFixture(h: ClockHarness): TimesheetFixture {
	const send: TimesheetFixture['send'] = (method, path, body, options = {}) =>
		h.operator(method, path, {
			grants: options.grants ?? TS_PAY,
			scopeIds: options.scopeIds,
			orgId: options.orgId,
			token: options.token,
			impersonated: options.impersonated,
			body,
		})
	return {
		h,
		send,
		get: (path, options) => send('GET', path, undefined, options),
		async setPolicy(scopeId, patch, orgId = ORG_A) {
			const current = await h.operator('GET', `/policies/${scopeId}`, {
				orgId,
				grants: TS_PAY,
			})
			const existing = current.body.source === 'scope'
			const response = await h.operator('PUT', `/policies/${scopeId}`, {
				orgId,
				grants: TS_PAY,
				body: existing
					? { expectedVersion: current.body.version, ...patch }
					: patch,
			})
			if (response.status !== 200) {
				throw new Error(`setPolicy failed: ${response.status} ${response.raw}`)
			}
		},
		async staff(input = {}, orgId = ORG_A) {
			const seeded = await h.seedStaff(orgId, {
				positions: [{ name: 'Cook', rateMinor: 2000 }],
				...input,
			})
			const db = await h.db(orgId)
			const jobs = await db
				.select({ positionId: staffJobs.positionId })
				.from(staffJobs)
				.where(eq(staffJobs.staffId, seeded.staffId))
			return {
				staffId: seeded.staffId,
				positionIds: [...new Set(jobs.map((j) => j.positionId))],
			}
		},
		card: (input, options) =>
			send('POST', '/timesheets/entries', input, options).then((r) => ({
				status: r.status,
				body: r.body,
			})),
	}
}

export async function entryRow(h: ClockHarness, id: string, orgId = ORG_A) {
	const db = await h.db(orgId)
	const [row] = await db
		.select()
		.from(timeEntries)
		.where(eq(timeEntries.id, id))
	return row
}

export async function staffName(
	h: ClockHarness,
	staffId: string,
	orgId = ORG_A,
) {
	const db = await h.db(orgId)
	const [row] = await db
		.select()
		.from(staffMembers)
		.where(eq(staffMembers.id, staffId))
	return row
}

export { staffPositions }
