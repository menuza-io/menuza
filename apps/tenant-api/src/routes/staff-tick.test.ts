import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_LABOR_POLICY } from '@repo/staffing'
import {
	destroyTenantDb,
	getTenantDb,
	laborPolicies,
	provisionTenantDb,
	staffMembers,
	timeEntries,
} from '@repo/tenant-db'
import { createTenantApiApp } from '../app.ts'
import {
	INTERNAL_TOKEN,
	mintStaffToken,
	ORG_A,
	ORG_B,
	stubStaffEnv,
} from '../../tests/staff-harness.ts'
import { policyFieldsToColumns } from '../services/labor-policy-service.ts'
import { resetTickLocks } from '../services/staff-tick-service.ts'

const features = vi.hoisted(
	() =>
		new Map<
			string,
			{
				features: {
					enabled: boolean
					timeclock: boolean
					scheduling: boolean
					hiring: boolean
				}
				dataRegion: string | null
			}
		>(),
)
const alerts = vi.hoisted(() => [] as unknown[])

vi.mock('../lib/scope-context.ts', () => ({
	getStaffingFeatures: vi.fn(
		async (orgId: string) => features.get(orgId) ?? null,
	),
	getScopeFacts: vi.fn(async () => ({
		name: 'Downtown',
		timeZone: 'America/Chicago',
	})),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../lib/manager-alerts.ts', () => ({
	sendManagerAlert: vi.fn(async (event: unknown) => {
		alerts.push(event)
		return { status: 'delivered', result: { inApp: 1, emailed: 0 } }
	}),
}))

const ON = {
	features: {
		enabled: true,
		timeclock: true,
		scheduling: false,
		hiring: false,
	},
	dataRegion: 'us',
}

let directory: string
let app: ReturnType<typeof createTenantApiApp>

function post(
	body: unknown,
	options: { token?: string | null; raw?: string } = {},
) {
	const headers: Record<string, string> = { 'content-type': 'application/json' }
	const token = options.token === undefined ? INTERNAL_TOKEN : options.token
	if (token) headers.Authorization = `Bearer ${token}`
	return app.request('/api/staff/tick', {
		method: 'POST',
		headers,
		body: options.raw ?? JSON.stringify(body),
	})
}

async function seedForgottenEntry(orgId: string) {
	const db = await getTenantDb(orgId)
	const [person] = await db
		.insert(staffMembers)
		.values({
			firstName: 'Rana',
			lastName: 'Khalid',
			email: 'rana@example.com',
			status: 'active',
		})
		.returning()
	await db.insert(laborPolicies).values({
		scopeKey: '*',
		scopeId: null,
		...policyFieldsToColumns({
			...BUILTIN_LABOR_POLICY,
			autoClockOutMinutes: 60,
			longShiftMinutes: 600,
		}),
	})
	// Clocked in long ago, so the automatic clock-out is due at any "now".
	const clockInAt = Date.now() - 48 * 60 * 60 * 1000
	await db.insert(timeEntries).values({
		staffId: person!.id,
		scopeId: 'loc-1',
		clockInAt,
		timeZone: 'America/Chicago',
		localDate: '2026-01-01',
		status: 'open',
	})
	return person!
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-tick-route-'))
	stubStaffEnv(directory, 'us')
	vi.stubEnv('STAFFING_EMAIL_ENABLED', '')
	features.clear()
	alerts.length = 0
	resetTickLocks()
	await provisionTenantDb(ORG_A)
	await provisionTenantDb(ORG_B)
	app = createTenantApiApp()
})

