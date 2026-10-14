import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import {
	STAFFING_PERMISSIONS as P,
	type StaffingPermission,
} from '@repo/staffing'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	staffPositions,
} from '@repo/tenant-db'
import { createTenantApiApp } from '../src/app.ts'
import { kioskDeps } from '../src/routes/kiosk.ts'
import { defaultPunchDeps } from '../src/services/punch-service.ts'
import { pinLookupFor } from '../src/services/kiosk-pin-service.ts'
import { mintStaffToken, ORG_A, ORG_B, stubStaffEnv } from './staff-harness.ts'

/**
 * Harness for the time clock suites. It mounts the real tenant-api app (so
 * route mounting, CORS and body limits are exercised), provisions fresh org
 * databases, and offers helpers to seed people, pair a kiosk through the real
 * operator and public routes, and punch with a controllable clock.
 */

export { ORG_A, ORG_B }

export const CLOCK_ADMIN_GRANTS: StaffingPermission[] = [
	P.READ_STAFF,
	P.READ_LABOR_POLICY,
	P.UPDATE_LABOR_POLICY,
]
export const CLOCK_READ_GRANTS: StaffingPermission[] = [
	P.READ_STAFF,
	P.READ_LABOR_POLICY,
]

export const LOC_1 = 'loc-1'
export const LOC_2 = 'loc-2'
export const LOC_3 = 'loc-3'

export type Clock = { now: number }

export type ClockHarness = {
	directory: string
	app: ReturnType<typeof createTenantApiApp>
	clock: Clock
	setClock: (ms: number) => void
	advance: (ms: number) => void
	operator: (
		method: string,
		path: string,
		options?: {
			token?: string | null
			orgId?: string
			grants?: readonly string[]
			scopeIds?: readonly string[] | null
			body?: unknown
			headers?: Record<string, string>
			impersonated?: boolean
		},
	) => Promise<HttpResult>
	kiosk: (
		method: string,
		path: string,
		options?: {
			secret?: string | null
			body?: unknown
			rawBody?: string
			headers?: Record<string, string>
		},
	) => Promise<HttpResult>
	seedStaff: (
		orgId: string,
		input: SeedStaff,
	) => Promise<{ staffId: string; assignmentIds: string[]; pin: string }>
	pair: (
		orgId: string,
		scopeId: string,
		options?: { mode?: 'pin' | 'pick_name'; name?: string },
	) => Promise<{ secret: string; deviceId: string; config: any }>
	punch: (
		secret: string,
		input: {
			pin: string
			kind: 'clock_in' | 'break_start' | 'break_end' | 'clock_out'
			id?: string
			staffId?: string
			positionId?: string
			breakKind?: 'meal' | 'rest'
			offline?: boolean
			clientAt?: number
			deviceNowAt?: number
			cashTipsMinor?: number
		},
	) => Promise<HttpResult>
	db: (orgId: string) => ReturnType<typeof getTenantDb>
	cleanup: () => Promise<void>
}

export type HttpResult = {
	status: number
	body: any
	raw: string
	headers: Headers
}

export type SeedStaff = {
	firstName?: string
	lastName?: string
	scopeIds?: string[]
	pin?: string
	status?: 'active' | 'terminated' | 'on_leave'
	/** Position names; each gets a job at every scope. */
	positions?: Array<{
		name: string
		rateMinor?: number | null
		currency?: string
		nameAr?: string
		payType?: 'hourly' | 'salary'
		overtimeExempt?: boolean
	}>
	effectiveFrom?: string
	canWaiveBreaks?: boolean
}

let seedCounter = 0

async function readResult(response: Response): Promise<HttpResult> {
	const raw = await response.text()
	let body: unknown = null
	try {
		body = raw ? JSON.parse(raw) : null
	} catch {
		body = null
	}
	return { status: response.status, body, raw, headers: response.headers }
}

