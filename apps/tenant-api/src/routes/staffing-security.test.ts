import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { STAFFING_SCOPES } from '@repo/staffing'
import {
	createStaffHarness,
	makeOrg,
	mintStaffToken,
	ORG_A,
	ORG_B,
	type StaffHarness,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import { careersRoutes } from './careers.ts'
import { hiringOperatorRoutes } from './hiring.ts'
import { kioskRoutes } from './kiosk.ts'
import { laborRoutes } from './labor.ts'
import { scheduleLinkRoutes } from './schedule-link.ts'
import { scheduleOperatorRoutes } from './schedule.ts'
import { staffInternalRoutes } from './staff-internal.ts'
import { staffOperatorRoutes } from './staff.ts'
import { timeclockOperatorRoutes } from './timeclock.ts'

/**
 * The staffing security sweep. It is an automated gate, not a one-off review:
 * adding a staffing route that skips the guard, or a staffing router that has
 * no cross-organization and cross-scope tests, fails here.
 *
 *  1. Every route under a staffing operator prefix refuses a request with no
 *     token (401), and refuses a signed token that holds no grants, whatever
 *     scope it carries (403). The matrix is built from the routers themselves,
 *     so a new route is covered the day it is added.
 *  2. The staffing mounts in `app.ts` and the matrix below cannot drift apart.
 *  3. Every router has a test file that proves another organization's data and
 *     another scope's data are unreachable.
 *  4. The credential-less surfaces (kiosk, schedule link, careers, internal
 *     commands) never answer a request with no credential with data or a 500.
 */

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const SRC = path.resolve(import.meta.dirname, '..')
const ROUTES_DIR = import.meta.dirname

/** Staffing operator routers and where `app.ts` mounts them. */
const OPERATOR_MOUNTS = {
	'/operator/staff': staffOperatorRoutes,
	'/operator/timeclock': timeclockOperatorRoutes,
	'/operator/schedule': scheduleOperatorRoutes,
	'/operator/labor': laborRoutes,
	'/operator/hiring': hiringOperatorRoutes,
} as const

/** Routes with a credential other than an operator token. */
const OTHER_MOUNTS = {
	'/kiosk': kioskRoutes,
	'/schedule-link': scheduleLinkRoutes,
	'/careers': careersRoutes,
	'/internal/staff': staffInternalRoutes,
} as const

/** Operator routes that may answer a grantless token, with the reason. */
const GRANTLESS_ALLOWED: ReadonlyArray<{ method: string; pattern: RegExp }> = []

function fill(routePath: string): string {
	return routePath
		.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, (_match, ignoredRegex) =>
			ignoredRegex ? '2026-10-12' : 'clw9x0a12000008l00staffa',
		)
		.replace(/\*/g, 'x')
}

function operatorRoutes() {
	const app = new Hono()
	for (const [prefix, router] of Object.entries(OPERATOR_MOUNTS)) {
		app.route(prefix, router)
	}
	const seen = new Set<string>()
	const list: Array<{ method: string; path: string }> = []
	for (const route of app.routes) {
		if (route.method === 'ALL') continue
		const key = `${route.method} ${route.path}`
		if (seen.has(key)) continue
		seen.add(key)
		list.push({ method: route.method, path: route.path })
	}
	return { app, list }
}