afterEach(async () => {
	for (const id of [ORG_A, ORG_B]) {
		await destroyTenantDb(id).catch(() => {})
	}
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

describe('POST /api/staff/tick authentication', () => {
	it('refuses a request with no token, a wrong token, or an operator token', async () => {
		expect((await post({}, { token: null })).status).toBe(401)
		expect(
			(await post({}, { token: 'wrong-token-wrong-token-wrong' })).status,
		).toBe(401)
		const operator = await mintStaffToken({ orgId: ORG_A, scope: 'timeclock' })
		expect((await post({ orgId: ORG_A }, { token: operator })).status).toBe(401)
	})

	it('answers 503 when the internal token is not configured', async () => {
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'short')
		expect((await post({}, { token: 'short' })).status).toBe(503)
	})

	it('is a POST route only', async () => {
		const response = await app.request('/api/staff/tick', {
			method: 'GET',
			headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
		})
		expect(response.status).toBe(404)
	})
})

describe('POST /api/staff/tick body', () => {
	it.each([
		['a malformed org id', { orgId: '../etc/passwd' }],
		['an unknown key', { orgId: ORG_A, force: true }],
		['a non-string org id', { orgId: 42 }],
	])('rejects %s', async (_label, body) => {
		expect((await post(body)).status).toBe(400)
	})
})

describe('POST /api/staff/tick for one organization', () => {
	it('runs the organization and answers counts only', async () => {
		features.set(ORG_A, ON)
		const person = await seedForgottenEntry(ORG_A)
		const response = await post({ orgId: ORG_A })
		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toContain('no-store')
		const body = await response.json()
		expect(body.success).toBe(true)
		expect(body.result).toMatchObject({ orgId: ORG_A, status: 'ran' })
		expect(
			body.result.tasks.find(
				(t: { name: string }) => t.name === 'auto_clock_out',
			),
		).toMatchObject({ closed: 1 })

		const raw = JSON.stringify(body)
		for (const secret of [person.id, 'Rana', 'Khalid', 'rana@example.com']) {
			expect(raw).not.toContain(secret)
		}
		// The manager alert left through the strict contract.
		expect(alerts).toHaveLength(1)
		expect(alerts[0]).toMatchObject({
			orgId: ORG_A,
			kind: 'auto_clock_out',
			count: 1,
		})
	})

	it('does nothing for an organization whose flags are off or unknown', async () => {
		await seedForgottenEntry(ORG_A)
		const unknown = await (await post({ orgId: ORG_A })).json()
		expect(unknown.result).toMatchObject({
			status: 'skipped',
			reason: 'flags_unknown',
		})

		features.set(ORG_A, {
			...ON,
			features: {
				enabled: false,
				timeclock: true,
				scheduling: true,
				hiring: true,
			},
		})
		const off = await (await post({ orgId: ORG_A })).json()
		expect(off.result).toMatchObject({
			status: 'skipped',
			reason: 'staffing_disabled',
		})
		const db = await getTenantDb(ORG_A)
		expect((await db.select().from(timeEntries))[0]!.clockOutAt).toBeNull()
		expect(alerts).toHaveLength(0)
	})

	it('reports an organization this node has no database for', async () => {
		features.set('clw9x0a12000008l00nodb', ON)
		const body = await (await post({ orgId: 'clw9x0a12000008l00nodb' })).json()
		expect(body.result).toMatchObject({
			status: 'skipped',
			reason: 'no_database',
		})
	})
})

describe('POST /api/staff/tick for every organization', () => {
	it('fans out over the node and folds the answers into counts', async () => {
		features.set(ORG_A, ON)
		features.set(ORG_B, ON)
		await seedForgottenEntry(ORG_A)
		// ORG_B has no staff at all: skipped locally, no App lookup.
		const response = await post({})
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body).toMatchObject({
			success: true,
			orgsRan: 1,
			orgsSkipped: 1,
			orgsDeferred: 0,
			closed: 1,
			errors: 0,
		})
		expect(Object.keys(body).sort()).toEqual(
			[
				'closed',
				'errors',
				'managerAlertsSent',
				'orgsDeferred',
				'orgsRan',
				'orgsSkipped',
				'queued',
				'staffEmailSent',
				'success',
			].sort(),
		)
	})

	it('treats an empty body like "everyone"', async () => {
		features.set(ORG_A, ON)
		await seedForgottenEntry(ORG_A)
		const body = await (await post(null, { raw: '' })).json()
		expect(body.orgsRan).toBe(1)
	})
})
