import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
} from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	rsvAuditLog,
	rsvPolicies,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { clearReservationDayCacheForTest } from '../lib/reservations-write.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'
import {
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from './reservations-public-fixture.ts'

const ORG = 'org_pol_us'
const SECRET = 'test-public-operator-secret-key-32-chars-minimum!!'
const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

let tempDir: string
const app = new Hono()
app.route('/operator/reservations', reservationsOperatorRoutes)

async function token(options: { payments?: boolean; grants?: string[] } = {}) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId: ORG,
		region: 'us',
		scope: 'setup',
		grants: options.grants ?? [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
		],
		locationIds: null,
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			experiences: true,
			payments: options.payments ?? true,
			voice: false,
		},
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
		.setSubject('usr_pol')
		.setIssuer(brand.shortName)
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(SECRET))
}

async function call(
	method: string,
	urlPath: string,
	body?: unknown,
	bearer?: string,
) {
	const res = await app.request(`/operator/reservations/setup${urlPath}`, {
		method,
		headers: {
			Authorization: `Bearer ${bearer ?? (await token())}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	return { status: res.status, body: text ? JSON.parse(text) : null }
}

const deposit = {
	name: 'Deposit',
	kind: 'deposit',
	amountMinor: 2500,
	perCover: true,
	freeCancelUntilMin: 1440,
	lateCancelFeeMinor: 5000,
	noShowFeeMinor: 2500,
	feeCapMinor: 10_000,
	refundRule: 'full_before_window',
	termsI18n: { en: 'Terms', ar: 'الشروط' },
}

function useProcessor(processor: 'connect' | null) {
	seedReservationsContextForTest(
		ORG,
		publicContext(ORG, {
			payments: {
				processor,
				deposit: processor !== null,
				guarantee: processor !== null,
			},
		}),
	)
}

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-pol-test-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = SECRET
	process.env.AUTH_HMAC_SECRET = 'test-public-auth-hmac-secret-0123456789'
	resetReservationsContextCache()
	clearReservationDayCacheForTest()
	orgs.set(ORG, {
		id: ORG,
		slug: 'acme',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: 'Acme Bistro',
	})
	await seedPublicOrg(ORG)
	useProcessor('connect')
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('payment policy CRUD (VAL-PAY-012, 013)', () => {
	it('creates a policy with the location currency and terms version 1', async () => {
		const created = await call(
			'POST',
			`/locations/${PUBLIC_LOC}/policies`,
			deposit,
		)
		expect(created.status).toBe(201)
		expect(created.body.policy).toMatchObject({
			kind: 'deposit',
			currency: 'USD',
			termsVersion: 1,
			version: 1,
			amountMinor: 2500,
		})
		const list = await call('GET', `/locations/${PUBLIC_LOC}/policies`)
		expect(list.body.policies).toHaveLength(1)
	})

	it('ignores a client currency by refusing unknown fields', async () => {
		const res = await call('POST', `/locations/${PUBLIC_LOC}/policies`, {
			...deposit,
			currency: 'SAR',
		})
		expect(res.status).toBe(400)
	})

	it('bumps terms_version when terms or amounts change, not for a rename', async () => {
		const { body } = await call(
			'POST',
			`/locations/${PUBLIC_LOC}/policies`,
			deposit,
		)
		const id = body.policy.id
		const renamed = await call(
			'PUT',
			`/locations/${PUBLIC_LOC}/policies/${id}`,
			{
				name: 'Dinner deposit',
				expectedVersion: 1,
			},
		)
		expect(renamed.body.policy).toMatchObject({ termsVersion: 1, version: 2 })
		const terms = await call('PUT', `/locations/${PUBLIC_LOC}/policies/${id}`, {
			termsI18n: { en: 'New terms', ar: 'شروط جديدة' },
			expectedVersion: 2,
		})
		expect(terms.body.policy).toMatchObject({ termsVersion: 2, version: 3 })
		const amount = await call(
			'PUT',
			`/locations/${PUBLIC_LOC}/policies/${id}`,
			{
				amountMinor: 3000,
				expectedVersion: 3,
			},
		)
		expect(amount.body.policy.termsVersion).toBe(3)
		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(rsvPolicies)
			.where(eq(rsvPolicies.id, id))
			.get()
		expect(row!.termsVersion).toBe(3)
	})

	it('refuses a stale version with 409', async () => {
		const { body } = await call(
			'POST',
			`/locations/${PUBLIC_LOC}/policies`,
			deposit,
		)
		const res = await call(
			'PUT',
			`/locations/${PUBLIC_LOC}/policies/${body.policy.id}`,
			{ name: 'x', expectedVersion: 7 },
		)
		expect(res.status).toBe(409)
		expect(res.body.error).toBe('stale_version')
	})

	it('validates amounts, partial refunds and terms without echoing values', async () => {
		for (const bad of [
			{ ...deposit, amountMinor: 0 },
			{ ...deposit, refundRule: 'partial' },
			{ ...deposit, kind: 'deposit', amountMinor: -5 },
			{ ...deposit, termsI18n: { xx: 'nope' } },
		]) {
			const res = await call('POST', `/locations/${PUBLIC_LOC}/policies`, bad)
			expect(res.status).toBe(400)
			expect(JSON.stringify(res.body)).not.toContain('nope')
		}
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvPolicies)).toHaveLength(0)
	})

	it('refuses money kinds when payments is off and keeps none savable', async () => {
		const off = await token({ payments: false })
		const money = await call(
			'POST',
			`/locations/${PUBLIC_LOC}/policies`,
			deposit,
			off,
		)
		expect(money.status).toBe(404)
		const none = await call(
			'POST',
			`/locations/${PUBLIC_LOC}/policies`,
			{ name: 'Open', kind: 'none' },
			off,
		)
		expect(none.status).toBe(201)
	})

	it('refuses a kind the processor cannot take (policy_unavailable)', async () => {
		useProcessor(null)
		const res = await call('POST', `/locations/${PUBLIC_LOC}/policies`, deposit)
		expect(res.status).toBe(409)
		expect(res.body.error).toBe('policy_unavailable')
		useProcessor('connect')
		seedReservationsContextForTest(
			ORG,
			publicContext(ORG, {
				payments: { processor: 'connect', deposit: true, guarantee: false },
			}),
		)
		const guarantee = await call('POST', `/locations/${PUBLIC_LOC}/policies`, {
			name: 'Card',
			kind: 'card_guarantee',
			noShowFeeMinor: 2500,
		})
		expect(guarantee.status).toBe(409)
	})

	it('archives a policy and audits changes without PII', async () => {
		const { body } = await call(
			'POST',
			`/locations/${PUBLIC_LOC}/policies`,
			deposit,
		)
		const del = await call(
			'DELETE',
			`/locations/${PUBLIC_LOC}/policies/${body.policy.id}`,
		)
		expect(del.status).toBe(200)
		const list = await call('GET', `/locations/${PUBLIC_LOC}/policies`)
		expect(list.body.policies).toHaveLength(0)
		const db = await getTenantDb(ORG)
		const audit = await db.select().from(rsvAuditLog)
		expect(audit.map((a) => a.action).sort()).toEqual([
			'policy.archive',
			'policy.create',
		])
	})

	it('supports the upsert shape PUT /policies', async () => {
		const created = await call('PUT', '/policies', {
			locationId: PUBLIC_LOC,
			...deposit,
		})
		expect(created.status).toBe(201)
		const updated = await call('PUT', '/policies', {
			locationId: PUBLIC_LOC,
			policyId: created.body.policy.id,
			name: 'Renamed',
			expectedVersion: 1,
		})
		expect(updated.body.policy.name).toBe('Renamed')
	})

	it('needs the settings grants and the location scope', async () => {
		const readOnly = await token({
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS],
		})
		expect(
			(
				await call(
					'POST',
					`/locations/${PUBLIC_LOC}/policies`,
					deposit,
					readOnly,
				)
			).status,
		).toBe(403)
		const elsewhere = await call(
			'POST',
			'/locations/loc_other/policies',
			deposit,
		)
		expect([403, 404]).toContain(elsewhere.status)
	})
})
