import { eq } from 'drizzle-orm'
import {
	STAFFING_PERMISSIONS as P,
	type StaffingPermission,
} from '@repo/staffing'
import { staffJobs } from '@repo/tenant-db'
import { mintStaffToken } from './staff-harness.ts'
import {
	createClockHarness,
	LOC_1,
	LOC_2,
	LOC_3,
	ORG_A,
	ORG_B,
	type ClockHarness,
	type HttpResult,
} from './timeclock-harness.ts'
import { at, CHI, timesheetFixture } from './timesheet-harness.ts'

export { at, CHI, createClockHarness, LOC_1, LOC_2, LOC_3, ORG_A, ORG_B }
export type { ClockHarness, HttpResult }

/** The aggregate labor view: no individual wages, no tips. */
export const LAB_VIEW: StaffingPermission[] = [P.READ_STAFF, P.READ_LABOR]
/** A manager who can enter daily sales and read the labor view. */
export const LAB_SALES: StaffingPermission[] = [
	...LAB_VIEW,
	P.READ_TIMESHEET,
	P.UPDATE_TIMESHEET,
]
/** Everything a general manager holds for labor, wages and settings included. */
export const LAB_PAY: StaffingPermission[] = [
	...LAB_SALES,
	P.READ_STAFF_PAY,
	P.READ_LABOR_POLICY,
	P.UPDATE_LABOR_POLICY,
]

export type LaborOptions = {
	grants?: readonly string[]
	scopeIds?: readonly string[] | null
	orgId?: string
	token?: string | null
	impersonated?: boolean
	scope?: string
}

export type LaborFixture = {
	h: ClockHarness
	send: (
		method: string,
		path: string,
		body?: unknown,
		options?: LaborOptions,
	) => Promise<HttpResult>
	get: (path: string, options?: LaborOptions) => Promise<HttpResult>
	/** Seeds a person; every job is tip-eligible when `tipEligible` is set. */
	staff: (input?: {
		firstName?: string
		lastName?: string
		rateMinor?: number
		currency?: string
		tipEligible?: boolean
		scopeIds?: string[]
	}) => Promise<{ staffId: string; positionId: string }>
	/** Creates a card through the real timesheet route. */
	card: (input: Record<string, unknown>) => Promise<HttpResult>
	setPolicy: (scopeId: string, patch: Record<string, unknown>) => Promise<void>
}

export function laborFixture(h: ClockHarness): LaborFixture {
	const t = timesheetFixture(h)
	const send: LaborFixture['send'] = async (
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
					scope: options.scope ?? 'labor',
					grants: options.grants ?? LAB_PAY,
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
		const response = await h.app.request(`/operator/labor${path}`, {
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
		async staff(input = {}) {
			const seeded = await h.seedStaff(ORG_A, {
				firstName: input.firstName,
				lastName: input.lastName,
				scopeIds: input.scopeIds,
				positions: [
					{
						name: 'Cook',
						rateMinor: input.rateMinor ?? 2000,
						currency: input.currency ?? 'USD',
					},
				],
			})
			const db = await h.db(ORG_A)
			const [job] = await db
				.select()
				.from(staffJobs)
				.where(eq(staffJobs.staffId, seeded.staffId))
			if (input.tipEligible) {
				// Pay rows are append-only: close the seeded one and open a tip-eligible
				// successor for the same position, as a manager's edit would.
				await db
					.update(staffJobs)
					.set({ effectiveTo: '2020-06-30' })
					.where(eq(staffJobs.id, job!.id))
				await db.insert(staffJobs).values({
					staffId: job!.staffId,
					scopeId: job!.scopeId,
					positionId: job!.positionId,
					payType: job!.payType,
					rateMinor: job!.rateMinor,
					currency: job!.currency,
					isPrimary: true,
					tipEligible: true,
					effectiveFrom: '2020-07-01',
				})
			}
			return { staffId: seeded.staffId, positionId: job!.positionId }
		},
		card: (input) =>
			t.card(input).then((r) => ({ ...r, raw: '', headers: new Headers() })),
		setPolicy: (scopeId, patch) => t.setPolicy(scopeId, patch),
	}
}
