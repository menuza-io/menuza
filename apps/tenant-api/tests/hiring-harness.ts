import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import {
	hiringApplications,
	type HiringApplicationRow,
	type NewHiringApplicationRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	STAFFING_PERMISSIONS as P,
	type StaffingPermission,
} from '@repo/staffing'
import { careersRoutes } from '../src/routes/careers.ts'
import { hiringOperatorRoutes } from '../src/routes/hiring.ts'
import { mintStaffToken, ORG_A, ORG_B, stubStaffEnv } from './staff-harness.ts'

export { mintStaffToken, ORG_A, ORG_B, makeOrg } from './staff-harness.ts'
export type { TestOrg } from './staff-harness.ts'

/** Hiring manager grants: pipeline read and write, nothing about pay. */
export const HIRING_GRANTS: StaffingPermission[] = [
	P.READ_HIRING,
	P.UPDATE_HIRING,
]
export const HIRING_READ_GRANTS: StaffingPermission[] = [P.READ_HIRING]
export const HIRING_PAY_GRANTS: StaffingPermission[] = [
	P.READ_HIRING,
	P.UPDATE_HIRING,
	P.READ_STAFF_PAY,
	P.UPDATE_STAFF_PAY,
]

export const LOC_1 = 'loc-1'
export const LOC_2 = 'loc-2'

export type Reply = {
	status: number
	body: any
	raw: string
	headers: Headers
}

export type HiringHarness = {
	directory: string
	app: Hono
	db: (orgId?: string) => Promise<TenantDatabase>
	/** An authenticated `/operator/hiring` call (default: a hiring manager). */
	operator: (
		method: string,
		path: string,
		options?: {
			token?: string | null
			orgId?: string
			grants?: readonly string[]
			scopeIds?: readonly string[] | null
			impersonated?: boolean
			scope?: string
			body?: unknown
			rawBody?: string
		},
	) => Promise<Reply>
	/** A public `/careers` call as a browser would make it. */
	careers: (
		path: string,
		options?: {
			origin?: string | null
			body?: unknown
			rawBody?: string
			headers?: Record<string, string>
			method?: string
		},
	) => Promise<Reply>
	cleanup: () => Promise<void>
}

async function toReply(response: Response): Promise<Reply> {
	const raw = await response.text()
	let body: unknown = null
	try {
		body = raw ? JSON.parse(raw) : null
	} catch {
		body = null
	}
	return { status: response.status, body, raw, headers: response.headers }
}

export async function createHiringHarness(
	orgIds: string[] = [ORG_A, ORG_B],
	region: 'us' | 'ksa' = 'us',
): Promise<HiringHarness> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hiring-routes-'))
	stubStaffEnv(directory, region)
	for (const id of orgIds) await provisionTenantDb(id)
	const app = new Hono()
	app.route('/operator/hiring', hiringOperatorRoutes)
	app.route('/careers', careersRoutes)

	return {
		directory,
		app,
		db: (orgId = ORG_A) => getTenantDb(orgId),
		async operator(method, requestPath, options = {}) {
			const headers: Record<string, string> = {}
			if (options.token !== null) {
				const token =
					options.token ??
					(await mintStaffToken({
						orgId: options.orgId,
						scope: options.scope ?? 'hiring',
						grants: options.grants ?? HIRING_GRANTS,
						scopeIds: options.scopeIds,
						impersonated: options.impersonated,
					}))
				headers.Authorization = `Bearer ${token}`
			}
			let body: string | undefined
			if (options.rawBody !== undefined) body = options.rawBody
			else if (options.body !== undefined) body = JSON.stringify(options.body)
			if (body !== undefined) headers['content-type'] = 'application/json'
			return toReply(
				await app.request(`/operator/hiring${requestPath}`, {
					method,
					headers,
					body,
				}),
			)
		},
		async careers(requestPath, options = {}) {
			const headers: Record<string, string> = { ...options.headers }
			if (options.origin !== null) {
				headers.Origin = options.origin ?? 'https://acme.menuza.test'
			}
			let body: string | undefined
			if (options.rawBody !== undefined) body = options.rawBody
			else if (options.body !== undefined) body = JSON.stringify(options.body)
			if (body !== undefined) headers['content-type'] = 'application/json'
			return toReply(
				await app.request(`/careers${requestPath}`, {
					method: options.method ?? 'POST',
					headers,
					body,
				}),
			)
		},
		async cleanup() {
			for (const id of orgIds) {
				try {
					await destroyTenantDb(id)
				} catch {
					// already gone
				}
			}
			fs.rmSync(directory, { recursive: true, force: true })
		},
	}
}

let counter = 0

/** Inserts an application directly (the operator tests do not go through the form). */
export async function seedApplication(
	db: TenantDatabase,
	overrides: Partial<NewHiringApplicationRow> = {},
): Promise<HiringApplicationRow> {
	counter += 1
	const [row] = await db
		.insert(hiringApplications)
		.values({
			postingId: 'posting-1',
			postingSlug: 'line-cook',
			postingTitle: 'Line cook',
			positionName: 'Line cook',
			scopeId: LOC_1,
			firstName: `Sara${counter}`,
			lastName: 'Ali',
			email: `sara${counter}@example.com`,
			phone: null,
			answers: [
				{
					id: 'weekends',
					kind: 'yes_no',
					prompt: 'Can you work weekends?',
					category: 'availability',
					answer: 'yes',
					requiredAnswer: 'yes',
					dealbreaker: true,
				},
				{
					id: 'about',
					kind: 'open',
					prompt: 'About you',
					answer: 'Two years on the grill',
				},
			],
			screenerScore: 100,
			screenerFlags: [],
			consentAt: 1_000,
			consentVersion: '2026-10',
			...overrides,
		})
		.returning()
	return row!
}
