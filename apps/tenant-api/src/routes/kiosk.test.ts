import { eq, like } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	kioskDevices,
	kioskPairingCodes,
	staffAuditLog,
	staffJobs,
	staffPositions,
	timeBreaks,
	timeEntries,
	timePunches,
} from '@repo/tenant-db'
import {
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	ORG_B,
	type ClockHarness,
} from '../../tests/timeclock-harness.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'

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

const MIN = 60_000
const HOUR = 60 * MIN

describe('/kiosk', () => {
	let h: ClockHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: 'America/Chicago' })
		facts.set(LOC_2, { name: 'Airport', timeZone: 'America/Chicago' })
		h = await createClockHarness([ORG_A, ORG_B])
	})
	afterEach(async () => {
		await h.cleanup()
	})

	async function entries() {
		const db = await h.db(ORG_A)
		return db.select().from(timeEntries)
	}
	async function punches() {
		const db = await h.db(ORG_A)
		return db.select().from(timePunches)
	}

	describe('pairing', () => {
		async function code(extra: Record<string, unknown> = {}) {
			const created = await h.operator('POST', '/kiosk/pairing-codes', {
				body: { scopeId: LOC_1, deviceName: 'Counter', ...extra },
			})
			expect(created.status).toBe(201)
			return created.body.code as string
		}

		it('exchanges a code for a device secret bound to the scope', async () => {
			const response = await h.kiosk('POST', '/pair', {
				body: { code: await code() },
			})
			expect(response.status).toBe(201)
			const { deviceSecret, device, scope } = response.body
			expect(deviceSecret).toMatch(
				new RegExp(`^kdv1\\.${ORG_A}\\.${device.id}\\.`),
			)
			expect(device).toMatchObject({
				name: 'Counter',
				scopeId: LOC_1,
				identifyMode: 'pin',
				showNextShifts: false,
			})
			expect(scope).toEqual({
				name: 'Downtown',
				timeZone: 'America/Chicago',
			})

			// Only a keyed hash is stored; the secret never touches the database.
			const db = await h.db(ORG_A)
			const [row] = await db.select().from(kioskDevices)
			expect(row!.secretHash).toMatch(/^[0-9a-f]{64}$/)
			expect(JSON.stringify(row)).not.toContain(deviceSecret)
			expect(row!.pairedBy).toBe('operator-1')
		})

		it('a code works once', async () => {
			const value = await code()
			expect(
				(await h.kiosk('POST', '/pair', { body: { code: value } })).status,
			).toBe(201)
			const second = await h.kiosk('POST', '/pair', { body: { code: value } })
			expect(second.status).toBe(401)
			expect(second.body).toEqual({ error: 'invalid_pairing_code' })
			const db = await h.db(ORG_A)
			expect(await db.select().from(kioskDevices)).toHaveLength(1)
		})

		it('two simultaneous redemptions create exactly one device', async () => {
			const value = await code()
			const results = await Promise.all(
				Array.from({ length: 6 }, () =>
					h.kiosk('POST', '/pair', { body: { code: value } }),
				),
			)
			expect(results.filter((r) => r.status === 201)).toHaveLength(1)
			expect(results.filter((r) => r.status === 401)).toHaveLength(5)
			const db = await h.db(ORG_A)
			expect(await db.select().from(kioskDevices)).toHaveLength(1)
		})

		it('a code expires after ten minutes', async () => {
			const value = await code()
			const db = await h.db(ORG_A)
			const [row] = await db.select().from(kioskPairingCodes)
			h.setClock(row!.expiresAt)
			const late = await h.kiosk('POST', '/pair', { body: { code: value } })
			expect(late.status).toBe(401)
			expect(row!.expiresAt - row!.createdAt).toBe(10 * MIN)
			// One tick earlier it still worked.
			h.setClock(row!.expiresAt - 1)
			expect(
				(await h.kiosk('POST', '/pair', { body: { code: value } })).status,
			).toBe(201)
		})

		it('every kind of bad code looks the same', async () => {
			const real = await code()
			const [prefix, org, random] = real.split('.')
			const bad = [
				'',
				'x',
				real.slice(0, -2),
				`${real}A`,
				`kdv1.${org}.${random}`,
				`${prefix}.${ORG_B}.${random}`,
				`${prefix}.${org}.${'A'.repeat(43)}`,
				`${prefix}.nonexistent-org.${random}`,
				`${prefix}..${random}`,
				' ' + real,
			]
			const bodies = new Set<string>()
			for (const value of bad) {
				const response = await h.kiosk('POST', '/pair', {
					body: { code: value },
				})
				expect([400, 401]).toContain(response.status)
				if (response.status === 401) bodies.add(response.raw)
			}
			expect(bodies.size).toBe(1)
			// The real one still works afterwards.
			expect(
				(await h.kiosk('POST', '/pair', { body: { code: real } })).status,
			).toBe(201)
		})

		it('rejects extra keys, missing bodies and non-JSON', async () => {
			const real = await code()
			expect(
				(await h.kiosk('POST', '/pair', { body: { code: real, orgId: ORG_B } }))
					.status,
			).toBe(400)
			expect((await h.kiosk('POST', '/pair', { body: {} })).status).toBe(400)
			expect(
				(await h.kiosk('POST', '/pair', { rawBody: '{nope' })).status,
			).toBe(400)
			expect((await h.kiosk('POST', '/pair')).status).toBe(400)
		})

		it('a pairing code cannot be used on another organization database', async () => {
			const real = await code()
			const [prefix, , random] = real.split('.')
			const swapped = `${prefix}.${ORG_B}.${random}`
			expect(
				(await h.kiosk('POST', '/pair', { body: { code: swapped } })).status,
			).toBe(401)
			const dbB = await h.db(ORG_B)
			expect(await dbB.select().from(kioskDevices)).toHaveLength(0)
		})

		it('audits pairing with the device as the actor', async () => {
			const { deviceId } = await h.pair(ORG_A, LOC_1)
			const db = await h.db(ORG_A)
			const rows = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'kiosk.device.paired'))
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				actorKind: 'kiosk',
				actorId: deviceId,
				scopeId: LOC_1,
			})
		})
	})

	describe('device authentication', () => {
		it('serves configuration to a paired device', async () => {
			const { secret, deviceId } = await h.pair(ORG_A, LOC_1)
			const config = await h.kiosk('GET', '/config', { secret })
			expect(config.status).toBe(200)
			expect(config.body.device).toMatchObject({
				id: deviceId,
				scopeId: LOC_1,
			})
			expect(config.body.scope.name).toBe('Downtown')
			expect(config.body.serverNow).toBe(h.clock.now)
			expect(config.headers.get('cache-control')).toMatch(/no-store/)
		})

		it('refuses missing, malformed and forged secrets with one answer', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const parts = secret.split('.')
			const tampered = [
				null,
				'',
				'garbage',
				secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A'),
				`${parts[0]}.${parts[1]}.${parts[2]}.${'A'.repeat(43)}`,
				`${parts[0]}.${parts[1]}.0b8c5c9e-1111-4222-8333-444455556666.${parts[3]}`,
				`${parts[0]}.${ORG_B}.${parts[2]}.${parts[3]}`,
				`${parts[0]}.no-such-org.${parts[2]}.${parts[3]}`,
				`${secret}x`,
			]
			const raws = new Set<string>()
			for (const value of tampered) {
				const response = await h.kiosk('GET', '/config', { secret: value })
				expect(response.status, String(value)).toBe(401)
				raws.add(response.raw)
			}
			expect([...raws]).toEqual([JSON.stringify({ error: 'invalid_device' })])
		})

		it('a revoked device is refused at once and cannot punch', async () => {
			const { secret, deviceId } = await h.pair(ORG_A, LOC_1)
			const { pin } = await h.seedStaff(ORG_A, {})
			expect((await h.punch(secret, { pin, kind: 'clock_in' })).status).toBe(
				200,
			)

			const revoke = await h.operator(
				'POST',
				`/kiosk/devices/${deviceId}/revoke`,
			)
			expect(revoke.status).toBe(200)

			const after = await h.punch(secret, { pin, kind: 'clock_out' })
			expect(after.status).toBe(401)
			expect(after.body.error).toBe('device_revoked')
			expect((await h.kiosk('GET', '/config', { secret })).body.error).toBe(
				'device_revoked',
			)
			// The clock-out never happened.
			expect((await entries())[0]!.clockOutAt).toBeNull()
		})

		it('does not accept an operator token as a device secret', async () => {
			const { mintStaffToken } = await import('../../tests/staff-harness.ts')
			const token = await mintStaffToken({ scope: 'timeclock' })
			const response = await h.kiosk('GET', '/config', { secret: token })
			expect(response.status).toBe(401)
		})

		it('records the last time a device was seen without writing on every request', async () => {
			const { secret, deviceId } = await h.pair(ORG_A, LOC_1)
			const db = await h.db(ORG_A)
			const seen = async () =>
				(
					await db
						.select()
						.from(kioskDevices)
						.where(eq(kioskDevices.id, deviceId))
				)[0]!.lastSeenAt
			const first = await seen()
			h.advance(10_000)
			await h.kiosk('GET', '/config', { secret })
			expect(await seen()).toBe(first)
			h.advance(2 * MIN)
			await h.kiosk('GET', '/config', { secret })
			expect(await seen()).toBe(h.clock.now)
		})

		it('keeps working when the control plane cannot be reached (facts missing)', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const { pin } = await h.seedStaff(ORG_A, {})
			facts.clear()
			const response = await h.punch(secret, { pin, kind: 'clock_in' })
			expect(response.status).toBe(200)
			// Falls back to the zone the device was paired with.
			expect((await entries())[0]!.timeZone).toBe('America/Chicago')
		})
	})

	describe('identify and punch', () => {
		let secret: string

		beforeEach(async () => {
			;({ secret } = await h.pair(ORG_A, LOC_1))
		})

		it('identifies a person by PIN and tells them only their first name and state', async () => {
			const { pin } = await h.seedStaff(ORG_A, {
				firstName: 'Rana',
				lastName: 'Khalid',
				positions: [{ name: 'Server', rateMinor: 1850 }],
			})
			const response = await h.kiosk('POST', '/identify', {
				secret,
				body: { pin },
			})
			expect(response.status).toBe(200)
			expect(response.body).toEqual({
				firstName: 'Rana',
				state: 'out',
				allowedEvents: ['clock_in'],
				positions: [],
				nextShifts: [],
				promptTips: false,
				serverNow: h.clock.now,
			})
			for (const secretValue of ['Khalid', '1850', 'rate', 'phone', 'email']) {
				expect(response.raw).not.toContain(secretValue)
			}
		})

		it('offers a cash tip declaration only for a role that receives tips', async () => {
			const tipped = await h.seedStaff(ORG_A, {
				positions: [{ name: 'Server', rateMinor: 1500 }],
			})
			const kitchen = await h.seedStaff(ORG_A, {
				positions: [{ name: 'Cook', rateMinor: 2000 }],
			})
			const db = await h.db(ORG_A)
			const [serverPosition] = await db
				.select()
				.from(staffPositions)
				.where(like(staffPositions.name, 'Server-%'))
			await db
				.update(staffPositions)
				.set({ tipEligible: true })
				.where(eq(staffPositions.id, serverPosition!.id))

			const identify = (pin: string) =>
				h.kiosk('POST', '/identify', { secret, body: { pin } })
			// Not clocked in yet: nothing to declare.
			expect((await identify(tipped.pin)).body.promptTips).toBe(false)

			await h.punch(secret, { pin: tipped.pin, kind: 'clock_in' })
			await h.punch(secret, { pin: kitchen.pin, kind: 'clock_in' })
			expect((await identify(tipped.pin)).body.promptTips).toBe(true)
			expect((await identify(kitchen.pin)).body.promptTips).toBe(false)

			const out = await h.punch(secret, {
				pin: tipped.pin,
				kind: 'clock_out',
				cashTipsMinor: 4250,
			})
			expect(out.status).toBe(200)
			const [entry] = await db
				.select()
				.from(timeEntries)
				.where(eq(timeEntries.staffId, tipped.staffId))
			expect(entry!.cashTipsMinor).toBe(4250)
		})

		it('runs a full day: in, meal break, out, with exact minutes', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {
				positions: [{ name: 'Cook', rateMinor: 2000 }],
			})
			const start = h.clock.now
			const clockIn = await h.punch(secret, { pin, kind: 'clock_in' })
			expect(clockIn.body).toMatchObject({
				outcome: 'accepted',
				duplicate: false,
				kind: 'clock_in',
				state: 'in',
				at: start,
			})
			h.advance(3 * HOUR)
			const breakStart = await h.punch(secret, { pin, kind: 'break_start' })
			expect(breakStart.body.state).toBe('on_break')
			const during = await h.kiosk('POST', '/identify', {
				secret,
				body: { pin },
			})
			expect(during.body.state).toBe('on_break')
			expect(during.body.allowedEvents).toEqual(['break_end', 'clock_out'])
			h.advance(30 * MIN)
			expect(
				(await h.punch(secret, { pin, kind: 'break_end' })).body.state,
			).toBe('in')
			h.advance(4.5 * HOUR)
			const out = await h.punch(secret, { pin, kind: 'clock_out' })
			expect(out.body).toMatchObject({ state: 'out', kind: 'clock_out' })

			const [entry] = await entries()
			expect(entry).toMatchObject({
				staffId,
				scopeId: LOC_1,
				status: 'closed',
				clockInAt: start,
				clockOutAt: start + 8 * HOUR,
				timeZone: 'America/Chicago',
				localDate: '2026-03-02',
				paidMinutes: 450,
				unpaidBreakMinutes: 30,
				regularMinutes: 450,
				overtimeMinutes: 0,
				rateMinor: 2000,
				currency: 'USD',
				clockOutKind: 'kiosk',
			})
			expect(entry!.issues).toEqual([])
			const db = await h.db(ORG_A)
			const breaks = await db.select().from(timeBreaks)
			expect(breaks).toHaveLength(1)
			expect(breaks[0]).toMatchObject({
				kind: 'meal',
				paid: false,
				startAt: start + 3 * HOUR,
				endAt: start + 3.5 * HOUR,
			})
			const all = await punches()
			expect(all.map((p) => p.kind)).toEqual([
				'clock_in',
				'break_start',
				'break_end',
				'clock_out',
			])
			expect(all.every((p) => p.outcome === 'accepted' && p.deviceId)).toBe(
				true,
			)
			expect(
				all.every((p) => p.ipHash === null || /^[0-9a-f]{64}$/.test(p.ipHash)),
			).toBe(true)
		})

		it('a rest break is paid', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			await h.punch(secret, { pin, kind: 'clock_in' })
			h.advance(2 * HOUR)
			await h.punch(secret, { pin, kind: 'break_start', breakKind: 'rest' })
			h.advance(15 * MIN)
			await h.punch(secret, { pin, kind: 'break_end' })
			h.advance(2 * HOUR)
			await h.punch(secret, { pin, kind: 'clock_out' })
			const [entry] = await entries()
			expect(entry!.unpaidBreakMinutes).toBe(0)
			expect(entry!.paidMinutes).toBe(255)
		})

		it('clocking out during a break closes the break and the entry together', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			await h.punch(secret, { pin, kind: 'clock_in' })
			h.advance(4 * HOUR)
			await h.punch(secret, { pin, kind: 'break_start' })
			h.advance(20 * MIN)
			const out = await h.punch(secret, { pin, kind: 'clock_out' })
			expect(out.status).toBe(200)
			const db = await h.db(ORG_A)
			const [brk] = await db.select().from(timeBreaks)
			expect(brk!.endAt).toBe(h.clock.now)
			const [entry] = await entries()
			expect(entry!.unpaidBreakMinutes).toBe(20)
			expect(entry!.paidMinutes).toBe(4 * 60 + 20 - 20)
		})

		it('stores declared cash tips at clock-out', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			await h.punch(secret, { pin, kind: 'clock_in' })
			h.advance(5 * HOUR)
			await h.punch(secret, { pin, kind: 'clock_out', cashTipsMinor: 4250 })
			expect((await entries())[0]!.cashTipsMinor).toBe(4250)
			const invalid = await h.kiosk('POST', '/punch', {
				secret,
				body: {
					id: crypto.randomUUID(),
					kind: 'clock_out',
					pin,
					clientAt: h.clock.now,
					cashTipsMinor: -5,
				},
			})
			expect(invalid.status).toBe(400)
		})

		it('an hourly rate snapshot is kept; salary staff carry no hourly rate', async () => {
			const hourly = await h.seedStaff(ORG_A, {
				positions: [{ name: 'Server', rateMinor: 1700, currency: 'USD' }],
			})
			const salaried = await h.seedStaff(ORG_A, {
				positions: [
					{
						name: 'Manager',
						rateMinor: null,
						payType: 'salary',
						overtimeExempt: true,
					},
				],
			})
			await h.punch(secret, { pin: hourly.pin, kind: 'clock_in' })
			await h.punch(secret, { pin: salaried.pin, kind: 'clock_in' })
			const rows = await entries()
			const byStaff = new Map(rows.map((r) => [r.staffId, r]))
			expect(byStaff.get(hourly.staffId)).toMatchObject({
				rateMinor: 1700,
				currency: 'USD',
				overtimeExempt: false,
			})
			expect(byStaff.get(salaried.staffId)).toMatchObject({
				rateMinor: null,
				overtimeExempt: true,
			})
		})

		it('a later raise does not reprice an open entry', async () => {
			const staff = await h.seedStaff(ORG_A, {
				positions: [{ name: 'Server', rateMinor: 1500 }],
			})
			await h.punch(secret, { pin: staff.pin, kind: 'clock_in' })
			const db = await h.db(ORG_A)
			await db
				.update(staffJobs)
				.set({ effectiveTo: '2026-03-01' })
				.where(eq(staffJobs.staffId, staff.staffId))
			expect((await entries())[0]!.rateMinor).toBe(1500)
		})

		it('lets a person with no job clock in without a position or rate', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			expect((await h.punch(secret, { pin, kind: 'clock_in' })).status).toBe(
				200,
			)
			expect((await entries())[0]).toMatchObject({
				positionId: null,
				rateMinor: null,
				jobId: null,
			})
		})

		describe('role pick', () => {
			async function multi() {
				const staff = await h.seedStaff(ORG_A, {
					firstName: 'Omar',
					positions: [
						{ name: 'Server', rateMinor: 1500, nameAr: 'نادل' },
						{ name: 'Bartender', rateMinor: 1900 },
					],
				})
				return staff
			}

			it('offers the roles at identify and demands a pick at clock-in without recording it', async () => {
				const { pin } = await multi()
				const identify = await h.kiosk('POST', '/identify', {
					secret,
					body: { pin },
				})
				expect(identify.body.positions).toHaveLength(2)
				expect(identify.body.positions[0]).toEqual({
					id: expect.any(String),
					name: expect.stringMatching(/^Server/),
					nameAr: 'نادل',
				})
				expect(identify.raw).not.toMatch(/1500|1900/)

				const id = crypto.randomUUID()
				const prompt = await h.punch(secret, { pin, kind: 'clock_in', id })
				expect(prompt.status).toBe(409)
				expect(prompt.body.error).toBe('position_required')
				expect(prompt.body.positions).toHaveLength(2)
				// A prompt is not an event: nothing was recorded.
				expect(await punches()).toHaveLength(0)
				expect(await entries()).toHaveLength(0)

				// The same id is reused with the pick.
				const picked = await h.punch(secret, {
					pin,
					kind: 'clock_in',
					id,
					positionId: prompt.body.positions[1].id,
				})
				expect(picked.status).toBe(200)
				const [entry] = await entries()
				expect(entry!.positionId).toBe(prompt.body.positions[1].id)
				expect(entry!.rateMinor).toBe(1900)
			})

			it('rejects a role the person does not hold, and records the rejection', async () => {
				const { pin } = await multi()
				const db = await h.db(ORG_A)
				const [stranger] = await db
					.insert(staffPositions)
					.values({ name: 'Host' })
					.returning()
				const response = await h.punch(secret, {
					pin,
					kind: 'clock_in',
					positionId: stranger!.id,
				})
				expect(response.status).toBe(400)
				expect(response.body.error).toBe('invalid_position')
				expect((await punches())[0]).toMatchObject({
					outcome: 'rejected_policy',
					rejectCode: 'invalid_position',
				})
				expect(await entries()).toHaveLength(0)
			})

			it('a person with one role is not asked', async () => {
				const staff = await h.seedStaff(ORG_A, {
					positions: [{ name: 'Cook', rateMinor: 1600 }],
				})
				const identify = await h.kiosk('POST', '/identify', {
					secret,
					body: { pin: staff.pin },
				})
				expect(identify.body.positions).toEqual([])
				expect(
					(await h.punch(secret, { pin: staff.pin, kind: 'clock_in' })).status,
				).toBe(200)
			})

			it('does not offer archived positions or jobs that ended', async () => {
				const staff = await multi()
				const db = await h.db(ORG_A)
				const jobs = await db
					.select()
					.from(staffJobs)
					.where(eq(staffJobs.staffId, staff.staffId))
				await db
					.update(staffPositions)
					.set({ archivedAt: 1 })
					.where(eq(staffPositions.id, jobs[0]!.positionId))
				const identify = await h.kiosk('POST', '/identify', {
					secret,
					body: { pin: staff.pin },
				})
				expect(identify.body.positions).toEqual([])
				await h.punch(secret, { pin: staff.pin, kind: 'clock_in' })
				expect((await entries())[0]!.positionId).toBe(jobs[1]!.positionId)
			})
		})
	})

	describe('idempotency', () => {
		let secret: string
		let pin: string
		beforeEach(async () => {
			;({ secret } = await h.pair(ORG_A, LOC_1))
			;({ pin } = await h.seedStaff(ORG_A, { firstName: 'Rana' }))
		})

		it('replaying a punch id returns the stored result and changes nothing', async () => {
			const id = crypto.randomUUID()
			const first = await h.punch(secret, { pin, kind: 'clock_in', id })
			h.advance(5 * MIN)
			const replay = await h.punch(secret, { pin, kind: 'clock_in', id })
			expect(replay.status).toBe(200)
			expect(replay.body).toMatchObject({
				duplicate: true,
				kind: 'clock_in',
				state: 'in',
				at: first.body.at,
				firstName: 'Rana',
			})
			expect(await entries()).toHaveLength(1)
			expect(await punches()).toHaveLength(1)
		})

		it('a replay after the state moved on still reports the original action', async () => {
			const id = crypto.randomUUID()
			await h.punch(secret, { pin, kind: 'clock_in', id })
			h.advance(2 * HOUR)
			await h.punch(secret, { pin, kind: 'clock_out' })
			const replay = await h.punch(secret, { pin, kind: 'clock_in', id })
			expect(replay.body).toMatchObject({
				duplicate: true,
				kind: 'clock_in',
				state: 'out',
			})
			expect(await punches()).toHaveLength(2)
			expect((await entries())[0]!.clockOutAt).not.toBeNull()
		})

		it('a replayed rejection answers the same rejection', async () => {
			const id = crypto.randomUUID()
			const first = await h.punch(secret, { pin, kind: 'clock_out', id })
			expect(first.body.error).toBe('not_clocked_in')
			// Even after the person clocks in, that id stays a rejected clock-out.
			await h.punch(secret, { pin, kind: 'clock_in' })
			const replay = await h.punch(secret, { pin, kind: 'clock_out', id })
			expect(replay.status).toBe(409)
			expect(replay.body.error).toBe('not_clocked_in')
			expect((await entries())[0]!.clockOutAt).toBeNull()
		})

		it('refuses an id reused for another action', async () => {
			const id = crypto.randomUUID()
			await h.punch(secret, { pin, kind: 'clock_in', id })
			const reuse = await h.punch(secret, { pin, kind: 'break_start', id })
			expect(reuse.status).toBe(409)
			expect(reuse.body.error).toBe('punch_id_conflict')
			expect(await punches()).toHaveLength(1)
		})

		it("never returns one person's result to another person or device", async () => {
			const id = crypto.randomUUID()
			await h.punch(secret, { pin, kind: 'clock_in', id })
			const other = await h.seedStaff(ORG_A, { firstName: 'Omar' })
			const stolen = await h.punch(secret, {
				pin: other.pin,
				kind: 'clock_in',
				id,
			})
			expect(stolen.status).toBe(409)
			expect(stolen.body).toEqual({ error: 'punch_id_conflict' })
			expect(stolen.raw).not.toContain('Rana')

			const second = await h.pair(ORG_A, LOC_1, { name: 'Bar' })
			const fromOtherDevice = await h.punch(second.secret, {
				pin,
				kind: 'clock_in',
				id,
			})
			expect(fromOtherDevice.status).toBe(409)
			expect(fromOtherDevice.body.error).toBe('punch_id_conflict')
			expect(await entries()).toHaveLength(1)
		})

		it('five simultaneous copies of one punch make one entry', async () => {
			const id = crypto.randomUUID()
			const results = await Promise.all(
				Array.from({ length: 5 }, () =>
					h.punch(secret, { pin, kind: 'clock_in', id }),
				),
			)
			expect(results.every((r) => r.status === 200)).toBe(true)
			expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1)
			expect(await entries()).toHaveLength(1)
			expect(await punches()).toHaveLength(1)
		})

		it('five simultaneous different clock-ins leave exactly one open entry', async () => {
			const results = await Promise.all(
				Array.from({ length: 5 }, () =>
					h.punch(secret, { pin, kind: 'clock_in' }),
				),
			)
			expect(results.filter((r) => r.status === 200)).toHaveLength(1)
			expect(
				results.filter(
					(r) => r.status === 409 && r.body.error === 'already_clocked_in',
				),
			).toHaveLength(4)
			expect(await entries()).toHaveLength(1)
		})

		it('validates the punch id', async () => {
			for (const id of ['', 'abc', 'x'.repeat(200), 5, null]) {
				const response = await h.kiosk('POST', '/punch', {
					secret,
					body: { id, kind: 'clock_in', pin, clientAt: h.clock.now },
				})
				expect(response.status).toBe(400)
			}
		})
	})

	describe('impossible transitions', () => {
		let secret: string
		let pin: string
		beforeEach(async () => {
			;({ secret } = await h.pair(ORG_A, LOC_1))
			;({ pin } = await h.seedStaff(ORG_A, {}))
		})

		const rejected = async () =>
			(await punches()).filter((p) => p.outcome !== 'accepted')

		it('refuses everything but clock-in while clocked out', async () => {
			for (const [kind, code] of [
				['clock_out', 'not_clocked_in'],
				['break_start', 'not_clocked_in'],
				['break_end', 'not_clocked_in'],
			] as const) {
				const response = await h.punch(secret, { pin, kind })
				expect(response.status).toBe(409)
				expect(response.body.error).toBe(code)
			}
			expect(await entries()).toHaveLength(0)
			const rows = await rejected()
			expect(rows).toHaveLength(3)
			expect(
				rows.every(
					(r) => r.outcome === 'rejected_state' && r.effectiveAt === null,
				),
			).toBe(true)
		})

		it('refuses clock-in and break-end while clocked in', async () => {
			await h.punch(secret, { pin, kind: 'clock_in' })
			expect(
				(await h.punch(secret, { pin, kind: 'clock_in' })).body.error,
			).toBe('already_clocked_in')
			expect(
				(await h.punch(secret, { pin, kind: 'break_end' })).body.error,
			).toBe('not_on_break')
			expect(await entries()).toHaveLength(1)
		})

		it('refuses clock-in and a second break-start while on a break', async () => {
			await h.punch(secret, { pin, kind: 'clock_in' })
			h.advance(MIN)
			await h.punch(secret, { pin, kind: 'break_start' })
			expect(
				(await h.punch(secret, { pin, kind: 'clock_in' })).body.error,
			).toBe('already_clocked_in')
			expect(
				(await h.punch(secret, { pin, kind: 'break_start' })).body.error,
			).toBe('already_on_break')
			const db = await h.db(ORG_A)
			expect(await db.select().from(timeBreaks)).toHaveLength(1)
		})

		it('refuses a second clock-out', async () => {
			await h.punch(secret, { pin, kind: 'clock_in' })
			h.advance(HOUR)
			await h.punch(secret, { pin, kind: 'clock_out' })
			expect(
				(await h.punch(secret, { pin, kind: 'clock_out' })).body.error,
			).toBe('not_clocked_in')
		})

		it('audits every rejection without any pay or contact data', async () => {
			await h.punch(secret, { pin, kind: 'clock_out' })
			const db = await h.db(ORG_A)
			const rows = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'kiosk.punch.rejected'))
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				actorKind: 'kiosk',
				scopeId: LOC_1,
				sensitivity: 'standard',
			})
			expect(rows[0]!.changes).toEqual({
				code: 'not_clocked_in',
				kind: 'clock_out',
				outcome: 'rejected_state',
			})
		})

		it('a person clocked in at one scope cannot punch at another', async () => {
			const both = await h.seedStaff(ORG_A, { scopeIds: [LOC_1, LOC_2] })
			const second = await h.pair(ORG_A, LOC_2, { name: 'Airport' })
			await h.punch(secret, { pin: both.pin, kind: 'clock_in' })
			for (const kind of ['clock_in', 'break_start', 'clock_out'] as const) {
				const response = await h.punch(second.secret, { pin: both.pin, kind })
				expect(response.status).toBe(409)
				expect(response.body.error).toBe('clocked_in_elsewhere')
			}
			// Back at the first scope they can clock out normally.
			h.advance(HOUR)
			expect(
				(await h.punch(secret, { pin: both.pin, kind: 'clock_out' })).status,
			).toBe(200)
			// And now the other scope is open to them.
			h.advance(HOUR)
			expect(
				(await h.punch(second.secret, { pin: both.pin, kind: 'clock_in' }))
					.status,
			).toBe(200)
			const db = await h.db(ORG_A)
			const open = (await db.select().from(timeEntries)).filter(
				(e) => e.clockOutAt === null,
			)
			expect(open).toHaveLength(1)
			expect(open[0]!.scopeId).toBe(LOC_2)
		})

		it('refuses a clock-in that would overlap a previous entry (queued punches)', async () => {
			await h.punch(secret, { pin, kind: 'clock_in' })
			h.advance(4 * HOUR)
			await h.punch(secret, { pin, kind: 'clock_out' })
			const response = await h.punch(secret, {
				pin,
				kind: 'clock_in',
				offline: true,
				clientAt: h.clock.now - 2 * HOUR,
			})
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('overlaps_previous_entry')
		})
	})

	describe('with the roster API (PIN lifecycle)', () => {
		const staffRequest = async (
			method: string,
			path: string,
			body?: unknown,
		) => {
			const { ADMIN_GRANTS, mintStaffToken } =
				await import('../../tests/staff-harness.ts')
			const token = await mintStaffToken({
				orgId: ORG_A,
				scope: 'staff',
				grants: ADMIN_GRANTS,
			})
			const response = await h.app.request(`/operator/staff${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					...(body ? { 'content-type': 'application/json' } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
			})
			return { status: response.status, body: (await response.json()) as any }
		}

		it('a PIN issued by the roster works at the kiosk, and stops working when it is reset, cleared or the person leaves', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const created = await staffRequest('POST', '', {
				firstName: 'Rana',
				lastName: 'Khalid',
				assignments: [{ scopeId: LOC_1, isPrimary: true }],
			})
			expect(created.status).toBe(201)
			const staffId = created.body.staff.id as string
			const assignmentId = created.body.assignments[0].id as string

			const issued = await staffRequest(
				'POST',
				`/${staffId}/assignments/${assignmentId}/pin`,
				{},
			)
			expect(issued.status).toBe(201)
			const pin = issued.body.pin as string
			expect(pin).toMatch(/^\d{4}$/)

			expect((await h.punch(secret, { pin, kind: 'clock_in' })).status).toBe(
				200,
			)
			h.advance(HOUR)
			expect((await h.punch(secret, { pin, kind: 'clock_out' })).status).toBe(
				200,
			)

			// Resetting issues a new PIN and the old one is just wrong.
			h.advance(HOUR)
			const reset = await staffRequest(
				'POST',
				`/${staffId}/assignments/${assignmentId}/pin`,
				{},
			)
			const newPin = reset.body.pin as string
			expect(newPin).not.toBe(pin)
			expect(
				(await h.kiosk('POST', '/identify', { secret, body: { pin } })).status,
			).toBe(401)
			h.advance(MIN)
			expect(
				(await h.kiosk('POST', '/identify', { secret, body: { pin: newPin } }))
					.status,
			).toBe(200)

			const cleared = await staffRequest(
				'DELETE',
				`/${staffId}/assignments/${assignmentId}/pin`,
			)
			expect(cleared.status).toBe(200)
			h.advance(MIN)
			expect(
				(await h.kiosk('POST', '/identify', { secret, body: { pin: newPin } }))
					.status,
			).toBe(401)
		})

		it('terminating a person ends their kiosk access', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const created = await staffRequest('POST', '', {
				firstName: 'Omar',
				lastName: 'Saleh',
				assignments: [{ scopeId: LOC_1, isPrimary: true }],
			})
			const staffId = created.body.staff.id as string
			const assignmentId = created.body.assignments[0].id as string
			const issued = await staffRequest(
				'POST',
				`/${staffId}/assignments/${assignmentId}/pin`,
				{},
			)
			const pin = issued.body.pin as string
			expect(
				(await h.kiosk('POST', '/identify', { secret, body: { pin } })).status,
			).toBe(200)
			const terminated = await staffRequest('POST', `/${staffId}/terminate`, {
				reason: 'Resigned',
				effectiveDate: '2026-03-02',
				eligibleForRehire: true,
			})
			expect(terminated.status).toBe(200)
			const after = await h.kiosk('POST', '/identify', {
				secret,
				body: { pin },
			})
			expect(after.status).toBe(401)
			expect(after.body.error).toBe('invalid_pin')
		})
	})

	describe('terminated and unassigned people', () => {
		it('a terminated person, an inactive assignment and another scope are all just invalid', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const terminated = await h.seedStaff(ORG_A, { status: 'terminated' })
			const onLeave = await h.seedStaff(ORG_A, { status: 'on_leave' })
			const elsewhere = await h.seedStaff(ORG_A, { scopeIds: [LOC_2] })
			const raws = new Set<string>()
			for (const person of [terminated, onLeave, elsewhere]) {
				const response = await h.kiosk('POST', '/identify', {
					secret,
					body: { pin: person.pin },
				})
				expect(response.status).toBe(401)
				expect(response.body.error).toBe('invalid_pin')
				raws.add(response.body.error)
				h.advance(10 * MIN)
			}
			expect(raws.size).toBe(1)
			expect(await entries()).toHaveLength(0)
		})

		it('two scopes may use the same PIN for different people', async () => {
			const a = await h.seedStaff(ORG_A, {
				firstName: 'Rana',
				scopeIds: [LOC_1],
				pin: '4827',
			})
			const b = await h.seedStaff(ORG_A, {
				firstName: 'Omar',
				scopeIds: [LOC_2],
				pin: '4827',
			})
			const one = await h.pair(ORG_A, LOC_1)
			const two = await h.pair(ORG_A, LOC_2)
			expect(
				(
					await h.kiosk('POST', '/identify', {
						secret: one.secret,
						body: { pin: '4827' },
					})
				).body.firstName,
			).toBe('Rana')
			expect(
				(
					await h.kiosk('POST', '/identify', {
						secret: two.secret,
						body: { pin: '4827' },
					})
				).body.firstName,
			).toBe('Omar')
			void a
			void b
		})

		it('accepts a PIN typed with Arabic-Indic digits', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			await h.seedStaff(ORG_A, { firstName: 'Layla', pin: '4827' })
			const response = await h.kiosk('POST', '/identify', {
				secret,
				body: { pin: '٤٨٢٧' },
			})
			expect(response.status).toBe(200)
			expect(response.body.firstName).toBe('Layla')
		})
	})

	describe('time clock switch', () => {
		it('a scope with time tracking off accepts no punches', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const { pin } = await h.seedStaff(ORG_A, {})
			await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { timeTrackingEnabled: false },
			})
			const response = await h.punch(secret, { pin, kind: 'clock_in' })
			expect(response.status).toBe(403)
			expect(response.body.error).toBe('time_tracking_disabled')
			const identify = await h.kiosk('POST', '/identify', {
				secret,
				body: { pin },
			})
			expect(identify.body.allowedEvents).toEqual([])
			expect(await entries()).toHaveLength(0)
			await h.operator('PUT', `/policies/${LOC_1}`, {
				body: { expectedVersion: 1, timeTrackingEnabled: true },
			})
			expect((await h.punch(secret, { pin, kind: 'clock_in' })).status).toBe(
				200,
			)
		})
	})
})
