import { eq } from 'drizzle-orm'
import {
	STAFFING_PERMISSIONS as P,
	type StaffingPermission,
} from '@repo/staffing'
import { staffJobs, staffMembers, staffPositions } from '@repo/tenant-db'
import {
	createClockHarness,
	LOC_1,
	LOC_2,
	LOC_3,
	ORG_A,
	ORG_B,
	type ClockHarness,
	type HttpResult,
	type SeedStaff,
} from './timeclock-harness.ts'
import { mintStaffToken } from './staff-harness.ts'
import { at, CHI } from './timesheet-harness.ts'

export { at, CHI, createClockHarness, LOC_1, LOC_2, LOC_3, ORG_A, ORG_B }
export type { ClockHarness, HttpResult }

/** Names and shifts, no wage. */
export const SCH_VIEW: StaffingPermission[] = [P.READ_STAFF, P.READ_SCHEDULE]
export const SCH_EDIT: StaffingPermission[] = [...SCH_VIEW, P.UPDATE_SCHEDULE]
/** Everything a general manager holds for the schedule, wages included. */
export const SCH_PAY: StaffingPermission[] = [
	...SCH_EDIT,
	P.READ_STAFF_PAY,
	P.READ_LABOR,
	P.READ_LABOR_POLICY,
	P.UPDATE_LABOR_POLICY,
	P.READ_TIMESHEET,
]
/** Labor aggregates without individual wages. */
export const SCH_LABOR: StaffingPermission[] = [...SCH_EDIT, P.READ_LABOR]

export const RIYADH = 'Asia/Riyadh'

export type ScheduleOptions = {
	grants?: readonly string[]
	scopeIds?: readonly string[] | null
	orgId?: string
	token?: string | null
	impersonated?: boolean
	scope?: string
}

export type ScheduleFixture = {
	h: ClockHarness
	send: (
		method: string,
		path: string,
		body?: unknown,
		options?: ScheduleOptions,
	) => Promise<HttpResult>
	get: (path: string, options?: ScheduleOptions) => Promise<HttpResult>
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
	/** Creates one shift through the real route and returns its view. */
	shift: (
		input: {
			scopeId?: string
			staffId?: string | null
			positionId?: string | null
			date: string
			start?: string
			end?: string
			unpaidBreakMinutes?: number
			notes?: string
		},
		options?: ScheduleOptions,
	) => Promise<any>
	publish: (
		scopeId: string,
		weekStart: string,
		options?: ScheduleOptions & { notifyMode?: string },
	) => Promise<HttpResult>
}

export function scheduleFixture(h: ClockHarness): ScheduleFixture {
	const send: ScheduleFixture['send'] = async (
		method,
		path,
		body,
		options = {},
	) => {
		const headers: Record<string, string> = {}
		if (options.token !== null) {
			const token =
				options.token ??
				(await mintStaffToken({
					orgId: options.orgId ?? ORG_A,
					scope: options.scope ?? 'schedule',
					grants: options.grants ?? SCH_PAY,
					scopeIds: options.scopeIds === undefined ? null : options.scopeIds,
					impersonated: options.impersonated,
				}))
			headers.Authorization = `Bearer ${token}`
		}
		let payload: string | undefined
		if (body !== undefined) {
			payload = JSON.stringify(body)
			headers['content-type'] = 'application/json'
		}
		const response = await h.app.request(`/operator/schedule${path}`, {
			method,
			headers,
			body: payload,
		})
		const raw = await response.text()
		let parsed: unknown = null
		try {
			parsed = raw ? JSON.parse(raw) : null
		} catch {
			parsed = null
		}
		return {
			status: response.status,
			body: parsed,
			raw,
			headers: response.headers,
		}
	}

	return {
		h,
		send,
		get: (path, options) => send('GET', path, undefined, options),
		async setPolicy(scopeId, patch, orgId = ORG_A) {
			const grants = SCH_PAY
			const current = await h.operator('GET', `/policies/${scopeId}`, {
				orgId,
				grants,
			})
			const existing = current.body.source === 'scope'
			const response = await h.operator('PUT', `/policies/${scopeId}`, {
				orgId,
				grants,
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
		async shift(input, options) {
			const response = await send(
				'POST',
				'/shifts',
				{
					scopeId: input.scopeId ?? LOC_1,
					staffId: input.staffId ?? null,
					positionId: input.positionId ?? null,
					dates: [input.date],
					startTime: input.start ?? '09:00',
					endTime: input.end ?? '17:00',
					unpaidBreakMinutes: input.unpaidBreakMinutes ?? 0,
					notes: input.notes ?? null,
				},
				options,
			)
			if (response.status !== 201) {
				throw new Error(`shift failed: ${response.status} ${response.raw}`)
			}
			return response.body.shifts[0]
		},
		publish(scopeId, weekStart, options = {}) {
			return send(
				'POST',
				'/publish',
				{
					scopeId,
					weekStart,
					notifyMode: options.notifyMode ?? 'changed',
				},
				options,
			)
		},
	}
}

export async function memberRow(h: ClockHarness, id: string, orgId = ORG_A) {
	const db = await h.db(orgId)
	const [row] = await db
		.select()
		.from(staffMembers)
		.where(eq(staffMembers.id, id))
	return row
}

export { staffPositions }
