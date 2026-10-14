import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { vi } from 'vitest'
import { brand } from '@repo/config/brand'
import {
	STAFFING_PERMISSIONS as P,
	STAFFING_TOKEN_AUDIENCE,
	STAFFING_TOKEN_TYP,
	type StaffingPermission,
} from '@repo/staffing'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { staffOperatorRoutes } from '../src/routes/staff.ts'

/**
 * Shared harness for the `/operator/staff` suites. Each suite still declares
 * its own `vi.mock('../lib/origin.ts')` (Vitest hoists mocks per file) and
 * feeds this harness's `orgs` registry.
 */

export const OPERATOR_SECRET = 'test-operator-token-very-long-and-secure-12345'
export const HMAC_SECRET = 'test-hmac-secret-123456789'
export const INTERNAL_TOKEN = 'test-internal-token-very-long-and-secure-12345'
export const JWT_SECRET = 'test-jwt-secret-123456789'

export const ORG_A = 'clw9x0a12000008l00staffa'
export const ORG_B = 'clw9x0a12000008l00staffb'

export type TestOrg = {
	id: string
	slug: string
	customDomain: null
	hasProvisionedDb: boolean
	dataRegion: string
}

export function makeOrg(id: string, overrides: Partial<TestOrg> = {}): TestOrg {
	return {
		id,
		slug: id,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		...overrides,
	}
}

/** Every grant a built-in admin holds for the staff scope. */
export const ADMIN_GRANTS: StaffingPermission[] = [
	P.READ_STAFF,
	P.UPDATE_STAFF,
	P.READ_STAFF_PAY,
	P.UPDATE_STAFF_PAY,
	P.READ_STAFF_PRIVATE,
	P.UPDATE_STAFF_PRIVATE,
]
export const READ_ONLY_GRANTS: StaffingPermission[] = [P.READ_STAFF]
/** A manager without pay or private access. */
export const MANAGER_GRANTS: StaffingPermission[] = [
	P.READ_STAFF,
	P.UPDATE_STAFF,
]
/** Update grants only: a stronger grant satisfies the matching read. */
export const UPDATE_ONLY_GRANTS: StaffingPermission[] = [
	P.UPDATE_STAFF,
	P.UPDATE_STAFF_PAY,
	P.UPDATE_STAFF_PRIVATE,
]

export type MintOptions = {
	orgId?: string
	sub?: string
	scope?: string
	grants?: readonly string[]
	scopeIds?: readonly string[] | null
	impersonated?: boolean
	region?: 'us' | 'ksa'
	/** Lifetime in seconds. Defaults to the App's TTL for the grants. */
	lifetimeSeconds?: number
	audience?: string
	typ?: string
	secret?: string
	issuer?: string
	role?: string
	issuedAt?: number
	extraClaims?: Record<string, unknown>
}

const SENSITIVE = [
	P.READ_STAFF_PAY,
	P.UPDATE_STAFF_PAY,
	P.READ_STAFF_PRIVATE,
	P.UPDATE_STAFF_PRIVATE,
] as string[]

export async function mintStaffToken(options: MintOptions = {}) {
	const grants = options.grants ?? ADMIN_GRANTS
	const sensitive = grants.some((grant) => SENSITIVE.includes(grant))
	const lifetime =
		options.lifetimeSeconds ?? (sensitive || options.impersonated ? 300 : 900)
	const iat = options.issuedAt ?? Math.floor(Date.now() / 1000)
	return new SignJWT({
		orgId: options.orgId ?? ORG_A,
		role: options.role ?? 'operator',
		scope: options.scope ?? 'staff',
		grants: [...grants],
		scopeIds: options.scopeIds === undefined ? null : options.scopeIds,
		impersonated: options.impersonated ?? false,
		...(options.region ? { region: options.region } : {}),
		...options.extraClaims,
	})
		.setSubject(options.sub ?? 'operator-1')
		.setProtectedHeader({
			alg: 'HS256',
			typ: options.typ ?? STAFFING_TOKEN_TYP,
		})
		.setAudience(options.audience ?? STAFFING_TOKEN_AUDIENCE)
		.setIssuer(options.issuer ?? brand.shortName)
		.setIssuedAt(iat)
		.setExpirationTime(iat + lifetime)
		.sign(new TextEncoder().encode(options.secret ?? OPERATOR_SECRET))
}

export function stubStaffEnv(directory: string, region: 'us' | 'ksa' = 'us') {
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', region)
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', INTERNAL_TOKEN)
	vi.stubEnv('TENANT_OPERATOR_TOKEN', OPERATOR_SECRET)
	vi.stubEnv('JWT_SECRET', JWT_SECRET)
	vi.stubEnv('AUTH_HMAC_SECRET', HMAC_SECRET)
	vi.stubEnv('APP_URL', 'https://app.test')
}

export type StaffHarness = {
	directory: string
	app: Hono
	request: (
		method: string,
		path: string,
		options?: {
			token?: string | null
			body?: unknown
			headers?: Record<string, string>
			rawBody?: string
		},
	) => Promise<{ status: number; body: any; raw: string; headers: Headers }>
	cleanup: () => Promise<void>
}

/** Provisions fresh databases for the given orgs and mounts the staff routes. */
export async function createStaffHarness(
	orgIds: string[] = [ORG_A, ORG_B],
	region: 'us' | 'ksa' = 'us',
): Promise<StaffHarness> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-routes-'))
	stubStaffEnv(directory, region)
	for (const id of orgIds) await provisionTenantDb(id)
	const app = new Hono()
	app.route('/operator/staff', staffOperatorRoutes)

	return {
		directory,
		app,
		async request(method, requestPath, options = {}) {
			const headers: Record<string, string> = { ...options.headers }
			if (options.token !== null) {
				const token = options.token ?? (await mintStaffToken())
				headers.Authorization = `Bearer ${token}`
			}
			let body: string | undefined
			if (options.rawBody !== undefined) body = options.rawBody
			else if (options.body !== undefined) body = JSON.stringify(options.body)
			if (body !== undefined) headers['content-type'] = 'application/json'
			// The roster root is `/operator/staff` (no trailing slash).
			const suffix = requestPath.startsWith('/?')
				? requestPath.slice(1)
				: requestPath === '/'
					? ''
					: requestPath
			const response = await app.request(`/operator/staff${suffix}`, {
				method,
				headers,
				body,
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
				body: parsed as any,
				raw,
				headers: response.headers,
			}
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

export const LOC_1 = 'loc-1'
export const LOC_2 = 'loc-2'
export const LOC_3 = 'loc-3'

export function staffBody(overrides: Record<string, unknown> = {}) {
	return {
		firstName: 'Rana',
		lastName: 'Khalid',
		email: 'rana@example.com',
		phone: '+14155550123',
		assignments: [{ scopeId: LOC_1, isPrimary: true }],
		...overrides,
	}
}
