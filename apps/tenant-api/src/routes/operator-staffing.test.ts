import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand.ts'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	staffEvents,
	staffMembers,
} from '@repo/tenant-db'
import { operatorStaffingRoutes } from './operator-staffing.ts'

const orgA = 'clw9x0a12000008l0staff01'
const orgB = 'clw9x0a12000008l0staff02'
const orgKsa = 'clw9x0a12000008l0staff03'
const operatorSecret = 'test-operator-token-staffing-123'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(async (id: string) => ({
		id,
		slug: id,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: id === orgKsa ? 'ksa' : 'us',
	})),
}))

const LOCATIONS = [
	{ id: 'loc_main', tz: 'America/New_York' },
	{ id: 'loc_second', tz: 'America/Chicago' },
]

type Claims = Record<string, unknown>

async function mint(claims: Claims = {}, options: { secret?: string } = {}) {
	return new SignJWT({
		orgId: orgA,
		role: 'operator',
		scope: 'staffing',
		areas: { staff: 'write' },
		locationIds: null,
		locations: LOCATIONS,
		...claims,
	})
		.setSubject((claims.sub as string | undefined) ?? 'user_manager')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience((claims.aud as string | undefined) ?? 'tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(options.secret ?? operatorSecret))
}

describe('operator staffing roster', () => {
	let tempDir: string
	let app: Hono

	async function call(
		method: string,
		pathname: string,
		token: string | null,
		body?: unknown,
	) {
		const headers: Record<string, string> = {}
		if (token) headers.Authorization = `Bearer ${token}`
		if (body !== undefined) headers['Content-Type'] = 'application/json'
		const response = await app.request(pathname, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		return {
			status: response.status,
			cache: response.headers.get('Cache-Control'),
			body: (await response.json()) as Record<string, any>,
		}
	}

	async function createPosition(token: string, name = 'Server') {
		const result = await call('POST', '/positions', token, {
			name,
			colorKey: 'blue',
		})
		expect(result.status).toBe(200)
		return result.body.position.id as string
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-staffing-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.NODE_ENV = 'test'
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		await provisionTenantDb(orgA)
		await provisionTenantDb(orgB)
		app = new Hono()
		app.route('/', operatorStaffingRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgA)
		await destroyTenantDb(orgB)
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('creates, lists, edits, terminates, and rehires staff with an audit trail', async () => {
		const token = await mint()
		const positionId = await createPosition(token)
		const created = await call('POST', '/staff', token, {
			firstName: 'Ana',
			lastName: 'Diaz',
			email: 'ANA@example.com',
			phone: '+1 555 0100',
			assignments: [{ locationId: 'loc_main', positionId }],
		})
		expect(created.status).toBe(200)
		expect(created.cache).toBe('private, no-store')
		expect(created.body.staff).toMatchObject({
			firstName: 'Ana',
			email: 'ana@example.com',
			status: 'active',
			hasPin: false,
			assignments: [{ locationId: 'loc_main', positionId, isPrimary: true }],
		})
		const id = created.body.staff.id as string

		const updated = await call('PATCH', `/staff/${id}`, token, {
			firstName: 'Ana',
			lastName: 'Diaz-Lopez',
			assignments: [],
		})
		expect(updated.body.staff.lastName).toBe('Diaz-Lopez')
		expect(updated.body.staff.assignments).toEqual([])

		const terminated = await call('POST', `/staff/${id}/terminate`, token, {
			terminatedOn: '2026-10-01',
			reason: 'Moved away',
		})
		expect(terminated.body.staff).toMatchObject({
			status: 'terminated',
			terminatedOn: '2026-10-01',
		})
		expect(
			(
				await call('POST', `/staff/${id}/terminate`, token, {
					terminatedOn: '2026-10-02',
				})
			).status,
		).toBe(409)

		const active = await call('GET', '/staff?status=active', token)
		expect(active.body.staff).toHaveLength(0)
		const rehired = await call('POST', `/staff/${id}/rehire`, token)
		expect(rehired.body.staff.status).toBe('active')

		const events = await call('GET', `/staff/${id}/events`, token)
		expect(
			events.body.events.map((event: { kind: string }) => event.kind),
		).toEqual([
			'staff.rehired',
			'staff.terminated',
			'staff.updated',
			'staff.created',
		])
		expect(events.body.events[0].actorRef).toBe('user_manager')
	})

	it('imports pasted rows in one transaction, creating positions by name', async () => {
		const token = await mint()
		await createPosition(token, 'Cook')
		const result = await call('POST', '/staff/import', token, {
			locationId: 'loc_main',
			text: 'Name, Email, Phone, Position\nAna Diaz, ana@example.com, , cook\nBo Li,, +1 555 0101, Host',
		})
		expect(result.status).toBe(200)
		expect(result.body.result).toEqual({
			created: 2,
			skippedExisting: [],
			createdPositions: ['Host'],
		})
		const again = await call('POST', '/staff/import', token, {
			locationId: 'loc_main',
			text: 'Ana Diaz, ana@example.com',
		})
		expect(again.body.result).toMatchObject({
			created: 0,
			skippedExisting: [1],
		})
	})

	it('rolls back an import that fails part way through', async () => {
		const token = await mint()
		const result = await call('POST', '/staff/import', token, {
			locationId: 'loc_main',
			createPositions: false,
			text: 'Ana Diaz,,,\nBo Li,,,Ghost position',
		})
		expect(result.status).toBe(400)
		expect(result.body.error).toBe('unknown_position')
		const db = await getTenantDb(orgA)
		expect(await db.select().from(staffMembers)).toHaveLength(0)
	})

	it('rejects malformed paste rows instead of guessing', async () => {
		const token = await mint()
		const result = await call('POST', '/staff/import', token, {
			locationId: 'loc_main',
			text: 'Ana, not-an-email',
		})
		expect(result.body.error).toBe('invalid_rows')
	})

	it('keeps position names unique and protects archived positions', async () => {
		const token = await mint()
		const positionId = await createPosition(token, 'Server')
		expect(
			(await call('POST', '/positions', token, { name: 'server' })).status,
		).toBe(409)
		await call('PATCH', `/positions/${positionId}`, token, { archived: true })
		const blocked = await call('POST', '/staff', token, {
			firstName: 'Ana',
			assignments: [{ locationId: 'loc_main', positionId }],
		})
		expect(blocked.body.error).toBe('position_archived')
	})

	it('saves regional settings', async () => {
		const token = await mint()
		const saved = await call('PUT', '/settings', token, {
			weekStart: 'sunday',
			weeklyHoursThreshold: 48,
			lateGraceMinutes: 10,
		})
		expect(saved.status).toBe(200)
		const context = await call('GET', '/context', token)
		expect(context.body.settings).toEqual({
			weekStart: 'sunday',
			weeklyHoursThreshold: 48,
			lateGraceMinutes: 10,
		})
	})

	describe('adversarial', () => {
		it('rejects missing, forged, and wrong-audience tokens', async () => {
			expect((await call('GET', '/staff', null)).status).toBe(401)
			expect(
				(
					await call(
						'GET',
						'/staff',
						await mint({}, { secret: 'x'.repeat(32) }),
					)
				).status,
			).toBe(401)
			expect(
				(await call('GET', '/staff', await mint({ aud: 'tenant-api' }))).status,
			).toBe(401)
		})

		it('refuses tokens minted for other operator scopes', async () => {
			for (const scope of [
				'orders:write',
				'mailbox',
				'phone_calls',
				undefined,
			]) {
				const result = await call('GET', '/staff', await mint({ scope }))
				expect(result.status).toBe(403)
			}
		})

		it('refuses non-operator roles and unknown areas', async () => {
			expect(
				(await call('GET', '/staff', await mint({ role: 'customer' }))).status,
			).toBe(403)
			expect(
				(
					await call(
						'GET',
						'/staff',
						await mint({ areas: { payroll: 'write' } }),
					)
				).status,
			).toBe(403)
		})

		it('never lets a read claim write', async () => {
			const token = await mint({ areas: { staff: 'read' } })
			expect((await call('GET', '/staff', token)).status).toBe(200)
			const write = await call('POST', '/staff', token, { firstName: 'Ana' })
			expect(write.status).toBe(403)
			const db = await getTenantDb(orgA)
			expect(await db.select().from(staffEvents)).toHaveLength(0)
		})

		it('does not let a schedule-only token read the roster', async () => {
			const token = await mint({ areas: { schedule: 'write' } })
			expect((await call('GET', '/staff', token)).status).toBe(403)
		})

		it('isolates organizations by database, not by request input', async () => {
			const tokenA = await mint()
			await call('POST', '/staff', tokenA, { firstName: 'Ana' })
			const tokenB = await mint({ orgId: orgB })
			const listB = await call('GET', '/staff', tokenB)
			expect(listB.body.staff).toEqual([])
			const [member] = await (
				await getTenantDb(orgA)
			)
				.select()
				.from(staffMembers)
			const crossOrg = await call('PATCH', `/staff/${member!.id}`, tokenB, {
				firstName: 'Mallory',
			})
			expect(crossOrg.status).toBe(404)
		})

		it('fails closed when the organization belongs to another region', async () => {
			const result = await call('GET', '/staff', await mint({ orgId: orgKsa }))
			expect(result.status).toBe(409)
			expect(result.body.error).toBe('region_mismatch')
		})

		it('rejects locations missing from the signed location list', async () => {
			const token = await mint()
			const positionId = await createPosition(token)
			const result = await call('POST', '/staff', token, {
				firstName: 'Ana',
				assignments: [{ locationId: 'loc_other_org', positionId }],
			})
			expect(result.body.error).toBe('unknown_location')
			const imported = await call('POST', '/staff/import', token, {
				locationId: 'loc_other_org',
				text: 'Ana',
			})
			expect(imported.body.error).toBe('unknown_location')
		})

		it('scopes visibility and edits to the token’s locations', async () => {
			const admin = await mint()
			const positionId = await createPosition(admin)
			const second = await call('POST', '/staff', admin, {
				firstName: 'Second',
				assignments: [{ locationId: 'loc_second', positionId }],
			})
			const both = await call('POST', '/staff', admin, {
				firstName: 'Both',
				assignments: [
					{ locationId: 'loc_main', positionId },
					{ locationId: 'loc_second', positionId },
				],
			})
			const scoped = await mint({ locationIds: ['loc_main'] })
			const list = await call('GET', '/staff', scoped)
			expect(
				list.body.staff.map((staff: { firstName: string }) => staff.firstName),
			).toEqual(['Both'])
			expect(
				(
					await call('PATCH', `/staff/${second.body.staff.id}`, scoped, {
						firstName: 'Hijack',
					})
				).status,
			).toBe(404)
			// Editing from a scoped token keeps assignments it cannot see.
			const edited = await call(
				'PATCH',
				`/staff/${both.body.staff.id}`,
				scoped,
				{
					firstName: 'Both',
					assignments: [],
				},
			)
			expect(edited.body.staff.assignments).toEqual([
				{ locationId: 'loc_second', positionId, isPrimary: true },
			])
			expect(
				(await call('POST', '/staff', scoped, { firstName: 'Nowhere' })).body
					.error,
			).toBe('assignment_required')
		})

		it('validates input with zod and never stores unknown fields', async () => {
			const token = await mint()
			const bad = await call('POST', '/staff', token, {
				firstName: '',
				email: 'nope',
			})
			expect(bad.status).toBe(400)
			const created = await call('POST', '/staff', token, {
				firstName: 'Ana',
				pinHash: 'attacker',
				status: 'terminated',
			})
			expect(created.body.staff.status).toBe('active')
			expect(created.body.staff).not.toHaveProperty('pinHash')
		})
	})
})