describe('Staffing security sweep: operator routes', () => {
	let harness: StaffHarness
	const { app, list } = operatorRoutes()

	beforeAll(async () => {
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		harness = await createStaffHarness()
	})

	afterAll(async () => {
		await harness.cleanup()
		vi.unstubAllEnvs()
	})

	it('finds a realistic number of routes (the matrix is not empty)', () => {
		expect(list.length).toBeGreaterThan(100)
	})

	it('refuses every route with no token', async () => {
		const failures: string[] = []
		for (const route of list) {
			const response = await app.request(fill(route.path), {
				method: route.method,
			})
			if (response.status !== 401) {
				failures.push(`${route.method} ${route.path} -> ${response.status}`)
			}
		}
		expect(failures).toEqual([])
	})

	it('refuses a token signed for another audience or secret', async () => {
		const wrongSecret = await mintStaffToken({
			secret: 'a-completely-different-secret-value-123456',
		})
		const wrongAudience = await mintStaffToken({
			audience: 'tenant-api-operator',
		})
		const failures: string[] = []
		for (const route of list) {
			for (const token of [wrongSecret, wrongAudience]) {
				const response = await app.request(fill(route.path), {
					method: route.method,
					headers: { Authorization: `Bearer ${token}` },
				})
				if (response.status !== 401) {
					failures.push(`${route.method} ${route.path} -> ${response.status}`)
				}
			}
		}
		expect(failures).toEqual([])
	})

	it('refuses a signed token with no grants in every scope', async () => {
		const failures: string[] = []
		for (const scope of STAFFING_SCOPES) {
			const token = await mintStaffToken({ scope, grants: [] })
			for (const route of list) {
				if (
					GRANTLESS_ALLOWED.some(
						(allowed) =>
							allowed.method === route.method &&
							allowed.pattern.test(route.path),
					)
				) {
					continue
				}
				const response = await app.request(fill(route.path), {
					method: route.method,
					headers: { Authorization: `Bearer ${token}` },
				})
				if (response.status !== 403) {
					failures.push(
						`${scope}: ${route.method} ${route.path} -> ${response.status}`,
					)
				}
			}
		}
		expect(failures).toEqual([])
	})

	it('never answers with a server error to a refused request', async () => {
		const token = await mintStaffToken({ scope: 'staff', grants: [] })
		for (const route of list) {
			const response = await app.request(fill(route.path), {
				method: route.method,
				headers: { Authorization: `Bearer ${token}` },
			})
			expect(response.status, `${route.method} ${route.path}`).toBeLessThan(500)
		}
	})
})

describe('Staffing security sweep: mounts', () => {
	const appSource = fs.readFileSync(path.join(SRC, 'app.ts'), 'utf8')

	it('app.ts mounts every staffing operator router this sweep covers', () => {
		for (const prefix of Object.keys(OPERATOR_MOUNTS)) {
			expect(appSource).toContain(`app.route('${prefix}'`)
		}
	})

	it('no other staffing operator mount exists in app.ts', () => {
		const mounted = [
			...appSource.matchAll(/app\.route\('(\/operator\/[^']+)'/g),
		].map((match) => match[1]!)
		const staffing = mounted.filter((prefix) =>
			/\/operator\/(staff|timeclock|schedule|labor|hiring|onboarding|timesheets|payroll|tips)/.test(
				prefix,
			),
		)
		expect(staffing.sort()).toEqual(Object.keys(OPERATOR_MOUNTS).sort())
	})

	it('app.ts mounts every credential-less staffing surface this sweep covers', () => {
		for (const prefix of Object.keys(OTHER_MOUNTS)) {
			expect(appSource).toContain(`app.route('${prefix}'`)
		}
	})
})

