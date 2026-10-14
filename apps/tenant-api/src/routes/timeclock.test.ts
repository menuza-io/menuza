import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import {
	kioskDevices,
	kioskPairingCodes,
	laborPolicies,
	staffAuditLog,
} from '@repo/tenant-db'
import {
	CLOCK_ADMIN_GRANTS,
	CLOCK_READ_GRANTS,
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	ORG_B,
	type ClockHarness,
} from '../../tests/timeclock-harness.ts'
import {
	makeOrg,
	mintStaffToken,
	type TestOrg,
} from '../../tests/staff-harness.ts'

const facts = vi.hoisted(
	() => new Map<string, { name: string; timeZone: string }>(),
)
const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(
		async (_org: string, scope: string) => facts.get(scope) ?? null,
	),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

describe('/operator/timeclock', () => {
	let h: ClockHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: 'America/Chicago' })
		facts.set(LOC_2, { name: 'Airport', timeZone: 'America/Toronto' })
		h = await createClockHarness([ORG_A, ORG_B])
	})
	afterEach(async () => {
		await h.cleanup()
	})

	describe('labor policy', () => {
		it('answers the built-in neutral policy before anything is saved', async () => {
			const response = await h.operator('GET', `/policies/${LOC_1}`)
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({
				source: 'builtin',
				scopeId: LOC_1,
				weekStartsOn: 1,
				dailyOvertime: null,
				weeklyOvertime: null,
				timesheetApprovalMode: 'none',
				aggregateOvertimeAcrossScopes: null,
				version: 1,
			})
		})

		it('creates a scope policy and bumps the version on every change', async () => {
			const created = await h.operator('PUT', `/policies/${LOC_1}`, {
				body: {
					lateGraceMinutes: 10,
					weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 15000 },
				},
			})
			expect(created.status).toBe(200)
			expect(created.body).toMatchObject({
				source: 'scope',
				version: 1,
				lateGraceMinutes: 10,
				weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 15000 },
			})

			const updated = await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { expectedVersion: 1, preventEarlyMinutes: 15 },
			})
			expect(updated.status).toBe(200)
			expect(updated.body.version).toBe(2)
			expect(updated.body.preventEarlyMinutes).toBe(15)
			// Fields not in the patch keep their values.
			expect(updated.body.lateGraceMinutes).toBe(10)

			const read = await h.operator('GET', `/policies/${LOC_1}`)
			expect(read.body.version).toBe(2)
		})

		it('refuses a stale version and an update without one', async () => {
			await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { lateGraceMinutes: 7 },
			})
			const stale = await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { expectedVersion: 5, lateGraceMinutes: 9 },
			})
			expect(stale.status).toBe(409)
			expect(stale.body).toMatchObject({
				error: 'stale_version',
				currentVersion: 1,
			})
			const missing = await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { lateGraceMinutes: 9 },
			})
			expect(missing.status).toBe(409)
			const read = await h.operator('GET', `/policies/${LOC_1}`)
			expect(read.body.lateGraceMinutes).toBe(7)
		})

		it('two managers saving at once cannot both win', async () => {
			await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { lateGraceMinutes: 1 },
			})
			const [a, b] = await Promise.all([
				h.operator('PUT', `/policies/${LOC_1}`, {
					body: { expectedVersion: 1, lateGraceMinutes: 2 },
				}),
				h.operator('PUT', `/policies/${LOC_1}`, {
					body: { expectedVersion: 1, lateGraceMinutes: 3 },
				}),
			])
			expect([a.status, b.status].sort()).toEqual([200, 409])
			const read = await h.operator('GET', `/policies/${LOC_1}`)
			expect(read.body.version).toBe(2)
		})

		it('seeds a new scope policy from the organization default', async () => {
			const created = await h.operator('PUT', '/policies/default', {
				body: { lateGraceMinutes: 12, weekStartsOn: 0 },
			})
			expect(created.status).toBe(200)
			expect(created.body).toMatchObject({
				source: 'default',
				scopeId: null,
			})

			const effective = await h.operator('GET', `/policies/${LOC_2}`)
			expect(effective.body).toMatchObject({
				source: 'default',
				lateGraceMinutes: 12,
				weekStartsOn: 0,
			})

			const own = await h.operator('PUT', `/policies/${LOC_2}`, {
				body: { preventEarlyMinutes: 20 },
			})
			expect(own.body).toMatchObject({
				source: 'scope',
				lateGraceMinutes: 12,
				weekStartsOn: 0,
				preventEarlyMinutes: 20,
			})
		})

		it('lists the default and the scope policies', async () => {
			await h.operator('PUT', '/policies/default', {
				body: { lateGraceMinutes: 3 },
			})
			await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { lateGraceMinutes: 4 },
			})
			const list = await h.operator('GET', '/policies')
			expect(list.status).toBe(200)
			expect(list.body.default.lateGraceMinutes).toBe(3)
			expect(list.body.scopes.map((p: any) => p.scopeId)).toEqual([LOC_1])
		})

		it('rejects invalid values with codes and no echoed input', async () => {
			for (const body of [
				{ nope: 1 },
				{ weekStartsOn: 9 },
				{ timeZone: 'Mars/Base' },
				{ rounding: { mode: 'up', incrementMinutes: 0 } },
				{ dailyOvertime: { thresholdMinutes: 480, multiplierBp: 100 } },
				{ lateGraceMinutes: 'ten' },
				{ aggregateOvertimeAcrossScopes: 'yes' },
			]) {
				const response = await h.operator('PUT', `/policies/${LOC_1}`, { body })
				expect(response.status, JSON.stringify(body)).toBe(400)
				expect(response.raw).not.toContain('Mars/Base')
			}
			const bad = await h.operator('PUT', `/policies/${LOC_1}`, {
				body: {
					dailyOvertime: { thresholdMinutes: 600, multiplierBp: 15000 },
					dailyDoubleTime: { thresholdMinutes: 500, multiplierBp: 20000 },
				},
			})
			expect(bad.status).toBe(422)
			expect(bad.body.problems).toEqual([
				{ path: 'dailyDoubleTime', code: 'double_time_before_overtime' },
			])
			const geofence = await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { geofence: { mode: 'block', radiusMeters: null } },
			})
			expect(geofence.status).toBe(422)
			const unknownPack = await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { rulePack: 'made-up' },
			})
			expect(unknownPack.status).toBe(422)
			expect(unknownPack.body.problems[0].code).toBe('unknown_rule_pack')
		})

		it('refuses malformed scope ids and the reserved word as a scope', async () => {
			for (const id of ['a b', 'x'.repeat(65), '%2e%2e']) {
				const response = await h.operator('GET', `/policies/${id}`)
				expect(response.status).toBe(404)
			}
		})

		it('requires the overtime aggregation choice while people work at several scopes', async () => {
			const db = await h.db(ORG_A)
			void db
			await h.seedStaff(ORG_A, { scopeIds: [LOC_1, LOC_2] })

			const before = await h.operator('GET', `/policies/${LOC_1}`)
			expect(before.body.aggregateDecisionRequired).toBe(true)

			const refused = await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { lateGraceMinutes: 5 },
			})
			expect(refused.status).toBe(422)
			expect(refused.body.error).toBe('aggregate_overtime_required')

			const accepted = await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { aggregateOvertimeAcrossScopes: false },
			})
			expect(accepted.status).toBe(200)
			expect(accepted.body.aggregateDecisionRequired).toBe(false)

			// A scope with nobody who works elsewhere is not forced to choose.
			const other = await h.operator('PUT', `/policies/loc-9`, {
				body: { lateGraceMinutes: 5 },
			})
			expect(other.status).toBe(200)
		})

		it('writes an audit row with only the changed fields and no staff data', async () => {
			await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { lateGraceMinutes: 9 },
			})
			await h.operator('PUT', `/policies/${LOC_1}`, {
				body: {
					expectedVersion: 1,
					lateGraceMinutes: 9,
					preventEarlyMinutes: 30,
				},
			})
			const db = await h.db(ORG_A)
			const rows = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.entityType, 'labor_policy'))
			expect(rows.map((r) => r.action).sort()).toEqual([
				'labor_policy.created',
				'labor_policy.updated',
			])
			const updated = rows.find((r) => r.action === 'labor_policy.updated')!
			expect(updated.actorId).toBe('operator-1')
			expect(updated.scopeId).toBe(LOC_1)
			expect((updated.changes as any).fields).toEqual({
				preventEarlyMinutes: { before: null, after: 30 },
			})
		})

		it('does not require a scope row to be in scope for the default read', async () => {
			const response = await h.operator('GET', '/policies/default', {
				scopeIds: [LOC_2],
			})
			expect(response.status).toBe(200)
			expect(response.body.policy).toBeNull()
		})
	})

	describe('authorization', () => {
		it('rejects missing, invalid and wrong-scope tokens', async () => {
			expect(
				(await h.operator('GET', '/policies', { token: null })).status,
			).toBe(401)
			expect(
				(await h.operator('GET', '/policies', { token: 'junk' })).status,
			).toBe(401)
			const staffScope = await mintStaffToken({
				scope: 'staff',
				grants: CLOCK_ADMIN_GRANTS,
			})
			const wrong = await h.operator('GET', '/policies', { token: staffScope })
			expect(wrong.status).toBe(403)
		})

		it('needs the labor policy grant to read and the update grant to write', async () => {
			const none = await h.operator('GET', '/policies', {
				grants: [P.READ_STAFF],
			})
			expect(none.status).toBe(403)
			const read = await h.operator('GET', '/policies', {
				grants: CLOCK_READ_GRANTS,
			})
			expect(read.status).toBe(200)
			const write = await h.operator('PUT', `/policies/${LOC_1}`, {
				grants: CLOCK_READ_GRANTS,
				body: { lateGraceMinutes: 3 },
			})
			expect(write.status).toBe(403)
			expect(write.body.required).toBe('update:labor_policy:any')
			// The update grant alone satisfies the matching read.
			const updateOnly = await h.operator('GET', '/policies', {
				grants: [P.UPDATE_LABOR_POLICY],
			})
			expect(updateOnly.status).toBe(200)
		})

		it('does not accept a pay or schedule grant in place of the policy grant', async () => {
			const response = await h.operator('PUT', `/policies/${LOC_1}`, {
				grants: [
					P.UPDATE_STAFF_PAY,
					P.UPDATE_SCHEDULE,
					P.UPDATE_TIMESHEET,
					P.READ_LABOR,
				],
				body: { lateGraceMinutes: 3 },
			})
			expect(response.status).toBe(403)
		})

		it('impersonated sessions are read-only and cannot pair kiosks', async () => {
			const read = await h.operator('GET', '/policies', { impersonated: true })
			expect(read.status).toBe(200)
			const write = await h.operator('PUT', `/policies/${LOC_1}`, {
				impersonated: true,
				body: { lateGraceMinutes: 3 },
			})
			expect(write.status).toBe(403)
			const pair = await h.operator('POST', '/kiosk/pairing-codes', {
				impersonated: true,
				body: { scopeId: LOC_1, deviceName: 'Tablet' },
			})
			expect(pair.status).toBe(403)
		})

		it('a scoped manager sees and changes only their scopes, and gets 404 elsewhere', async () => {
			await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { lateGraceMinutes: 4 },
			})
			await h.operator('PUT', `/policies/${LOC_2}`, {
				body: { lateGraceMinutes: 6 },
			})

			const list = await h.operator('GET', '/policies', {
				scopeIds: [LOC_2],
			})
			expect(list.body.scopes.map((p: any) => p.scopeId)).toEqual([LOC_2])

			const read = await h.operator('GET', `/policies/${LOC_1}`, {
				scopeIds: [LOC_2],
			})
			expect(read.status).toBe(404)
			const write = await h.operator('PUT', `/policies/${LOC_1}`, {
				scopeIds: [LOC_2],
				body: { expectedVersion: 1, lateGraceMinutes: 1 },
			})
			expect(write.status).toBe(404)
			const own = await h.operator('PUT', `/policies/${LOC_2}`, {
				scopeIds: [LOC_2],
				body: { expectedVersion: 1, lateGraceMinutes: 8 },
			})
			expect(own.status).toBe(200)
			const none = await h.operator('GET', '/policies', { scopeIds: [] })
			expect(none.body.scopes).toEqual([])
		})

		it('only an unrestricted token may change the organization default', async () => {
			const scoped = await h.operator('PUT', '/policies/default', {
				scopeIds: [LOC_1],
				body: { lateGraceMinutes: 4 },
			})
			expect(scoped.status).toBe(403)
			expect(scoped.body.error).toBe('unrestricted_scope_required')
		})

		it('a scoped manager cannot widen their scope through a request field', async () => {
			const response = await h.operator('PUT', `/policies/${LOC_1}`, {
				scopeIds: [LOC_2],
				body: { scopeIds: null, lateGraceMinutes: 4 },
			})
			expect(response.status).toBe(400)
			const smuggled = await h.operator('POST', '/kiosk/pairing-codes', {
				scopeIds: [LOC_2],
				body: { scopeId: LOC_1, deviceName: 'x', orgId: ORG_B },
			})
			expect(smuggled.status).toBe(400)
		})

		it('rejects a token minted for another organization at this organization', async () => {
			const tokenForB = await mintStaffToken({
				orgId: ORG_B,
				scope: 'timeclock',
				grants: CLOCK_ADMIN_GRANTS,
			})
			await h.operator('PUT', `/policies/${LOC_1}`, {
				token: tokenForB,
				body: { lateGraceMinutes: 2 },
			})
			// It acted on B only: A's database is untouched.
			const dbA = await h.db(ORG_A)
			expect(await dbA.select().from(laborPolicies)).toHaveLength(0)
			const dbB = await h.db(ORG_B)
			expect(await dbB.select().from(laborPolicies)).toHaveLength(1)
		})
	})

	describe('kiosk pairing and devices', () => {
		const createCode = (body: Record<string, unknown> = {}, extra = {}) =>
			h.operator('POST', '/kiosk/pairing-codes', {
				body: { scopeId: LOC_1, deviceName: 'Front counter', ...body },
				...extra,
			})

		it('creates a one-time code that is stored only as a hash', async () => {
			const created = await createCode()
			expect(created.status).toBe(201)
			expect(created.body.code).toMatch(/^kpc1\./)
			expect(created.body.code).toContain(ORG_A)
			expect(created.body.fragment).toContain('#r=us&c=')
			expect(created.body.expiresAt - h.clock.now).toBeGreaterThan(0)

			const db = await h.db(ORG_A)
			const [row] = await db.select().from(kioskPairingCodes)
			expect(row!.codeHash).not.toContain(created.body.code)
			expect(JSON.stringify(row)).not.toContain(created.body.code)
			expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/)

			const pending = await h.operator('GET', '/kiosk/pairing-codes')
			expect(pending.body.codes).toHaveLength(1)
			expect(pending.raw).not.toContain(created.body.code)
			expect(pending.raw).not.toContain(row!.codeHash)
		})

		it('uses the control plane time zone, then the manager value, else refuses', async () => {
			facts.delete(LOC_1)
			const none = await h.operator('POST', '/kiosk/pairing-codes', {
				body: { scopeId: LOC_1, deviceName: 'Tablet' },
			})
			expect(none.status).toBe(422)
			expect(none.body.error).toBe('time_zone_required')
			const provided = await createCode({ timeZone: 'America/Denver' })
			expect(provided.status).toBe(201)
			const db = await h.db(ORG_A)
			const [row] = await db.select().from(kioskPairingCodes)
			expect(row!.timeZone).toBe('America/Denver')
		})

		it('caps pending codes per scope', async () => {
			for (let i = 0; i < 10; i++) expect((await createCode()).status).toBe(201)
			const eleventh = await createCode()
			expect(eleventh.status).toBe(409)
			expect(eleventh.body.error).toBe('too_many_pending_codes')
			// Another scope is unaffected.
			expect((await createCode({ scopeId: LOC_2 })).status).toBe(201)
		})

		it('cancels a pending code, which can then never be redeemed', async () => {
			const created = await createCode()
			const cancelled = await h.operator(
				'DELETE',
				`/kiosk/pairing-codes/${created.body.id}`,
			)
			expect(cancelled.status).toBe(200)
			const redeem = await h.kiosk('POST', '/pair', {
				body: { code: created.body.code },
			})
			expect(redeem.status).toBe(401)
			expect(redeem.body.error).toBe('invalid_pairing_code')
			const again = await h.operator(
				'DELETE',
				`/kiosk/pairing-codes/${created.body.id}`,
			)
			expect(again.status).toBe(404)
		})

		it('lists, renames and revokes devices; revocation is idempotent', async () => {
			const { deviceId } = await h.pair(ORG_A, LOC_1, { name: 'Bar' })
			const list = await h.operator('GET', '/kiosk/devices')
			expect(list.body.devices).toHaveLength(1)
			expect(list.body.devices[0]).toMatchObject({
				id: deviceId,
				name: 'Bar',
				scopeId: LOC_1,
				status: 'active',
				identifyMode: 'pin',
				backoffSeconds: 0,
			})
			expect(list.raw).not.toMatch(/secret/i)

			const renamed = await h.operator('PATCH', `/kiosk/devices/${deviceId}`, {
				body: { name: 'Patio', identifyMode: 'pick_name' },
			})
			expect(renamed.status).toBe(200)
			expect(renamed.body).toMatchObject({
				name: 'Patio',
				identifyMode: 'pick_name',
			})
			expect(
				(await h.operator('PATCH', `/kiosk/devices/${deviceId}`, { body: {} }))
					.status,
			).toBe(400)

			const revoked = await h.operator(
				'POST',
				`/kiosk/devices/${deviceId}/revoke`,
			)
			expect(revoked.status).toBe(200)
			expect(revoked.body.status).toBe('revoked')
			const again = await h.operator(
				'POST',
				`/kiosk/devices/${deviceId}/revoke`,
			)
			expect(again.status).toBe(200)

			const patchRevoked = await h.operator(
				'PATCH',
				`/kiosk/devices/${deviceId}`,
				{
					body: { name: 'Other' },
				},
			)
			expect(patchRevoked.status).toBe(409)

			const db = await h.db(ORG_A)
			const actions = (await db.select().from(staffAuditLog)).map(
				(r) => r.action,
			)
			expect(actions).toContain('kiosk.pairing_code.created')
			expect(actions).toContain('kiosk.device.paired')
			expect(actions).toContain('kiosk.device.updated')
			expect(actions.filter((a) => a === 'kiosk.device.revoked')).toHaveLength(
				1,
			)
		})

		it('limits devices to the token scope limit with 404, not 403', async () => {
			const { deviceId } = await h.pair(ORG_A, LOC_1)
			const list = await h.operator('GET', '/kiosk/devices', {
				scopeIds: [LOC_2],
			})
			expect(list.body.devices).toEqual([])
			for (const [method, path, body] of [
				['PATCH', `/kiosk/devices/${deviceId}`, { name: 'x' }],
				['POST', `/kiosk/devices/${deviceId}/revoke`, undefined],
			] as const) {
				const response = await h.operator(method, path, {
					scopeIds: [LOC_2],
					body,
				})
				expect(response.status).toBe(404)
			}
			const code = await createCode({}, { scopeIds: [LOC_2] })
			expect(code.status).toBe(404)
		})

		it("does not let one organization manage another organization's device", async () => {
			const { deviceId } = await h.pair(ORG_A, LOC_1)
			const response = await h.operator(
				'POST',
				`/kiosk/devices/${deviceId}/revoke`,
				{
					orgId: ORG_B,
				},
			)
			expect(response.status).toBe(404)
			const db = await h.db(ORG_A)
			const [row] = await db
				.select()
				.from(kioskDevices)
				.where(eq(kioskDevices.id, deviceId))
			expect(row!.revokedAt).toBeNull()
		})

		it('the kill switch stops new pairing codes but never stops a revoke', async () => {
			const { deviceId } = await h.pair(ORG_A, LOC_1)
			vi.stubEnv('STAFFING_KIOSK_ENABLED', 'false')
			const blocked = await createCode()
			expect(blocked.status).toBe(503)
			expect(blocked.body.error).toBe('kiosk_disabled')
			const revoke = await h.operator(
				'POST',
				`/kiosk/devices/${deviceId}/revoke`,
			)
			expect(revoke.status).toBe(200)
			expect((await h.operator('GET', '/kiosk/devices')).status).toBe(200)
		})
	})
})