export async function createClockHarness(
	orgIds: string[] = [ORG_A, ORG_B],
	region: 'us' | 'ksa' = 'us',
	start = Date.UTC(2026, 2, 2, 15, 0, 0),
): Promise<ClockHarness> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-routes-'))
	stubStaffEnv(directory, region)
	// An empty value means "on"; stubbing it keeps a switch flipped by one test
	// from leaking into the next through the env snapshot varlock keeps.
	vi.stubEnv('STAFFING_KIOSK_ENABLED', '')
	for (const id of orgIds) await provisionTenantDb(id)
	const app = createTenantApiApp()
	const clock: Clock = { now: start }
	const originalPunchDeps = kioskDeps.punch
	kioskDeps.punch = { ...defaultPunchDeps, now: () => clock.now }

	const harness: ClockHarness = {
		directory,
		app,
		clock,
		setClock: (ms) => {
			clock.now = ms
		},
		advance: (ms) => {
			clock.now += ms
		},
		async operator(method, requestPath, options = {}) {
			const headers: Record<string, string> = { ...options.headers }
			if (options.token !== null) {
				const token =
					options.token ??
					(await mintStaffToken({
						orgId: options.orgId ?? ORG_A,
						scope: 'timeclock',
						grants: options.grants ?? CLOCK_ADMIN_GRANTS,
						scopeIds: options.scopeIds === undefined ? null : options.scopeIds,
						impersonated: options.impersonated,
					}))
				headers.Authorization = `Bearer ${token}`
			}
			let body: string | undefined
			if (options.body !== undefined) body = JSON.stringify(options.body)
			if (body !== undefined) headers['content-type'] = 'application/json'
			const response = await app.request(
				`/operator/timeclock${requestPath === '/' ? '' : requestPath}`,
				{ method, headers, body },
			)
			return readResult(response)
		},
		async kiosk(method, requestPath, options = {}) {
			const headers: Record<string, string> = { ...options.headers }
			if (options.secret) headers.Authorization = `Bearer ${options.secret}`
			let body: string | undefined
			if (options.rawBody !== undefined) body = options.rawBody
			else if (options.body !== undefined) body = JSON.stringify(options.body)
			if (body !== undefined) headers['content-type'] = 'application/json'
			const response = await app.request(`/kiosk${requestPath}`, {
				method,
				headers,
				body,
			})
			return readResult(response)
		},
		async seedStaff(orgId, input) {
			const db = await getTenantDb(orgId)
			const scopeIds = input.scopeIds ?? [LOC_1]
			seedCounter += 1
			const pin = input.pin ?? String(2000 + ((seedCounter * 37) % 7000))
			const [member] = await db
				.insert(staffMembers)
				.values({
					firstName: input.firstName ?? `Staff${seedCounter}`,
					lastName: input.lastName ?? `Person${seedCounter}`,
					status: input.status ?? 'active',
					primaryScopeId: scopeIds[0] ?? null,
				})
				.returning()
			const assignmentIds: string[] = []
			for (const [index, scopeId] of scopeIds.entries()) {
				const [assignment] = await db
					.insert(staffScopeAssignments)
					.values({
						staffId: member!.id,
						scopeId,
						isPrimary: index === 0,
						pinLookup: pinLookupFor(orgId, scopeId, pin),
						pinSetAt: harness.clock.now,
						canWaiveBreaks: input.canWaiveBreaks ?? false,
					})
					.returning()
				assignmentIds.push(assignment!.id)
			}
			for (const [index, position] of (input.positions ?? []).entries()) {
				const [row] = await db
					.insert(staffPositions)
					.values({
						name: `${position.name}-${seedCounter}-${index}`,
						nameAr: position.nameAr,
					})
					.returning()
				for (const scopeId of scopeIds) {
					await db.insert(staffJobs).values({
						staffId: member!.id,
						scopeId,
						positionId: row!.id,
						payType: position.payType ?? 'hourly',
						rateMinor:
							position.rateMinor === undefined ? 1500 : position.rateMinor,
						currency: position.currency ?? 'USD',
						overtimeExempt: position.overtimeExempt ?? false,
						isPrimary: index === 0,
						effectiveFrom: input.effectiveFrom ?? '2020-01-01',
					})
				}
			}
			return { staffId: member!.id, assignmentIds, pin }
		},
		async pair(orgId, scopeId, options = {}) {
			const created = await harness.operator('POST', '/kiosk/pairing-codes', {
				orgId,
				body: {
					scopeId,
					deviceName: options.name ?? 'Front counter',
					identifyMode: options.mode ?? 'pin',
					timeZone: 'America/Chicago',
					scopeName: 'Downtown',
				},
			})
			if (created.status !== 201) {
				throw new Error(`pairing code failed: ${created.status} ${created.raw}`)
			}
			const paired = await harness.kiosk('POST', '/pair', {
				body: { code: created.body.code },
			})
			if (paired.status !== 201) {
				throw new Error(`pairing failed: ${paired.status} ${paired.raw}`)
			}
			return {
				secret: paired.body.deviceSecret as string,
				deviceId: paired.body.device.id as string,
				config: paired.body,
			}
		},
		punch(secret, input) {
			return harness.kiosk('POST', '/punch', {
				secret,
				body: {
					id: input.id ?? crypto.randomUUID(),
					kind: input.kind,
					pin: input.pin,
					clientAt: input.clientAt ?? clock.now,
					offline: input.offline ?? false,
					...(input.staffId ? { staffId: input.staffId } : {}),
					...(input.positionId ? { positionId: input.positionId } : {}),
					...(input.breakKind ? { breakKind: input.breakKind } : {}),
					...(input.deviceNowAt !== undefined
						? { deviceNowAt: input.deviceNowAt }
						: {}),
					...(input.cashTipsMinor !== undefined
						? { cashTipsMinor: input.cashTipsMinor }
						: {}),
				},
			})
		},
		db: (orgId) => getTenantDb(orgId),
		async cleanup() {
			kioskDeps.punch = originalPunchDeps
			for (const id of orgIds) {
				try {
					await destroyTenantDb(id)
				} catch {
					// already gone
				}
			}
			fs.rmSync(directory, { recursive: true, force: true })
			vi.unstubAllEnvs()
		},
	}
	return harness
}