describe('Staffing security sweep: isolation tests exist', () => {
	/**
	 * Each router must have at least one test file (matched by name prefix) that
	 * proves both isolation boundaries: another organization's data, and another
	 * scope's data, are not reachable.
	 */
	const ROUTERS: ReadonlyArray<{
		name: string
		testPrefixes: string[]
		/**
		 * False for the routes the control plane calls with the shared internal
		 * token: they act on a whole organization by definition, so there is no
		 * caller scope to cross. Their organization boundary is still tested.
		 */
		scopeScoped?: boolean
	}> = [
		{ name: 'staff', testPrefixes: ['staff.'] },
		{ name: 'timeclock', testPrefixes: ['timeclock.'] },
		{ name: 'timesheets', testPrefixes: ['timesheets.'] },
		{ name: 'schedule', testPrefixes: ['schedule.'] },
		{ name: 'labor', testPrefixes: ['labor.'] },
		{ name: 'hiring', testPrefixes: ['hiring.'] },
		{ name: 'onboarding', testPrefixes: ['onboarding.'] },
		{ name: 'kiosk', testPrefixes: ['kiosk.'] },
		{ name: 'careers', testPrefixes: ['careers.'] },
		{ name: 'schedule-link', testPrefixes: ['schedule-link.'] },
		{
			name: 'staff-internal',
			testPrefixes: ['staff-internal.'],
			scopeScoped: false,
		},
		{
			name: 'staff-tick',
			testPrefixes: ['staff-tick.'],
			scopeScoped: false,
		},
	]
	const CROSS_ORG =
		/(cross[- ]org|another org|other org|different org|never reaches another org|org[- ]?b\b|ORG_B|otherOrg)/i
	const CROSS_SCOPE =
		/(cross[- ]scope|another scope|other scope|outside (its|their|the|your) (scope|scope)|scope[- ]scope|LOC_2|LOC_3|scopeIds)/i

	function testsFor(prefixes: string[]): string {
		return fs
			.readdirSync(ROUTES_DIR)
			.filter((file) => file.endsWith('.test.ts'))
			.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)))
			.filter((file) => file !== 'staffing-security.test.ts')
			.map((file) => fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8'))
			.join('\n')
	}

	it('every staffing route module exists', () => {
		for (const { name } of ROUTERS) {
			expect(fs.existsSync(path.join(ROUTES_DIR, `${name}.ts`)), name).toBe(
				true,
			)
		}
	})

	it('every staffing route file is in the list above', () => {
		const known = new Set(ROUTERS.map((router) => router.name))
		const staffingFiles = fs
			.readdirSync(ROUTES_DIR)
			.filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
			.map((file) => file.replace(/\.ts$/, ''))
			.filter((name) =>
				/^(staff|timeclock|timesheets|schedule|labor|hiring|onboarding|kiosk|careers|payroll|tips|certificates)/.test(
					name,
				),
			)
		expect(staffingFiles.filter((name) => !known.has(name))).toEqual([])
	})

	/** Test file prefixes that exercise each operator mount (sub-routers included). */
	const MOUNT_TESTS: Record<keyof typeof OPERATOR_MOUNTS, string[]> = {
		'/operator/staff': ['staff.'],
		'/operator/timeclock': ['timeclock.', 'timesheets.'],
		'/operator/schedule': ['schedule.'],
		'/operator/labor': ['labor.'],
		'/operator/hiring': ['hiring.', 'onboarding.'],
	}

	it('every operator route is exercised by a test of its own router', () => {
		const untested: string[] = []
		for (const [prefix, router] of Object.entries(OPERATOR_MOUNTS)) {
			const text = testsFor(MOUNT_TESTS[prefix as keyof typeof MOUNT_TESTS])
			const app = new Hono()
			app.route(prefix, router)
			for (const route of app.routes) {
				if (route.method === 'ALL') continue
				// The last two fixed segments (`applications/hire`), in order on a line.
				const tail = route.path
					.slice(prefix.length)
					.split('/')
					.filter((part) => part && !/^[:*]/.test(part))
					.slice(-2)
				const pattern = new RegExp(
					tail
						.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
						.join('[^\\n]*?'),
				)
				if (!pattern.test(text)) untested.push(`${route.method} ${route.path}`)
			}
		}
		expect(untested).toEqual([])
	})

	for (const { name, testPrefixes, scopeScoped = true } of ROUTERS) {
		it(`${name}: tests prove another organization is unreachable`, () => {
			expect(testsFor(testPrefixes)).toMatch(CROSS_ORG)
		})
		if (scopeScoped) {
			it(`${name}: tests prove another scope is unreachable`, () => {
				expect(testsFor(testPrefixes)).toMatch(CROSS_SCOPE)
			})
		}
	}
})

describe('Staffing security sweep: credential-less surfaces', () => {
	const app = new Hono()
	for (const [prefix, router] of Object.entries(OTHER_MOUNTS)) {
		app.route(prefix, router)
	}
	let harness: StaffHarness

	beforeAll(async () => {
		orgs.set(ORG_A, makeOrg(ORG_A))
		harness = await createStaffHarness([ORG_A])
	})

	afterAll(async () => {
		await harness.cleanup()
		vi.unstubAllEnvs()
	})

	/** Public on purpose: the applicant form and the job feed have no login. */
	const PUBLIC_ON_PURPOSE = [/^\/careers(\/|$)/]

	it('internal commands and device routes answer a bare request with a refusal', async () => {
		const routes: Array<{ method: string; path: string }> = []
		const seen = new Set<string>()
		for (const route of app.routes) {
			if (route.method === 'ALL') continue
			const key = `${route.method} ${route.path}`
			if (seen.has(key)) continue
			seen.add(key)
			routes.push({ method: route.method, path: route.path })
		}
		expect(routes.length).toBeGreaterThan(20)

		const failures: string[] = []
		for (const route of routes) {
			const response = await app.request(fill(route.path), {
				method: route.method,
			})
			const publicRoute = PUBLIC_ON_PURPOSE.some((pattern) =>
				pattern.test(route.path),
			)
			// Never a server error, for any surface.
			if (response.status >= 500 && response.status !== 503) {
				failures.push(`${route.method} ${route.path} -> ${response.status}`)
			}
			if (!publicRoute && response.status >= 200 && response.status < 300) {
				failures.push(
					`${route.method} ${route.path} answered ${response.status} with no credential`,
				)
			}
		}
		expect(failures).toEqual([])
	})
})
