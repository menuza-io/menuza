import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_SCOPES,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	restrictGrantsForImpersonation,
	SCOPE_GRANTS,
	type ReservationsScope,
} from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuests,
	rsvHolds,
	rsvLocationSettings,
	rsvNotifyRequests,
	rsvReservations,
	rsvWaitlistEntries,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	getReservationsContext,
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import {
	createExperience,
	createExperienceSchedule,
	publishExperience,
} from '../services/rsv-experience-service.ts'
import {
	reservationsInternalRoutes,
	reservationsTickRoutes,
	reservationsVoiceActionRoutes,
} from './reservations-internal.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'
import { reservationsPaymentsInternalRoutes } from './reservations-payments-internal.ts'
import {
	deriveManageToken,
	deriveNotifyToken,
	deriveWaitlistToken,
	resetPublicRateLimits,
} from '../lib/reservations-public-auth.ts'
import {
	dateAhead,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from './reservations-public-fixture.ts'
import { reservationsPublicRoutes } from './reservations-public.ts'

const SECRET = 'reservations-security-test-secret-0123456789'
const INTERNAL_TOKEN = 'internal-command-token-0123456789'
const VOICE_TOKEN = 'voice-agent-secret-token-0123456789abcdef'

const ORG_A = 'org_rsv_sec_a'
const ORG_B = 'org_rsv_sec_b'
const ORG_KSA = 'org_rsv_sec_ksa'
const ORG_UNPROVISIONED = 'org_rsv_sec_unprov'

const LOC_1 = 'loc_downtown'
const LOC_2 = 'loc_uptown'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
const originOrgs = vi.hoisted(
	() =>
		new Map<string, string>([
			['http://acme-public.menuza.test:3008', 'org_rsv_sec_public'],
			['http://other-public.menuza.test:3008', 'org_rsv_sec_other'],
			['http://riyadh-public.menuza.test:3008', 'org_rsv_sec_ksa'],
		]),
)

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	resolveOrganizationForPublicOrigin: vi.fn(async (origin?: string) => {
		const id = origin ? originOrgs.get(origin) : undefined
		return id ? (orgs.get(id) ?? null) : null
	}),
	resolveOrganizationForBrowserAuth: vi.fn(
		async (_origin: string | undefined, hint?: { slug?: string }) => {
			if (!hint?.slug) return null
			for (const org of orgs.values()) {
				if (org.slug === hint.slug) return org
			}
			return null
		},
	),
}))

const SRC = path.resolve(import.meta.dirname, '..')

const OPERATOR_MOUNTS = {
	'/operator/reservations': reservationsOperatorRoutes,
} as const

const OTHER_MOUNTS = {
	'/reservations': reservationsPublicRoutes,
	'/internal/reservations': reservationsInternalRoutes,
	'/api/reservations/payments': reservationsPaymentsInternalRoutes,
	'/api/reservations': reservationsTickRoutes,
	'/api/voice/actions': reservationsVoiceActionRoutes,
} as const

function fill(routePath: string): string {
	return routePath
		.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, (_match, ignoredRegex) =>
			ignoredRegex ? '2026-07-15' : LOC_1,
		)
		.replace(/\*/g, 'x')
}

function scopeForRoute(routePath: string): ReservationsScope {
	if (
		routePath.startsWith('/operator/reservations/setup') ||
		routePath.startsWith('/operator/reservations/experiences')
	) {
		return 'setup'
	}
	if (routePath.startsWith('/operator/reservations/guests')) {
		return 'guests'
	}
	if (routePath.startsWith('/operator/reservations/reports')) {
		return 'reports'
	}
	if (routePath.startsWith('/operator/reservations/payments')) {
		return 'payments'
	}
	return 'book'
}

function buildRouteInit(
	route: { method: string; path: string },
	headers: Record<string, string>,
	extraBody: Record<string, unknown> = {},
): RequestInit {
	if (route.method === 'GET' || route.method === 'HEAD') {
		return { method: route.method, headers }
	}
	return {
		method: route.method,
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
		body: JSON.stringify({
			locationId: LOC_1,
			businessDate: '2026-07-15',
			localStartMin: 1140,
			partySize: 2,
			firstName: 'Test',
			lastName: 'Guest',
			paymentId: 'pay_test_1',
			enabled: true,
			...extraBody,
		}),
	}
}

function buildOperatorApp() {
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

async function mintRsvToken(overrides?: {
	signingKey?: string
	typ?: string
	audience?: string
	issuer?: string
	orgId?: string
	region?: 'us' | 'ksa'
	scope?: ReservationsScope
	grants?: string[]
	locationIds?: string[] | null
	impersonated?: boolean
	ttlSeconds?: number
	experiences?: boolean
}) {
	const now = Math.floor(Date.now() / 1000)
	const ttl = overrides?.ttlSeconds ?? 300
	const scope = overrides?.scope ?? 'book'
	const impersonated = overrides?.impersonated ?? false
	const defaultGrants = impersonated
		? restrictGrantsForImpersonation(SCOPE_GRANTS[scope], true)
		: [...SCOPE_GRANTS[scope]]
	return new jose.SignJWT({
		role: 'operator',
		orgId: overrides?.orgId ?? ORG_A,
		region: overrides?.region ?? 'us',
		scope,
		grants: overrides?.grants ?? defaultGrants,
		locationIds:
			overrides?.locationIds === undefined ? null : overrides.locationIds,
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			payments: true,
			experiences: overrides?.experiences ?? true,
			voice: false,
		},
		impersonated,
	})
		.setProtectedHeader({
			alg: 'HS256',
			typ: overrides?.typ ?? RESERVATIONS_TOKEN_TYP,
		})
		.setSubject('user_sec_1')
		.setIssuer(overrides?.issuer ?? brand.shortName)
		.setAudience(overrides?.audience ?? RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + ttl)
		.sign(new TextEncoder().encode(overrides?.signingKey ?? SECRET))
}

