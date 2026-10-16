import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_SCOPES,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	type ReservationsScope,
} from '@repo/reservations'
import {
	destroyTenantDb,
	provisionTenantDb,
	rsvGuests,
	rsvLocationSettings,
} from '@repo/tenant-db'
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
} from '../lib/reservations-context.ts'
import {
	reservationsInternalRoutes,
	reservationsTickRoutes,
	reservationsVoiceActionRoutes,
} from './reservations-internal.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'
import { reservationsPublicRoutes } from './reservations-public.ts'

const SECRET = 'reservations-security-test-secret-0123456789'
const INTERNAL_TOKEN = 'internal-command-token-0123456789'
const VOICE_TOKEN = 'voice-agent-secret-token-0123456789abcdef'

const ORG_A = 'org_rsv_sec_a'
const ORG_B = 'org_rsv_sec_b'
const ORG_KSA = 'org_rsv_sec_ksa'

const LOC_1 = 'loc_downtown'
const LOC_2 = 'loc_uptown'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
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
}) {
	const now = Math.floor(Date.now() / 1000)
	const ttl = overrides?.ttlSeconds ?? 300
	return new jose.SignJWT({
		role: 'operator',
		orgId: overrides?.orgId ?? ORG_A,
		region: overrides?.region ?? 'us',
		scope: overrides?.scope ?? 'book',
		grants: overrides?.grants ?? [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
		],
		locationIds:
			overrides?.locationIds === undefined ? null : overrides.locationIds,
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			payments: true,
			experiences: true,
			voice: false,
		},
		impersonated: overrides?.impersonated ?? false,
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

	it('refuses a token signed with wrong secret, wrong audience, or wrong typ (401)', async () => {
		const wrongSecret = await mintRsvToken({
			signingKey: `${SECRET}-mismatch`,
		})
		const wrongAudience = await mintRsvToken({
			audience: 'tenant-api-staffing',
		})
		const wrongTyp = await mintRsvToken({
			typ: 'JWT',
		})
		const failures: string[] = []
		for (const route of list) {
			for (const token of [wrongSecret, wrongAudience, wrongTyp]) {
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

	it('enforces cross-org and cross-location isolation across operator routes', async () => {
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

		// 1. Cross-org: ORG_A token never sees ORG_B guests
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

		// 2. Cross-location: token scoped to [LOC_1] cannot read or write LOC_2
		const scopedBookToken = await mintRsvToken({
			orgId: ORG_A,
			scope: 'book',
			grants: [
				RESERVATIONS_PERMISSIONS.READ_RESERVATION,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
			],
			locationIds: [LOC_1],
		})

		const allowedLocRes = await app.request(
			`/operator/reservations/book/day?locationId=${LOC_1}&date=2026-07-15`,
			{
				headers: { Authorization: `Bearer ${scopedBookToken}` },
			},
		)
		expect(allowedLocRes.status).toBe(200)

		const forbiddenLocRes = await app.request(
			`/operator/reservations/book/day?locationId=${LOC_2}&date=2026-07-15`,
			{
				headers: { Authorization: `Bearer ${scopedBookToken}` },
			},
		)
		expect(forbiddenLocRes.status).toBe(403)

		// 3. Overview filters out LOC_2 when token is scoped to [LOC_1]
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
})

describe('Reservations security sweep: mounts and non-operator surfaces', () => {
	const appSource = fs.readFileSync(path.join(SRC, 'app.ts'), 'utf8')
	const otherApp = new Hono()
	for (const [prefix, router] of Object.entries(OTHER_MOUNTS)) {
		otherApp.route(prefix, router)
	}

	beforeEach(() => {
		resetReservationsContextCache()
		delete process.env.RESERVATIONS_PUBLIC_ENABLED
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
		const res = await otherApp.request('/reservations/config?slug=acme-a')
		expect(res.status).toBe(503)
	})
})