describe('Reservations security sweep: operator routes', () => {
	let tmpDir: string
	const { app, list } = buildOperatorApp()

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-sec-test-'))
		process.env.TENANT_DB_DIR = tmpDir
		process.env.TENANT_OPERATOR_TOKEN = SECRET
		process.env.INTERNAL_COMMAND_TOKEN = INTERNAL_TOKEN
		process.env.VOICE_AGENT_TOKEN = VOICE_TOKEN
		process.env.DATA_REGION = 'us'

		orgs.set(ORG_A, {
			id: ORG_A,
			slug: 'acme-a',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: 'Acme A',
		})
		orgs.set(ORG_B, {
			id: ORG_B,
			slug: 'acme-b',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: 'Acme B',
		})
		orgs.set(ORG_KSA, {
			id: ORG_KSA,
			slug: 'riyadh-ksa',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'ksa',
			name: 'Riyadh KSA',
		})
		orgs.set(ORG_UNPROVISIONED, {
			id: ORG_UNPROVISIONED,
			slug: 'unprovisioned-org',
			customDomain: null,
			hasProvisionedDb: false,
			dataRegion: 'us',
			name: 'Unprovisioned Org',
		})

		await provisionTenantDb(ORG_A)
		await provisionTenantDb(ORG_B)
	})

	afterAll(async () => {
		await destroyTenantDb(ORG_A)
		await destroyTenantDb(ORG_B)
		fs.rmSync(tmpDir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('discovers all mounted operator reservation routes', () => {
		expect(list.length).toBeGreaterThanOrEqual(8)
		const keys = new Set(list.map((r) => `${r.method} ${r.path}`))
		expect(keys.has('GET /operator/reservations/book/conflicts')).toBe(true)
		expect(
			keys.has('GET /operator/reservations/book/reservations/:id/events'),
		).toBe(true)
		expect(
			keys.has(
				'DELETE /operator/reservations/setup/locations/:locationId/pacing/:id',
			),
		).toBe(true)
		expect(
			keys.has(
				'DELETE /operator/reservations/setup/locations/:locationId/service-availability/:id',
			),
		).toBe(true)
		expect(
			keys.has('POST /operator/reservations/book/reservations/:id/contact'),
		).toBe(true)
		expect(
			keys.has(
				'POST /operator/reservations/book/reservations/:id/contact-status',
			),
		).toBe(true)
		expect(
			keys.has('POST /operator/reservations/book/reservations/:id/course'),
		).toBe(true)
		expect(
			keys.has(
				'POST /operator/reservations/book/reservations/:id/course-status',
			),
		).toBe(true)
		for (const key of [
			'POST /operator/reservations/book/reservations/:id/resend',
			'GET /operator/reservations/setup/message-texts',
			'PUT /operator/reservations/setup/message-texts',
			'GET /operator/reservations/setup/message-texts/preview',
			'GET /operator/reservations/book/today',
			'GET /operator/reservations/guests/tags',
			'POST /operator/reservations/guests/merge',
			'POST /operator/reservations/guests/:id/notes',
			'GET /operator/reservations/reports/summary',
			'GET /operator/reservations/reports/no-shows',
			'GET /operator/reservations/reports/cancellations',
			'GET /operator/reservations/reports/turn-times',
			'GET /operator/reservations/reports/waitlist',
			'GET /operator/reservations/reports/pacing',
			'GET /operator/reservations/setup/locations/:locationId/experiences',
			'POST /operator/reservations/setup/locations/:locationId/experiences',
			'GET /operator/reservations/setup/locations/:locationId/experiences/:id',
			'PATCH /operator/reservations/setup/locations/:locationId/experiences/:id',
			'PUT /operator/reservations/setup/locations/:locationId/experiences/:id',
			'POST /operator/reservations/setup/locations/:locationId/experiences/:id/publish',
			'POST /operator/reservations/setup/locations/:locationId/experiences/:id/unpublish',
			'POST /operator/reservations/setup/locations/:locationId/experiences/:id/archive',
			'POST /operator/reservations/setup/locations/:locationId/experiences/:id/schedules',
			'PATCH /operator/reservations/setup/locations/:locationId/experiences/:id/schedules/:scheduleId',
			'PUT /operator/reservations/setup/locations/:locationId/experiences/:id/schedules/:scheduleId',
			'DELETE /operator/reservations/setup/locations/:locationId/experiences/:id/schedules/:scheduleId',
		]) {
			expect(keys.has(key), key).toBe(true)
		}
	})

	it('maps the guest-message routes to the scopes the sweep expects', () => {
		expect(scopeForRoute('/operator/reservations/setup/message-texts')).toBe(
			'setup',
		)
		expect(
			scopeForRoute('/operator/reservations/setup/message-texts/preview'),
		).toBe('setup')
		expect(
			scopeForRoute('/operator/reservations/book/reservations/:id/resend'),
		).toBe('book')
	})

	it('refuses every route with no token (401)', async () => {
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

	it('refuses a token signed with wrong secret, wrong audience (tenant-api-staffing or tenant-api-operator), wrong typ, or over-long TTL (401)', async () => {
		const wrongSecret = await mintRsvToken({
			signingKey: `${SECRET}-mismatch`,
		})
		const wrongAudienceStaffing = await mintRsvToken({
			audience: 'tenant-api-staffing',
		})
		const wrongAudienceOperator = await mintRsvToken({
			audience: 'tenant-api-operator',
		})
		const wrongTyp = await mintRsvToken({
			typ: 'JWT',
		})
		const overLongStandardTtl = await mintRsvToken({
			ttlSeconds: 901,
		})
		const overLongImpersonatedTtl = await mintRsvToken({
			impersonated: true,
			ttlSeconds: 301,
		})
		const overLongSensitiveGrantTtl = await mintRsvToken({
			scope: 'payments',
			grants: [RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT],
			ttlSeconds: 301,
		})
		const invalidTokens = [
			wrongSecret,
			wrongAudienceStaffing,
			wrongAudienceOperator,
			wrongTyp,
			overLongStandardTtl,
			overLongImpersonatedTtl,
			overLongSensitiveGrantTtl,
		]
		const failures: string[] = []
		for (const route of list) {
			for (const token of invalidTokens) {
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

	it('refuses a token with region mismatch (403 region_mismatch)', async () => {
		const ksaToken = await mintRsvToken({ region: 'ksa' })
		const failures: string[] = []
		for (const route of list) {
			const response = await app.request(fill(route.path), {
				method: route.method,
				headers: { Authorization: `Bearer ${ksaToken}` },
			})
			if (response.status !== 403) {
				failures.push(`${route.method} ${route.path} -> ${response.status}`)
			}
		}
		expect(failures).toEqual([])
	})

	it('refuses a signed token with no grants in every scope (403)', async () => {
		const failures: string[] = []
		for (const scope of RESERVATIONS_SCOPES) {
			const token = await mintRsvToken({ scope, grants: [] })
			for (const route of list) {
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

	it('refuses a token with the wrong scope on every route (403)', async () => {
		const failures: string[] = []
		for (const route of list) {
			const expectedScope = scopeForRoute(route.path)
			const wrongScope = RESERVATIONS_SCOPES.find((s) => s !== expectedScope)!
			const token = await mintRsvToken({
				scope: wrongScope,
				ttlSeconds: 300,
			})
			const response = await app.request(fill(route.path), {
				method: route.method,
				headers: { Authorization: `Bearer ${token}` },
			})
			if (response.status !== 403) {
				failures.push(
					`${route.method} ${route.path} (wrongScope=${wrongScope}) -> ${response.status}`,
				)
			}
		}
		expect(failures).toEqual([])
	})

	it('refuses an impersonated token on every write route (403 impersonated_read_only)', async () => {
		const writeRoutes = list.filter(
			(route) => route.method !== 'GET' && route.method !== 'HEAD',
		)
		expect(writeRoutes.length).toBeGreaterThanOrEqual(4)

		const failures: string[] = []
		for (const route of writeRoutes) {
			const token = await mintRsvToken({
				scope: scopeForRoute(route.path),
				impersonated: true,
				ttlSeconds: 300,
			})
			const response = await app.request(
				fill(route.path),
				buildRouteInit(route, { Authorization: `Bearer ${token}` }),
			)
			if (response.status !== 403) {
				failures.push(`${route.method} ${route.path} -> ${response.status}`)
			}
		}
		expect(failures).toEqual([])
	})

	it('hides every Experiences setup route behind the experiences feature (VAL-EXP-013)', async () => {
		const experienceRoutes = list.filter((r) =>
			r.path.includes('/setup/locations/:locationId/experiences'),
		)
		expect(experienceRoutes.length).toBeGreaterThanOrEqual(12)
		const off = await mintRsvToken({ scope: 'setup', experiences: false })
		const failures: string[] = []
		for (const route of experienceRoutes) {
			const response = await app.request(
				fill(route.path),
				buildRouteInit(route, { Authorization: `Bearer ${off}` }),
			)
			if (response.status !== 404) {
				failures.push(`${route.method} ${route.path} -> ${response.status}`)
			}
		}
		expect(failures).toEqual([])
		// With the feature on the same token passes the guard (the list route answers).
		const on = await mintRsvToken({ scope: 'setup' })
		const listRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_1}/experiences`,
			{ headers: { Authorization: `Bearer ${on}` } },
		)
		expect(listRes.status).toBe(200)
	})

	it('refuses an active but unprovisioned organization (hasProvisionedDb = false) with uniform 404 across every route', async () => {
		const failures: string[] = []
		for (const route of list) {
			const token = await mintRsvToken({
				orgId: ORG_UNPROVISIONED,
				scope: scopeForRoute(route.path),
				ttlSeconds: 300,
			})
			const url = `${fill(route.path)}?locationId=${LOC_1}&date=2026-07-15`
			const response = await app.request(
				url,
				buildRouteInit(route, { Authorization: `Bearer ${token}` }),
			)
			const body = (await response.json()) as { error?: string }
			if (response.status !== 404 || body.error !== 'not_found') {
				failures.push(
					`${route.method} ${route.path} -> ${response.status} (${JSON.stringify(body)})`,
				)
			}
		}
		expect(failures).toEqual([])
	})

	it('sweeps every mounted route for cross-org (ORG_B) and excluded locationIds ([LOC_2]) and never returns 5xx', async () => {
		const dbA = await provisionTenantDb(ORG_A)
		const dbB = await provisionTenantDb(ORG_B)

		await dbA
			.insert(rsvLocationSettings)
			.values([
				{ locationId: LOC_1, timeZone: 'America/New_York', enabled: true },
				{ locationId: LOC_2, timeZone: 'America/Chicago', enabled: true },
			])
			.onConflictDoNothing()

		await dbB
			.insert(rsvGuests)
			.values({
				id: 'guest_org_b_only',
				firstName: 'SecretOrgB',
				lastName: 'Guest',
			})
			.onConflictDoNothing()

		const crossOrgFailures: string[] = []
		const crossLocFailures: string[] = []

		for (const route of list) {
			const scope = scopeForRoute(route.path)

			// 1. Cross-org sweep: ORG_A token targeting ORG_B via query or X-Org-Id header -> 403/404, never 5xx
			const tokenOrgA = await mintRsvToken({
				orgId: ORG_A,
				scope,
				ttlSeconds: 300,
			})
			const crossOrgUrl = `${fill(route.path)}?orgId=${ORG_B}&locationId=${LOC_1}&date=2026-07-15`
			const crossOrgRes = await app.request(
				crossOrgUrl,
				buildRouteInit(route, {
					Authorization: `Bearer ${tokenOrgA}`,
					'X-Org-Id': ORG_B,
				}),
			)
			if (
				(crossOrgRes.status !== 403 && crossOrgRes.status !== 404) ||
				crossOrgRes.status >= 500
			) {
				crossOrgFailures.push(
					`${route.method} ${route.path} -> ${crossOrgRes.status}`,
				)
			}

			// 2. Cross-location sweep: token scoped to [LOC_2] requesting LOC_1 -> 403/404, never 5xx
			const tokenLoc2Only = await mintRsvToken({
				orgId: ORG_A,
				scope,
				locationIds: [LOC_2],
				ttlSeconds: 300,
			})
			const crossLocUrl = `${fill(route.path)}?locationId=${LOC_1}&date=2026-07-15`
			const crossLocRes = await app.request(
				crossLocUrl,
				buildRouteInit(route, { Authorization: `Bearer ${tokenLoc2Only}` }),
			)
			if (
				(crossLocRes.status !== 403 && crossLocRes.status !== 404) ||
				crossLocRes.status >= 500
			) {
				crossLocFailures.push(
					`${route.method} ${route.path} -> ${crossLocRes.status}`,
				)
			}
		}

		expect(crossOrgFailures).toEqual([])
		expect(crossLocFailures).toEqual([])

		// 3. Data-level verification: ORG_A token never sees ORG_B guests, and [LOC_1] token filters out LOC_2
		const guestsTokenA = await mintRsvToken({
			orgId: ORG_A,
			scope: 'guests',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST],
		})
		const guestsRes = await app.request('/operator/reservations/guests', {
			headers: { Authorization: `Bearer ${guestsTokenA}` },
		})
		expect(guestsRes.status).toBe(200)
		const guestsJson = (await guestsRes.json()) as {
			orgId: string
			guests: Array<{ id: string }>
		}
		expect(guestsJson.orgId).toBe(ORG_A)
		expect(guestsJson.guests.some((g) => g.id === 'guest_org_b_only')).toBe(
			false,
		)

		const scopedSetupToken = await mintRsvToken({
			orgId: ORG_A,
			scope: 'setup',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS],
			locationIds: [LOC_1],
		})
		const overviewRes = await app.request(
			'/operator/reservations/setup/overview',
			{
				headers: { Authorization: `Bearer ${scopedSetupToken}` },
			},
		)
		expect(overviewRes.status).toBe(200)
		const overviewJson = (await overviewRes.json()) as {
			locations: Array<{ locationId: string }>
		}
		expect(overviewJson.locations.map((l) => l.locationId)).toEqual([LOC_1])
	})

	it('VAL-SETUP-027 & VAL-SETUP-028: enforces read vs update grants on all setup routes and blocks cross-location/cross-org setup mutations by entity ID', async () => {
		const setupRoutes = list.filter((r) =>
			r.path.startsWith('/operator/reservations/setup'),
		)
		expect(setupRoutes.length).toBeGreaterThanOrEqual(20)

		const readOnlySetupToken = await mintRsvToken({
			orgId: ORG_A,
			scope: 'setup',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS],
			ttlSeconds: 300,
		})

		// 1. Read-only setup token is rejected with 403 missing_grant on EVERY setup mutation route
		const writeSetupRoutes = setupRoutes.filter(
			(r) => r.method !== 'GET' && r.method !== 'HEAD',
		)
		expect(writeSetupRoutes.length).toBeGreaterThanOrEqual(15)
		const readOnlyMutationFailures: string[] = []
		for (const route of writeSetupRoutes) {
			const res = await app.request(
				fill(route.path),
				buildRouteInit(route, {
					Authorization: `Bearer ${readOnlySetupToken}`,
				}),
			)
			if (res.status !== 403) {
				readOnlyMutationFailures.push(
					`${route.method} ${route.path} -> ${res.status}`,
				)
			}
		}
		expect(readOnlyMutationFailures).toEqual([])

		// 2. Full setup token scoped to LOC_1 creates an area in LOC_1, then a token scoped to LOC_2 is rejected (403) when trying to update or delete that LOC_1 area by ID
		const loc1WriteToken = await mintRsvToken({
			orgId: ORG_A,
			scope: 'setup',
			grants: [
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
			],
			locationIds: [LOC_1],
			ttlSeconds: 300,
		})
		const createAreaRes = await app.request(
			'/operator/reservations/setup/areas',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${loc1WriteToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_1,
					name: 'LOC_1 Only Room',
				}),
			},
		)
		expect(createAreaRes.status).toBe(201)
		const { area } = (await createAreaRes.json()) as { area: { id: string } }

		const loc2WriteToken = await mintRsvToken({
			orgId: ORG_A,
			scope: 'setup',
			grants: [
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
			],
			locationIds: [LOC_2],
			ttlSeconds: 300,
		})
		const crossLocPatchArea = await app.request(
			`/operator/reservations/setup/areas/${area.id}`,
			{
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${loc2WriteToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ name: 'Hijacked Area' }),
			},
		)
		expect(crossLocPatchArea.status).toBe(403)

		const crossLocDeleteArea = await app.request(
			`/operator/reservations/setup/areas/${area.id}`,
			{
				method: 'DELETE',
				headers: { Authorization: `Bearer ${loc2WriteToken}` },
			},
		)
		expect(crossLocDeleteArea.status).toBe(403)

		// 3. Cross-org token (ORG_B) attempting to mutate ORG_A's area by ID gets 404 (not found in ORG_B's DB)
		const orgBWriteToken = await mintRsvToken({
			orgId: ORG_B,
			scope: 'setup',
			grants: [
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
			],
			ttlSeconds: 300,
		})
		const crossOrgDeleteArea = await app.request(
			`/operator/reservations/setup/areas/${area.id}`,
			{
				method: 'DELETE',
				headers: { Authorization: `Bearer ${orgBWriteToken}` },
			},
		)
		expect(crossOrgDeleteArea.status).toBe(404)
	})

	it('VAL-SETUP-020 & VAL-SETUP-021: location-scoped pacing and service-availability deletes return 200 for rows in that location and 404 for rows in another', async () => {
		const dbA = await provisionTenantDb(ORG_A)
		await dbA
			.insert(rsvLocationSettings)
			.values([
				{ locationId: LOC_1, timeZone: 'America/New_York', enabled: true },
				{ locationId: LOC_2, timeZone: 'America/Chicago', enabled: true },
			])
			.onConflictDoNothing()

		const token = await mintRsvToken({
			orgId: ORG_A,
			scope: 'setup',
			grants: [
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
			],
			ttlSeconds: 300,
		})
		const post = async (route: string, body: Record<string, unknown>) => {
			const res = await app.request(`/operator/reservations/setup/${route}`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			})
			expect(res.status).toBe(201)
			return (await res.json()) as Record<string, any>
		}
		const del = (route: string) =>
			app.request(`/operator/reservations/setup/${route}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` },
			})

		const service = (await post('services', {
			locationId: LOC_1,
			name: 'Scoped Dinner',
			daysMask: 127,
			firstSeatingMin: 1020,
			lastSeatingMin: 1290,
			endMin: 1380,
		})) as { service: { id: string } }
		const area = (await post('areas', {
			locationId: LOC_1,
			name: 'Scoped Room',
		})) as { area: { id: string } }

		const makePacing = async () =>
			(
				(await post('pacing', {
					serviceId: service.service.id,
					bucketMin: 15,
					maxCovers: 12,
					channel: 'online',
				})) as { pacingRule: { id: string } }
			).pacingRule.id
		const makeAvailability = async () =>
			(
				(await post('service-availability', {
					serviceId: service.service.id,
					areaId: area.area.id,
					mode: 'staff_only',
				})) as { serviceAvailability: { id: string } }
			).serviceAvailability.id

		const pacingId = await makePacing()
		expect((await del(`locations/${LOC_2}/pacing/${pacingId}`)).status).toBe(
			404,
		)
		expect((await del(`locations/${LOC_1}/pacing/${pacingId}`)).status).toBe(
			200,
		)
		expect((await del(`locations/${LOC_1}/pacing/${pacingId}`)).status).toBe(
			404,
		)

		const availabilityId = await makeAvailability()
		expect(
			(await del(`locations/${LOC_2}/service-availability/${availabilityId}`))
				.status,
		).toBe(404)
		expect(
			(await del(`locations/${LOC_1}/service-availability/${availabilityId}`))
				.status,
		).toBe(200)

		// The unscoped routes keep working.
		expect((await del(`pacing/${await makePacing()}`)).status).toBe(200)
		expect(
			(await del(`service-availability/${await makeAvailability()}`)).status,
		).toBe(200)
	})

	it('enforces book write grants, sensitive guest export grant, guest erase grant, and internal summary auth', async () => {
		const internalApp = new Hono()
		for (const [prefix, router] of Object.entries(OTHER_MOUNTS)) {
			internalApp.route(prefix, router)
		}

		// 1. Read-only book token is refused on book write routes
		const readOnlyBookToken = await mintRsvToken({
			orgId: ORG_A,
			scope: 'book',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION],
			ttlSeconds: 300,
		})
		const createBookRes = await app.request(
			'/operator/reservations/book/reservations',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${readOnlyBookToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_1,
					businessDate: '2026-07-15',
					slotLocal: '19:00',
					partySize: 2,
				}),
			},
		)
		expect(createBookRes.status).toBe(403)

		// 2. Read-only guest token is refused on includeSensitive=1 export and on erase
		const readOnlyGuestToken = await mintRsvToken({
			orgId: ORG_A,
			scope: 'guests',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST],
			ttlSeconds: 300,
		})
		const sensExportRes = await app.request(
			'/operator/reservations/guests/gst_sec_1/export?includeSensitive=1',
			{
				headers: { Authorization: `Bearer ${readOnlyGuestToken}` },
			},
		)
		expect(sensExportRes.status).toBe(403)
		await expect(sensExportRes.json()).resolves.toMatchObject({
			error: 'missing_grant',
		})

		const eraseDeniedRes = await app.request(
			'/operator/reservations/guests/gst_sec_1/erase',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${readOnlyGuestToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({}),
			},
		)
		expect(eraseDeniedRes.status).toBe(403)

		// 3. POST /internal/reservations/summary requires INTERNAL_COMMAND_TOKEN
		const unauthSumRes = await internalApp.request(
			'/internal/reservations/summary',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ orgId: ORG_A }),
			},
		)
		expect(unauthSumRes.status).toBe(401)

		const authSumRes = await internalApp.request(
			'/internal/reservations/summary',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${INTERNAL_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ orgId: ORG_A }),
			},
		)
		expect(authSumRes.status).toBe(200)

		const authLocSumRes = await internalApp.request(
			'/internal/reservations/location-summary',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${INTERNAL_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ orgId: ORG_A, locationId: LOC_1 }),
			},
		)
		expect(authLocSumRes.status).toBe(200)
		await expect(authLocSumRes.json()).resolves.toMatchObject({
			ok: true,
			orgId: ORG_A,
			locationId: LOC_1,
			futureReservations: expect.any(Number),
			activeReservations: expect.any(Number),
			activeWaitlist: expect.any(Number),
			activeHolds: expect.any(Number),
			tables: expect.any(Number),
		})
	})
})

describe('Reservations security sweep: mounts and non-operator surfaces', () => {
	const appSource = fs.readFileSync(path.join(SRC, 'app.ts'), 'utf8')
	const otherApp = new Hono()
	for (const [prefix, router] of Object.entries(OTHER_MOUNTS)) {
		otherApp.route(prefix, router)
	}

	beforeEach(() => {
		resetReservationsContextCache()
		process.env.RESERVATIONS_PUBLIC_ENABLED = 'true'
	})

	it('app.ts mounts all reservations operator, public, internal, tick, and voice routers', () => {
		for (const prefix of Object.keys(OPERATOR_MOUNTS)) {
			expect(appSource).toContain(`app.route('${prefix}'`)
		}
		for (const prefix of Object.keys(OTHER_MOUNTS)) {
			expect(appSource).toContain(`app.route('${prefix}'`)
		}
	})

	it('internal and voice routes refuse bare requests with 401', async () => {
		const res1 = await otherApp.request(
			'/internal/reservations/context-changed',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ orgId: ORG_A }),
			},
		)
		expect(res1.status).toBe(401)

		const res2 = await otherApp.request('/api/reservations/tick', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ orgId: ORG_A }),
		})
		expect(res2.status).toBe(401)

		const res3 = await otherApp.request(
			'/api/voice/actions/reservation-availability',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ orgId: ORG_A, locationId: LOC_1 }),
			},
		)
		expect(res3.status).toBe(401)
	})

	it('every payment broker endpoint refuses a missing, wrong or operator token with 401', async () => {
		const operatorToken = await mintRsvToken({
			orgId: ORG_A,
			scope: 'payments',
			grants: [RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT],
			ttlSeconds: 300,
		})
		const failures: string[] = []
		for (const route of [
			'quote',
			'bind',
			'status',
			'fee-claim',
			'fee-result',
			'refund-claim',
			'refund-result',
			'dispute',
			'pending',
		]) {
			for (const authorization of [
				undefined,
				'Bearer wrong-internal-token-0123456789',
				`Bearer ${operatorToken}`,
			]) {
				const res = await otherApp.request(
					`/api/reservations/payments/${route}`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'x-forwarded-for': '10.20.0.1',
							...(authorization ? { Authorization: authorization } : {}),
						},
						body: JSON.stringify({ orgId: ORG_A }),
					},
				)
				if (res.status !== 401) failures.push(`${route} -> ${res.status}`)
			}
		}
		expect(failures).toEqual([])
	})

	it('POST /internal/reservations/context-changed invalidates the org cache with valid INTERNAL_COMMAND_TOKEN', async () => {
		process.env.APP_URL = 'https://app.menuza.test'
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					orgId: ORG_A,
					dataRegion: 'us',
					features: {
						enabled: true,
						online: true,
						waitlist: true,
						payments: true,
						experiences: false,
						voice: false,
					},
					organization: {
						name: 'Acme A',
						slug: 'acme-a',
						defaultLocale: 'en',
						locales: ['en'],
						siteOrigin: 'https://acme-a.menuza.test',
						sitePublished: true,
						logoUrl: null,
						emailTheme: {
							organizationName: 'Acme A',
							logoUrl: null,
							appUrl: 'https://app.menuza.test',
							background: '#ffffff',
							card: '#f9fafb',
							foreground: '#111827',
							muted: '#f3f4f6',
							mutedForeground: '#6b7280',
							border: '#e5e7eb',
							primary: '#111827',
							primaryForeground: '#ffffff',
							accent: '#2563eb',
							accentForeground: '#ffffff',
							radius: 8,
							headingFont: 'Inter, sans-serif',
							bodyFont: 'Inter, sans-serif',
						},
					},
					locations: [],
					payments: {
						processor: null,
						deposit: false,
						guarantee: false,
						platformFeeBp: 0,
					},
					staffing: {
						enabled: false,
					},
					voice: {
						enabled: false,
					},
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		)
		vi.stubGlobal('fetch', fetchMock)

		const firstCtx = await getReservationsContext(ORG_A)
		expect(firstCtx?.orgId).toBe(ORG_A)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		// Cached before invalidation
		await getReservationsContext(ORG_A)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		const invRes = await otherApp.request(
			'/internal/reservations/context-changed',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${INTERNAL_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ orgId: ORG_A }),
			},
		)
		expect(invRes.status).toBe(200)

		await getReservationsContext(ORG_A)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		vi.unstubAllGlobals()
	})

	it('RESERVATIONS_PUBLIC_ENABLED=false kill switch answers 503 on /reservations/*', async () => {
		process.env.RESERVATIONS_PUBLIC_ENABLED = 'false'
		const res = await otherApp.request('/reservations/config?slug=acme-a', {
			headers: { Origin: 'http://acme-public.menuza.test:3008' },
		})
		expect(res.status).toBe(503)
		await expect(res.json()).resolves.toEqual({ error: 'unavailable' })
		process.env.RESERVATIONS_PUBLIC_ENABLED = 'true'
	})
})

describe('Reservations security sweep: public /reservations/* routes', () => {
	const ORG_PUB = 'org_rsv_sec_public'
	const ORG_OTHER = 'org_rsv_sec_other'
	const ORG_PUB_KSA = 'org_rsv_sec_ksa'
	const PUB_ORIGIN = 'http://acme-public.menuza.test:3008'
	const OTHER_ORIGIN = 'http://other-public.menuza.test:3008'
	const KSA_PUB_ORIGIN = 'http://riyadh-public.menuza.test:3008'
	const DISTINCT_PHONE = 'zz-not-a-phone-zz'
	const DISTINCT_EMAIL = 'not-an-email-zz'
	const DAY = dateAhead(9)

	let dir: string
	const app = new Hono()
	app.route('/reservations', reservationsPublicRoutes)
	const routes = (() => {
		const seen = new Set<string>()
		const list: Array<{ method: string; path: string }> = []
		for (const route of app.routes) {
			if (route.method === 'ALL') continue
			const key = `${route.method} ${route.path}`
			if (seen.has(key)) continue
			seen.add(key)
			list.push({ method: route.method, path: route.path })
		}
		return list
	})()

	function request(
		method: string,
		urlPath: string,
		options: {
			origin?: string | null
			token?: string
			headers?: Record<string, string>
			body?: unknown
		} = {},
	) {
		const headers: Record<string, string> = { ...options.headers }
		if (options.origin !== null) headers.Origin = options.origin ?? PUB_ORIGIN
		if (options.token) headers['X-Reservation-Token'] = options.token
		let body: string | undefined
		if (method !== 'GET' && method !== 'HEAD') {
			headers['Content-Type'] = 'application/json'
			body = JSON.stringify(options.body ?? {})
		}
		return app.request(urlPath, { method, headers, body })
	}

	const withQuery = (routePath: string) =>
		`${routePath}?locationId=${PUBLIC_LOC}&date=${DAY}&partySize=2&from=${DAY}&to=${DAY}`

	async function bookOne(n: number, origin = PUB_ORIGIN, date = DAY) {
		const holdRes = await request('POST', '/reservations/holds', {
			origin,
			body: {
				locationId: PUBLIC_LOC,
				slot: { date, localMin: 19 * 60, partySize: 2 },
			},
		})
		expect(holdRes.status).toBe(201)
		const hold = (await holdRes.json()) as { holdToken: string }
		const res = await request('POST', '/reservations', {
			origin,
			headers: { 'Idempotency-Key': `sweep-key-${n}-abcdefgh` },
			body: {
				holdToken: hold.holdToken,
				guest: {
					firstName: `Sweep${n}`,
					lastName: 'Guest',
					phone: `+1415555${6000 + n}`,
				},
				locale: 'en',
			},
		})
		expect(res.status).toBe(201)
		return (await res.json()) as {
			reservation: { id: string }
			manageToken: string
		}
	}

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-sec-public-'))
		process.env.TENANT_DB_DIR = dir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'sweep-auth-hmac-secret-0123456789abcdef'
		process.env.JWT_SECRET = 'sweep-customer-jwt-secret-0123456789'
		orgs.set(ORG_PUB, {
			id: ORG_PUB,
			slug: 'acme-public',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: 'Acme Public',
		})
		orgs.set(ORG_OTHER, {
			id: ORG_OTHER,
			slug: 'other-public',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: 'Other Public',
		})
		orgs.set(ORG_PUB_KSA, {
			id: ORG_PUB_KSA,
			slug: 'riyadh-public',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'ksa',
			name: 'Riyadh Public',
		})
		resetReservationsContextCache()
		await seedPublicOrg(ORG_PUB)
		await seedPublicOrg(ORG_OTHER)
	})

	beforeEach(() => {
		process.env.RESERVATIONS_PUBLIC_ENABLED = 'true'
		process.env.TURNSTILE_SECRET_KEY = ''
		resetPublicRateLimits()
	})

	afterAll(async () => {
		await destroyTenantDb(ORG_PUB)
		await destroyTenantDb(ORG_OTHER)
		fs.rmSync(dir, { recursive: true, force: true })
		process.env.TURNSTILE_SECRET_KEY = ''
	})

	it('discovers every public route', () => {
		const keys = new Set(routes.map((r) => `${r.method} ${r.path}`))
		for (const expected of [
			'GET /reservations/config',
			'GET /reservations/availability',
			'GET /reservations/calendar',
			'POST /reservations/holds',
			'GET /reservations/holds/current',
			'POST /reservations/holds/release',
			'POST /reservations',
			'POST /reservations/requests',
			'GET /reservations/manage',
			'GET /reservations/manage/availability',
			'POST /reservations/manage/modify',
			'POST /reservations/manage/cancel',
			'POST /reservations/manage/confirm',
			'POST /reservations/manage/late',
			'GET /reservations/manage/calendar.ics',
			'GET /reservations/mine',
			'POST /reservations/waitlist/join',
			'GET /reservations/waitlist/status',
			'POST /reservations/waitlist/status/leave',
			'POST /reservations/waitlist/status/on-my-way',
			'POST /reservations/notify-me',
			'POST /reservations/notify-me/cancel',
			'GET /reservations/experiences',
			'GET /reservations/experiences/:slug',
		]) {
			expect(keys.has(expected), expected).toBe(true)
		}
	})

	it('answers the identical 404 without an Origin binding on every route (VAL-ONLINE-024)', async () => {
		const failures: string[] = []
		const bodies = new Set<string>()
		for (const route of routes) {
			const urlPath = withQuery(route.path.replace(/:[A-Za-z]+/g, 'x'))
			for (const variant of [
				{ origin: null as string | null },
				{ origin: 'http://no-such-org.menuza.test:3008' },
				{ origin: null as string | null, orgIdQuery: true },
			]) {
				const finalPath = variant.orgIdQuery
					? `${urlPath}&orgId=${ORG_PUB}`
					: urlPath
				const res = await request(route.method, finalPath, {
					origin: variant.origin,
				})
				const text = await res.text()
				bodies.add(text)
				if (res.status !== 404) {
					failures.push(`${route.method} ${route.path} -> ${res.status}`)
				}
			}
		}
		expect(failures).toEqual([])
		expect([...bodies]).toEqual([JSON.stringify({ error: 'not_found' })])
	})

	it('fails closed for the wrong region and between organizations (VAL-ONLINE-025)', async () => {
		for (const route of routes) {
			const urlPath = withQuery(route.path.replace(/:[A-Za-z]+/g, 'x'))
			const res = await request(route.method, urlPath, {
				origin: KSA_PUB_ORIGIN,
			})
			expect(res.status, `${route.method} ${route.path}`).toBe(404)
			await expect(res.json()).resolves.toEqual({ error: 'not_found' })
		}
	})

	it('treats forged, cross-org, rotated and expired capability tokens as 404 (VAL-ONLINE-026)', async () => {
		const mine = await bookOne(1)
		const other = await bookOne(2, OTHER_ORIGIN)
		const db = await getTenantDb(ORG_PUB)
		const tokenRoutes: Array<[string, string]> = [
			['GET', '/reservations/manage'],
			['GET', '/reservations/manage/availability'],
			['GET', '/reservations/manage/calendar.ics'],
			['POST', '/reservations/manage/modify'],
			['POST', '/reservations/manage/cancel'],
			['POST', '/reservations/manage/confirm'],
			['POST', '/reservations/manage/late'],
		]
		const forged = `${mine.manageToken.split('.')[0]}.forgedforgedforged`
		const crossOrg = deriveManageToken(ORG_OTHER, mine.reservation.id, 1)
		const otherOrgs = other.manageToken
		const check = async (token: string | undefined) => {
			for (const [method, urlPath] of tokenRoutes) {
				const res = await request(method, urlPath, { token })
				expect(res.status, `${method} ${urlPath}`).toBe(404)
				await expect(res.json()).resolves.toEqual({ error: 'not_found' })
			}
		}
		await check(undefined)
		await check('garbage')
		await check(forged)
		await check(crossOrg)
		await check(otherOrgs)

		const before = await db.select().from(rsvReservations).all()
		await db
			.update(rsvReservations)
			.set({ manageTokenVersion: 2 })
			.where(eq(rsvReservations.id, mine.reservation.id))
		await check(mine.manageToken)
		await db
			.update(rsvReservations)
			.set({
				manageTokenVersion: 1,
				startAt: Date.now() - 9 * 86_400_000,
				endAt: Date.now() - 8 * 86_400_000,
			})
			.where(eq(rsvReservations.id, mine.reservation.id))
		await check(mine.manageToken)
		const after = await db.select().from(rsvReservations).all()
		expect(after.map((r) => r.status)).toEqual(before.map((r) => r.status))

		for (const [method, urlPath] of [
			['GET', '/reservations/holds/current'],
			['POST', '/reservations/holds/release'],
		] as const) {
			for (const token of ['garbage', 'rsv_h_forgedforgedforgedforged']) {
				const res = await request(method, urlPath, { token })
				expect(res.status).toBe(404)
			}
		}
	})

	it('serves published experiences only, behind both flags, with the uniform 404 otherwise (VAL-EXP-013)', async () => {
		const db = await getTenantDb(ORG_PUB)
		const base = {
			orgId: ORG_PUB,
			actorId: 'usr_sweep',
			locationId: PUBLIC_LOC,
		}
		const input = (slug: string) => ({
			slug,
			kind: 'ticketed' as const,
			nameI18n: { en: slug },
			priceMinor: 7500,
			pricePerCover: true,
			partyMin: 1,
			partyMax: 6,
			usesTables: false,
			exclusive: false,
			sort: 0,
		})
		const live = await createExperience(db, {
			...base,
			input: input('sweep-live'),
		})
		await createExperienceSchedule(db, {
			...base,
			experienceId: live.id,
			input: {
				fromDate: DAY,
				toDate: DAY,
				daysMask: 127,
				seatingMins: [19 * 60],
				turnMin: 90,
				coversCapPerSeating: 8,
				areaIds: null,
				serviceId: null,
			},
		})
		await publishExperience(db, { ...base, experienceId: live.id })
		await createExperience(db, { ...base, input: input('sweep-draft') })
		try {
			// experiences off: uniform 404 on both routes.
			for (const urlPath of [
				'/reservations/experiences',
				'/reservations/experiences/sweep-live',
			]) {
				const res = await request('GET', urlPath)
				expect(res.status, urlPath).toBe(404)
				await expect(res.json()).resolves.toEqual({ error: 'not_found' })
			}

			seedReservationsContextForTest(
				ORG_PUB,
				publicContext(ORG_PUB, { experiences: true }),
			)
			const list = await request('GET', '/reservations/experiences')
			expect(list.status).toBe(200)
			expect(list.headers.get('Cache-Control')).toBe('public, max-age=60')
			const body = (await list.json()) as {
				experiences: Array<Record<string, unknown>>
			}
			expect(body.experiences.map((e) => e.slug)).toEqual(['sweep-live'])
			// No drafts, no internals.
			const serialized = JSON.stringify(body)
			for (const secret of [
				'usesTables',
				'exclusive',
				'coversCap',
				'areaIds',
			]) {
				expect(serialized).not.toContain(secret)
			}
			expect(
				(await request('GET', '/reservations/experiences/sweep-draft')).status,
			).toBe(404)
			expect(
				(await request('GET', '/reservations/experiences/sweep-live')).status,
			).toBe(200)
			expect(
				(await request('GET', '/reservations/experiences/Bad_Slug')).status,
			).toBe(404)

			// online off: still the uniform 404 (the public part needs both flags).
			seedReservationsContextForTest(
				ORG_PUB,
				publicContext(ORG_PUB, { experiences: true, online: false }),
			)
			for (const urlPath of [
				'/reservations/experiences',
				'/reservations/experiences/sweep-live',
			]) {
				const res = await request('GET', urlPath)
				expect(res.status, urlPath).toBe(404)
				await expect(res.json()).resolves.toEqual({ error: 'not_found' })
			}

			// Another organization's Origin never sees this organization's catalog.
			seedReservationsContextForTest(
				ORG_PUB,
				publicContext(ORG_PUB, { experiences: true }),
			)
			const other = await request('GET', '/reservations/experiences', {
				origin: OTHER_ORIGIN,
			})
			expect(other.status).toBe(404)
		} finally {
			seedReservationsContextForTest(ORG_PUB, publicContext(ORG_PUB))
		}
	})

	async function enableWaitlist(orgId: string) {
		const db = await getTenantDb(orgId)
		await db
			.update(rsvLocationSettings)
			.set({
				waitlistEnabled: true,
				waitlistOnline: true,
				notifyMeEnabled: true,
			})
			.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
		return db
	}

	const joinBody = (n: number) => ({
		locationId: PUBLIC_LOC,
		name: `Sweep Waiter ${n}`,
		partySize: 2,
		phone: `+1415555${7000 + n}`,
		email: `waiter${n}@example.com`,
	})

	const notifyBody = (n: number) => ({
		locationId: PUBLIC_LOC,
		date: DAY,
		partySize: 2,
		fromLocalMin: 18 * 60,
		toLocalMin: 20 * 60,
		email: `sweep-notify${n}@example.com`,
	})

	it('treats forged, cross-org, rotated and missing waitlist and notify-me tokens as the uniform 404 (VAL-WAIT-014, VAL-WAIT-024)', async () => {
		const db = await enableWaitlist(ORG_PUB)
		await enableWaitlist(ORG_OTHER)
		const join = async (origin: string, n: number) => {
			const res = await request('POST', '/reservations/waitlist/join', {
				origin,
				headers: { 'Idempotency-Key': `wl-sweep-key-${n}-abcdefgh` },
				body: joinBody(n),
			})
			expect(res.status).toBe(201)
			return (await res.json()) as {
				entry: { id: string }
				statusToken: string
			}
		}
		const mine = await join(PUB_ORIGIN, 1)
		const other = await join(OTHER_ORIGIN, 2)
		const notifyRes = await request('POST', '/reservations/notify-me', {
			headers: { 'Idempotency-Key': 'nfy-sweep-key-1-abcdefgh' },
			body: notifyBody(1),
		})
		expect(notifyRes.status).toBe(201)
		const notify = (await notifyRes.json()) as { cancelToken: string }
		const notifyRow = (await db.select().from(rsvNotifyRequests).all())[0]!

		const waitlistRoutes: Array<[string, string]> = [
			['GET', '/reservations/waitlist/status'],
			['POST', '/reservations/waitlist/status/leave'],
			['POST', '/reservations/waitlist/status/on-my-way'],
		]
		const forged = `${mine.statusToken.split('.')[0]}.forgedforgedforged`
		const crossOrg = deriveWaitlistToken(ORG_OTHER, mine.entry.id, 1)
		const check = async (token: string | undefined) => {
			for (const [method, urlPath] of waitlistRoutes) {
				const res = await request(method, urlPath, { token })
				expect(res.status, `${method} ${urlPath}`).toBe(404)
				await expect(res.json()).resolves.toEqual({ error: 'not_found' })
			}
		}
		await check(undefined)
		await check('garbage')
		await check(forged)
		await check(crossOrg)
		await check(other.statusToken)
		await check(notify.cancelToken)
		await check(deriveManageToken(ORG_PUB, mine.entry.id, 1))

		await db
			.update(rsvWaitlistEntries)
			.set({ statusTokenVersion: 2 })
			.where(eq(rsvWaitlistEntries.id, mine.entry.id))
		await check(mine.statusToken)
		await db
			.update(rsvWaitlistEntries)
			.set({ statusTokenVersion: 1, joinedAt: Date.now() - 3 * 86_400_000 })
			.where(eq(rsvWaitlistEntries.id, mine.entry.id))
		await check(mine.statusToken)
		const rows = await db.select().from(rsvWaitlistEntries).all()
		expect(rows.every((r) => r.status === 'waiting')).toBe(true)

		const cancelChecks = [
			undefined,
			'garbage',
			`${notify.cancelToken.split('.')[0]}.forgedforgedforged`,
			deriveNotifyToken(ORG_OTHER, notifyRow.id, 1),
			deriveNotifyToken(ORG_PUB, notifyRow.id, 2),
			mine.statusToken,
		]
		for (const token of cancelChecks) {
			const res = await request('POST', '/reservations/notify-me/cancel', {
				token,
			})
			expect(res.status).toBe(404)
			await expect(res.json()).resolves.toEqual({ error: 'not_found' })
		}
		const crossOrigin = await request(
			'POST',
			'/reservations/notify-me/cancel',
			{
				origin: OTHER_ORIGIN,
				token: notify.cancelToken,
			},
		)
		expect(crossOrigin.status).toBe(404)
		expect((await db.select().from(rsvNotifyRequests).get())?.status).toBe(
			'active',
		)
	})

	it('requires a customer token or Turnstile for waitlist join and notify-me when Turnstile is configured', async () => {
		const db = await enableWaitlist(ORG_PUB)
		const entriesBefore = (await db.select().from(rsvWaitlistEntries).all())
			.length
		const requestsBefore = (await db.select().from(rsvNotifyRequests).all())
			.length
		process.env.TURNSTILE_SECRET_KEY = 'sweep-turnstile-secret-key'
		const join = await request('POST', '/reservations/waitlist/join', {
			headers: { 'Idempotency-Key': 'wl-turnstile-key-abcdefgh' },
			body: joinBody(30),
		})
		expect(join.status).toBe(403)
		await expect(join.json()).resolves.toEqual({ error: 'verification_failed' })
		const notify = await request('POST', '/reservations/notify-me', {
			headers: { 'Idempotency-Key': 'nfy-turnstile-key-abcdefgh' },
			body: notifyBody(30),
		})
		expect(notify.status).toBe(403)
		expect(await db.select().from(rsvWaitlistEntries).all()).toHaveLength(
			entriesBefore,
		)
		expect(await db.select().from(rsvNotifyRequests).all()).toHaveLength(
			requestsBefore,
		)
	})

	it('requires a customer token or Turnstile for holds and requests when Turnstile is configured (VAL-ONLINE-042)', async () => {
		const countsDb = await getTenantDb(ORG_PUB)
		const holdsBefore = (await countsDb.select().from(rsvHolds).all()).length
		const reservationsBefore = (
			await countsDb.select().from(rsvReservations).all()
		).length
		process.env.TURNSTILE_SECRET_KEY = 'sweep-turnstile-secret-key'
		const holdRes = await request('POST', '/reservations/holds', {
			body: {
				locationId: PUBLIC_LOC,
				slot: { date: DAY, localMin: 19 * 60, partySize: 2 },
			},
		})
		expect(holdRes.status).toBe(403)
		await expect(holdRes.json()).resolves.toEqual({
			error: 'verification_failed',
		})
		const requestRes = await request('POST', '/reservations/requests', {
			headers: { 'Idempotency-Key': 'turnstile-key-abcdefgh' },
			body: {
				locationId: PUBLIC_LOC,
				slot: { date: DAY, localMin: 19 * 60, partySize: 12 },
				guest: { firstName: 'T', lastName: 'G', phone: '+14155557001' },
				locale: 'en',
			},
		})
		expect(requestRes.status).toBe(403)
		const db = await getTenantDb(ORG_PUB)
		expect(await db.select().from(rsvHolds).all()).toHaveLength(holdsBefore)
		expect(await db.select().from(rsvReservations).all()).toHaveLength(
			reservationsBefore,
		)
	})

	it('never mutates through GET and never accepts other methods on POST routes (VAL-ONLINE-023)', async () => {
		const target = await bookOne(3, PUB_ORIGIN, dateAhead(11))
		const db = await getTenantDb(ORG_PUB)
		const snapshot = async () =>
			JSON.stringify([
				await db.select().from(rsvReservations).all(),
				await db.select().from(rsvHolds).all(),
			])
		const before = await snapshot()
		for (const route of routes.filter((r) => r.method === 'GET')) {
			await request('GET', withQuery(route.path), { token: target.manageToken })
		}
		for (const route of routes.filter((r) => r.method === 'POST')) {
			const urlPath = `${route.path.replace(/\/$/, '') || '/reservations'}?t=${encodeURIComponent(target.manageToken)}`
			for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
				const res = await request(method, urlPath, {
					token: target.manageToken,
				})
				expect(res.status, `${method} ${route.path}`).toBeGreaterThanOrEqual(
					400,
				)
			}
		}
		expect(await snapshot()).toBe(before)
	})

	it('names invalid fields and never echoes submitted values (VAL-ONLINE-018)', async () => {
		const bad = {
			holdToken: 'rsv_h_validvalidvalidvalid',
			guest: {
				firstName: 'Echo',
				phone: DISTINCT_PHONE,
				email: DISTINCT_EMAIL,
			},
			locale: 'en',
		}
		const targets: Array<[string, unknown]> = [
			['/reservations', bad],
			[
				'/reservations/requests',
				{
					locationId: PUBLIC_LOC,
					slot: { date: DAY, localMin: 1140, partySize: 12 },
					guest: bad.guest,
					locale: 'en',
				},
			],
			[
				'/reservations/holds',
				{
					locationId: PUBLIC_LOC,
					slot: {
						date: DISTINCT_PHONE,
						localMin: DISTINCT_EMAIL,
						partySize: 2,
					},
				},
			],
		]
		for (const [urlPath, body] of targets) {
			const res = await request('POST', urlPath, {
				headers: { 'Idempotency-Key': 'echo-key-abcdefgh' },
				body,
			})
			const text = await res.text()
			expect(res.status, urlPath).toBe(400)
			expect(text).not.toContain(DISTINCT_PHONE)
			expect(text).not.toContain(DISTINCT_EMAIL)
			expect(JSON.parse(text).error).toBe('invalid')
		}
		for (const urlPath of [
			`/reservations/availability?locationId=${PUBLIC_LOC}&date=${DISTINCT_PHONE}&partySize=${DISTINCT_EMAIL}`,
			`/reservations/calendar?locationId=${PUBLIC_LOC}&from=${DISTINCT_PHONE}&to=${DISTINCT_EMAIL}&partySize=2`,
		]) {
			const res = await request('GET', urlPath)
			const text = await res.text()
			expect(res.status).toBe(400)
			expect(text).not.toContain(DISTINCT_PHONE)
			expect(text).not.toContain(DISTINCT_EMAIL)
		}
	})

	it('answers 503 unavailable on every public route when the switch is off (VAL-ONLINE-029)', async () => {
		process.env.RESERVATIONS_PUBLIC_ENABLED = 'false'
		for (const route of routes) {
			const res = await request(route.method, withQuery(route.path), {
				token: 'rsv_m_x.y',
			})
			expect(res.status, `${route.method} ${route.path}`).toBe(503)
			await expect(res.json()).resolves.toEqual({ error: 'unavailable' })
		}
	})
})
