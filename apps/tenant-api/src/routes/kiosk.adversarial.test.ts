import { eq } from 'drizzle-orm'
import { ENV } from 'varlock/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	kioskAttempts,
	staffAuditLog,
	staffScopeAssignments,
	timeEntries,
	timePunches,
} from '@repo/tenant-db'
import { createTenantApiApp } from '../app.ts'
import {
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
import { kioskDeps } from './kiosk.ts'

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

describe('kiosk abuse resistance', () => {
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

	const identify = (secret: string, pin: string, staffId?: string) =>
		h.kiosk('POST', '/identify', {
			secret,
			body: { pin, ...(staffId ? { staffId } : {}) },
		})

	describe('PIN backoff', () => {
		let secret: string
		let deviceId: string
		let pin: string
		const WRONG = '9999'

		beforeEach(async () => {
			;({ secret, deviceId } = await h.pair(ORG_A, LOC_1))
			;({ pin } = await h.seedStaff(ORG_A, { pin: '4827' }))
		})

		async function attempts() {
			const db = await h.db(ORG_A)
			const [row] = await db
				.select()
				.from(kioskAttempts)
				.where(eq(kioskAttempts.deviceId, deviceId))
			return row
		}

		it('forgives four typos, then imposes a 30 second delay on the fifth failure', async () => {
			for (let i = 1; i <= 4; i++) {
				const response = await identify(secret, WRONG)
				expect(response.status).toBe(401)
				expect(response.body).toEqual({
					error: 'invalid_pin',
					retryAfterSeconds: 0,
				})
				expect(response.headers.get('retry-after')).toBeNull()
				h.advance(1000)
			}
			const fifth = await identify(secret, WRONG)
			expect(fifth.status).toBe(401)
			expect(fifth.body.retryAfterSeconds).toBe(30)
			expect(fifth.headers.get('retry-after')).toBe('30')
		})

		it('refuses everything during the delay, even the right PIN, and says nothing about correctness', async () => {
			for (let i = 0; i < 5; i++) await identify(secret, WRONG)
			const right = await identify(secret, pin)
			const wrong = await identify(secret, WRONG)
			for (const response of [right, wrong]) {
				expect(response.status).toBe(429)
				expect(response.body.error).toBe('backoff')
				expect(response.headers.get('retry-after')).toBe('30')
			}
			expect(right.raw).toBe(wrong.raw)
			const punch = await h.punch(secret, { pin, kind: 'clock_in' })
			expect(punch.status).toBe(429)
			expect(
				await h.db(ORG_A).then((db) => db.select().from(timeEntries)),
			).toHaveLength(0)
		})

		it('blocked attempts do not extend the delay', async () => {
			for (let i = 0; i < 5; i++) await identify(secret, WRONG)
			for (let i = 0; i < 20; i++) {
				h.advance(1000)
				await identify(secret, WRONG)
			}
			// 20 seconds passed with attempts the whole time; 10 remain.
			const still = await identify(secret, pin)
			expect(still.status).toBe(429)
			expect(still.body.retryAfterSeconds).toBe(10)
			h.advance(10_000)
			expect((await identify(secret, pin)).status).toBe(200)
		})

		it('never locks the device out as a whole: the right PIN works once the delay ends', async () => {
			for (let i = 0; i < 12; i++) {
				const response = await identify(secret, WRONG)
				if (response.status === 429)
					h.advance(response.body.retryAfterSeconds * 1000 + 1)
			}
			const row = await attempts()
			expect(row!.failures).toBeGreaterThan(5)
			h.advance(5 * MIN + 1000)
			expect((await identify(secret, pin)).status).toBe(200)
			expect((await h.punch(secret, { pin, kind: 'clock_in' })).status).toBe(
				200,
			)
		})

		it('escalates 30, 60, 120, 240 then holds at five minutes', async () => {
			const delays: number[] = []
			for (let i = 0; i < 10; i++) {
				const response = await identify(secret, WRONG)
				expect(response.status).toBe(401)
				delays.push(response.body.retryAfterSeconds)
				h.advance(response.body.retryAfterSeconds * 1000 + 1)
			}
			expect(delays).toEqual([0, 0, 0, 0, 30, 60, 120, 240, 300, 300])
		})

		it('counters live in the database, so a fresh process or isolate cannot reset them', async () => {
			for (let i = 0; i < 5; i++) await identify(secret, WRONG)
			expect((await attempts())!.blockedUntil).toBe(h.clock.now + 30_000)
			// A second app instance (a new isolate) shares nothing in memory.
			const fresh = createTenantApiApp()
			const response = await fresh.request('/kiosk/identify', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${secret}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ pin }),
			})
			expect(response.status).toBe(429)
		})

		it('is per device: another tablet is unaffected', async () => {
			const other = await h.pair(ORG_A, LOC_1, { name: 'Bar' })
			for (let i = 0; i < 8; i++) await identify(secret, WRONG)
			expect((await identify(secret, pin)).status).toBe(429)
			expect((await identify(other.secret, pin)).status).toBe(200)
		})

		it('a correct PIN forgives one failure only, so it cannot be used to reset the counter', async () => {
			for (let i = 0; i < 8; i++) {
				const response = await identify(secret, WRONG)
				if (response.status === 429)
					h.advance(response.body.retryAfterSeconds * 1000 + 1)
			}
			h.advance(10 * MIN)
			const before = (await attempts())!.failures
			expect((await identify(secret, pin)).status).toBe(200)
			const after = await attempts()
			expect(after!.failures).toBeGreaterThanOrEqual(1)
			expect(after!.failures).toBeLessThan(before + 1)
			// Guessing again immediately still costs a delay.
			let delayed = false
			for (let i = 0; i < 3; i++) {
				const response = await identify(secret, WRONG)
				if (response.body.retryAfterSeconds > 0 || response.status === 429)
					delayed = true
				if (response.status === 429)
					h.advance(response.body.retryAfterSeconds * 1000 + 1)
			}
			expect(delayed).toBe(true)
		})

		it('bounds brute force: sixty guesses cost hours of waiting', async () => {
			const start = h.clock.now
			let evaluated = 0
			while (evaluated < 60) {
				const response = await identify(secret, String(1000 + evaluated))
				if (response.status === 429) {
					h.advance(response.body.retryAfterSeconds * 1000 + 1)
					continue
				}
				expect(response.body.error).toBe('invalid_pin')
				evaluated += 1
				h.advance(1000)
			}
			const hours = (h.clock.now - start) / HOUR
			// 55 guesses past the free ones at the 5 minute ceiling is over four hours.
			expect(hours).toBeGreaterThan(4)
		})

		it('a burst of simultaneous guesses cannot slip past the counter', async () => {
			const results = await Promise.all(
				Array.from({ length: 40 }, (_, i) =>
					identify(secret, String(2000 + i)),
				),
			)
			const evaluated = results.filter((r) => r.body.error === 'invalid_pin')
			const refused = results.filter((r) => r.body.error === 'backoff')
			// Four free typos plus the one that starts the delay; everything else waits.
			expect(evaluated.length).toBeLessThanOrEqual(5)
			expect(refused.length).toBeGreaterThanOrEqual(35)
			expect((await attempts())!.failures).toBe(5)
		})

		it('a burst of simultaneous punches cannot slip past the counter either', async () => {
			const results = await Promise.all(
				Array.from({ length: 40 }, (_, i) =>
					h.punch(secret, { pin: String(2000 + i), kind: 'clock_in' }),
				),
			)
			expect(
				results.filter((r) => r.body.error === 'invalid_pin').length,
			).toBeLessThanOrEqual(5)
		})

		it('identify and punch share one counter', async () => {
			for (let i = 0; i < 3; i++) await identify(secret, WRONG)
			for (let i = 0; i < 2; i++)
				await h.punch(secret, { pin: WRONG, kind: 'clock_in' })
			expect((await identify(secret, pin)).status).toBe(429)
		})

		it('raises one audit alert per hour at the hourly ceiling and never the PIN guessed', async () => {
			for (let i = 0; i < 40; i++) {
				const response = await identify(secret, `${1000 + i}`)
				if (response.status === 429)
					h.advance(response.body.retryAfterSeconds * 1000 + 1)
				else h.advance(2000)
			}
			const db = await h.db(ORG_A)
			const rows = await db.select().from(staffAuditLog)
			expect(
				rows.filter((r) => r.action === 'kiosk.pin.failures_high'),
			).toHaveLength(1)
			expect(rows.some((r) => r.action === 'kiosk.pin.backoff')).toBe(true)
			const everything = JSON.stringify(rows)
			for (let i = 0; i < 40; i++)
				expect(everything).not.toContain(`"${1000 + i}"`)
			expect(everything).not.toContain('"4827"')
			const pinRows = rows.filter((r) => r.action.startsWith('kiosk.pin.'))
			expect(pinRows.length).toBeGreaterThan(0)
			expect(
				pinRows.every((r) => r.actorKind === 'kiosk' && r.actorId === deviceId),
			).toBe(true)
		})

		it('rejects malformed PINs before they touch the counters', async () => {
			for (const bad of [
				'',
				'abcd',
				'12345678901234',
				'12 34',
				"1234'; DROP TABLE staff_members;--",
				'١٢٣٤x',
				1234,
				null,
				{},
				[],
			]) {
				const response = await h.kiosk('POST', '/identify', {
					secret,
					body: { pin: bad },
				})
				expect(response.status, JSON.stringify(bad)).toBe(400)
			}
			expect(await attempts()).toBeUndefined()
		})

		it('counts a wrongly sized digit string as a failure', async () => {
			for (const short of ['1', '12', '123', '1234567']) {
				const response = await identify(secret, short)
				expect(response.status).toBe(401)
				h.advance(1000)
			}
			expect((await attempts())!.failures).toBe(4)
		})
	})

	describe('pick-name mode', () => {
		let secret: string
		let deviceId: string
		beforeEach(async () => {
			;({ secret, deviceId } = await h.pair(ORG_A, LOC_1, {
				mode: 'pick_name',
			}))
		})

		it('lists first names and last initials only, for people who can clock in here', async () => {
			await h.seedStaff(ORG_A, { firstName: 'Rana', lastName: 'Khalid' })
			await h.seedStaff(ORG_A, { firstName: 'Omar', lastName: 'Saleh' })
			await h.seedStaff(ORG_A, {
				firstName: 'Gone',
				lastName: 'Away',
				status: 'terminated',
			})
			await h.seedStaff(ORG_A, {
				firstName: 'Elsewhere',
				lastName: 'Person',
				scopeIds: [LOC_2],
			})
			const response = await h.kiosk('GET', '/people', { secret })
			expect(response.status).toBe(200)
			expect(
				response.body.people.map((p: any) => [p.firstName, p.lastInitial]),
			).toEqual([
				['Omar', 'S'],
				['Rana', 'K'],
			])
			expect(response.raw).not.toMatch(
				/Khalid|Saleh|Gone|Elsewhere|phone|email/,
			)
			expect(Object.keys(response.body.people[0]).sort()).toEqual([
				'firstName',
				'lastInitial',
				'staffId',
			])
		})

		it('PIN-only devices cannot list anyone', async () => {
			const pinDevice = await h.pair(ORG_A, LOC_1, { name: 'PIN tablet' })
			await h.seedStaff(ORG_A, {})
			const response = await h.kiosk('GET', '/people', {
				secret: pinDevice.secret,
			})
			expect(response.status).toBe(403)
			expect(response.body.error).toBe('not_available')
		})

		it('needs the person to be picked, and the PIN has to be theirs', async () => {
			const rana = await h.seedStaff(ORG_A, { firstName: 'Rana', pin: '4827' })
			const omar = await h.seedStaff(ORG_A, { firstName: 'Omar', pin: '6391' })
			expect((await identify(secret, '4827')).status).toBe(400)
			const ok = await identify(secret, '4827', rana.staffId)
			expect(ok.status).toBe(200)
			expect(ok.body.firstName).toBe('Rana')
			// Omar's PIN under Rana's name is just a wrong PIN.
			const wrong = await identify(secret, '6391', rana.staffId)
			expect(wrong.status).toBe(401)
			expect(wrong.body.error).toBe('invalid_pin')
			void omar
		})

		it('does not reveal whether a picked person exists', async () => {
			const real = await h.seedStaff(ORG_A, { pin: '4827' })
			const unknown = await identify(secret, '1357', crypto.randomUUID())
			h.advance(MIN)
			const knownWrong = await identify(secret, '1357', real.staffId)
			expect(unknown.status).toBe(401)
			expect(unknown.raw).toBe(knownWrong.raw)
		})

		it('locks only the person who was guessed at, for fifteen minutes', async () => {
			const rana = await h.seedStaff(ORG_A, { firstName: 'Rana', pin: '4827' })
			const omar = await h.seedStaff(ORG_A, { firstName: 'Omar', pin: '6391' })
			let last
			for (let i = 0; i < 5; i++) {
				last = await identify(secret, '0000', rana.staffId)
				if (last.status === 429 && last.body.error === 'backoff')
					h.advance(last.body.retryAfterSeconds * 1000 + 1)
			}
			expect(last!.status).toBe(429)
			expect(last!.body).toEqual({
				error: 'person_locked',
				retryAfterSeconds: 900,
			})

			// The device backs off briefly for everyone; once that passes Omar is fine.
			h.advance(31_000)
			expect((await identify(secret, '6391', omar.staffId)).status).toBe(200)
			// Rana is still locked even with her real PIN.
			const locked = await identify(secret, '4827', rana.staffId)
			expect(locked.status).toBe(429)
			expect(locked.body.error).toBe('person_locked')
			expect(
				(
					await h.punch(secret, {
						pin: '4827',
						staffId: rana.staffId,
						kind: 'clock_in',
					})
				).status,
			).toBe(429)

			h.advance(15 * MIN)
			const back = await identify(secret, '4827', rana.staffId)
			expect(back.status).toBe(200)
			const db = await h.db(ORG_A)
			const [row] = await db
				.select()
				.from(staffScopeAssignments)
				.where(eq(staffScopeAssignments.id, rana.assignmentIds[0]!))
			expect(row).toMatchObject({ pinFailedCount: 0, pinLockedUntil: null })
			const audit = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'kiosk.person.locked'))
			expect(audit).toHaveLength(1)
			expect(audit[0]).toMatchObject({
				staffId: rana.staffId,
				actorId: deviceId,
			})
		})

		it('clocks a picked person in and out', async () => {
			const rana = await h.seedStaff(ORG_A, { firstName: 'Rana', pin: '4827' })
			expect(
				(
					await h.punch(secret, {
						pin: '4827',
						staffId: rana.staffId,
						kind: 'clock_in',
					})
				).body.state,
			).toBe('in')
			h.advance(HOUR)
			expect(
				(
					await h.punch(secret, {
						pin: '4827',
						staffId: rana.staffId,
						kind: 'clock_out',
					})
				).body.state,
			).toBe('out')
		})
	})

	describe('credential confusion and replay', () => {
		let secret: string
		beforeEach(async () => {
			;({ secret } = await h.pair(ORG_A, LOC_1))
		})

		it('no operator token works on a kiosk route', async () => {
			for (const scope of ['staff', 'timeclock', 'schedule', 'hiring']) {
				const token = await mintStaffToken({ scope })
				for (const [method, path] of [
					['GET', '/config'],
					['GET', '/people'],
					['POST', '/identify'],
					['POST', '/punch'],
				] as const) {
					const response = await h.kiosk(method, path, {
						secret: token,
						body: method === 'POST' ? {} : undefined,
					})
					expect(response.status, `${scope} ${path}`).toBe(401)
				}
			}
		})

		it('a device secret works on no operator route', async () => {
			for (const path of [
				'/operator/timeclock/policies',
				'/operator/timeclock/kiosk/devices',
				'/operator/staff',
				'/operator/staff/positions',
				'/operator/orders',
			]) {
				const response = await h.app.request(path, {
					headers: { Authorization: `Bearer ${secret}` },
				})
				expect([401, 403, 404], path).toContain(response.status)
				expect(response.status).not.toBe(200)
			}
		})

		it('a pairing code is not a device secret and a device secret is not a pairing code', async () => {
			const created = await h.operator('POST', '/kiosk/pairing-codes', {
				body: { scopeId: LOC_1, deviceName: 'x' },
			})
			expect(
				(await h.kiosk('GET', '/config', { secret: created.body.code })).status,
			).toBe(401)
			expect(
				(await h.kiosk('POST', '/pair', { body: { code: secret } })).status,
			).toBe(401)
		})

		it('a device only ever acts at its own scope', async () => {
			const other = await h.seedStaff(ORG_A, {
				scopeIds: [LOC_2],
				firstName: 'Zed',
			})
			const response = await identify(secret, other.pin)
			expect(response.status).toBe(401)
			expect(response.raw).not.toContain('Zed')
			const punch = await h.punch(secret, { pin: other.pin, kind: 'clock_in' })
			expect(punch.status).toBe(401)
			expect(
				await h.db(ORG_A).then((db) => db.select().from(timePunches)),
			).toHaveLength(0)
		})

		it('a device secret of one organization does nothing in another', async () => {
			const parts = secret.split('.')
			const forged = `${parts[0]}.${ORG_B}.${parts[2]}.${parts[3]}`
			const staffB = await h.seedStaff(ORG_B, {})
			const response = await h.punch(forged, {
				pin: staffB.pin,
				kind: 'clock_in',
			})
			expect(response.status).toBe(401)
			expect(
				await h.db(ORG_B).then((db) => db.select().from(timePunches)),
			).toHaveLength(0)
		})

		it('ignores a client-supplied org id in the query or body', async () => {
			const staffB = await h.seedStaff(ORG_B, {})
			const response = await h.kiosk('POST', `/punch?orgId=${ORG_B}`, {
				secret,
				body: {
					id: crypto.randomUUID(),
					kind: 'clock_in',
					pin: staffB.pin,
					clientAt: h.clock.now,
					orgId: ORG_B,
				},
			})
			expect([400, 401]).toContain(response.status)
			expect(
				await h.db(ORG_B).then((db) => db.select().from(timeEntries)),
			).toHaveLength(0)
		})

		it('exposes no roster, pay or admin surface to a device', async () => {
			for (const [method, path] of [
				['GET', '/staff'],
				['GET', '/entries'],
				['GET', '/devices'],
				['GET', '/policies'],
				['POST', '/pairing-codes'],
			] as const) {
				const response = await h.kiosk(method, path, { secret })
				expect(response.status, path).toBe(404)
			}
		})
	})

	describe('kill switch', () => {
		it.each(['false', 'FALSE', '0', 'off', 'no', 'disabled'])(
			'STAFFING_KIOSK_ENABLED=%s turns every kiosk route off',
			async (value) => {
				const { secret } = await h.pair(ORG_A, LOC_1)
				const { pin } = await h.seedStaff(ORG_A, {})
				vi.stubEnv('STAFFING_KIOSK_ENABLED', value)
				for (const [method, path, body] of [
					['GET', '/config', undefined],
					['GET', '/people', undefined],
					['POST', '/identify', { pin }],
					[
						'POST',
						'/punch',
						{
							id: crypto.randomUUID(),
							kind: 'clock_in',
							pin,
							clientAt: h.clock.now,
						},
					],
					['POST', '/pair', { code: 'kpc1.x.y' }],
				] as const) {
					const response = await h.kiosk(method, path, { secret, body })
					expect(response.status, path).toBe(503)
					expect(response.body.error).toBe('kiosk_disabled')
				}
				expect(
					await h.db(ORG_A).then((db) => db.select().from(timePunches)),
				).toHaveLength(0)
			},
		)

		it.each(['true', '1', 'on', ''])(
			'STAFFING_KIOSK_ENABLED=%j leaves the kiosk on',
			async (value) => {
				const { secret } = await h.pair(ORG_A, LOC_1)
				vi.stubEnv('STAFFING_KIOSK_ENABLED', value)
				expect((await h.kiosk('GET', '/config', { secret })).status).toBe(200)
			},
		)

		it('the same device works again as soon as the switch is cleared', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			vi.stubEnv('STAFFING_KIOSK_ENABLED', 'false')
			expect((await h.kiosk('GET', '/config', { secret })).status).toBe(503)
			vi.stubEnv('STAFFING_KIOSK_ENABLED', 'true')
			expect((await h.kiosk('GET', '/config', { secret })).status).toBe(200)
		})
	})

	describe('transport', () => {
		const appOrigin = () => `https://app.${ENV.ROOT_APP || 'epic-startup.test'}`

		it('answers a preflight from the app origin and refuses an unknown origin', async () => {
			const allowed = await h.app.request('/kiosk/punch', {
				method: 'OPTIONS',
				headers: {
					Origin: appOrigin(),
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers': 'authorization, content-type',
				},
			})
			expect(allowed.status).toBe(204)
			expect(allowed.headers.get('access-control-allow-origin')).toBe(
				appOrigin(),
			)
			const denied = await h.app.request('/kiosk/punch', {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://evil.example',
					'Access-Control-Request-Method': 'POST',
				},
			})
			expect(denied.status).toBe(403)
		})

		it('never lets a shared cache keep a kiosk response', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const response = await h.kiosk('GET', '/config', { secret })
			expect(response.headers.get('cache-control')).toMatch(/no-store/)
			const failure = await h.kiosk('GET', '/config', { secret: 'x' })
			expect(failure.headers.get('cache-control')).toMatch(/no-store/)
		})

		it('refuses oversized and non-JSON bodies', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const big = await h.kiosk('POST', '/identify', {
				secret,
				rawBody: JSON.stringify({ pin: '1'.repeat(2 * 1024 * 1024) }),
			})
			expect(big.status).toBe(413)
			const text = await h.kiosk('POST', '/identify', {
				secret,
				rawBody: 'pin=1234',
			})
			expect(text.status).toBe(400)
		})

		it('rejects unknown fields on every body', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const { pin } = await h.seedStaff(ORG_A, {})
			for (const [path, body] of [
				['/identify', { pin, role: 'admin' }],
				[
					'/punch',
					{
						id: crypto.randomUUID(),
						kind: 'clock_in',
						pin,
						clientAt: h.clock.now,
						scopeId: LOC_2,
					},
				],
				[
					'/punch',
					{
						id: crypto.randomUUID(),
						kind: 'clock_in',
						pin,
						clientAt: h.clock.now,
						staffId: 'x',
						clockInAt: 1,
					},
				],
			] as const) {
				const response = await h.kiosk('POST', path, { secret, body })
				expect(response.status, path).toBe(400)
			}
			expect(
				await h.db(ORG_A).then((db) => db.select().from(timeEntries)),
			).toHaveLength(0)
		})

		it('never echoes a rejected value back', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const response = await h.kiosk('POST', '/punch', {
				secret,
				body: {
					id: crypto.randomUUID(),
					kind: 'sneaky-kind',
					pin: '4827',
					clientAt: 1,
				},
			})
			expect(response.status).toBe(400)
			expect(response.raw).not.toContain('sneaky-kind')
		})
	})

	describe('data minimization', () => {
		it('every response carries a first name and a state, never a surname, contact, pay or PIN', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const staff = await h.seedStaff(ORG_A, {
				firstName: 'Rana',
				lastName: 'Khalidov',
				positions: [{ name: 'Cook', rateMinor: 2750 }],
				pin: '4827',
			})
			const db = await h.db(ORG_A)
			const { staffMembers } = await import('@repo/tenant-db')
			await db
				.update(staffMembers)
				.set({ email: 'rana.private@example.com', phone: '+14155550177' })
				.where(eq(staffMembers.id, staff.staffId))

			const responses = [
				await h.kiosk('GET', '/config', { secret }),
				await identify(secret, '4827'),
				await h.punch(secret, { pin: '4827', kind: 'clock_in' }),
			]
			h.advance(HOUR)
			responses.push(
				await h.punch(secret, {
					pin: '4827',
					kind: 'clock_out',
					cashTipsMinor: 1000,
				}),
			)
			responses.push(await h.punch(secret, { pin: '4827', kind: 'clock_out' }))
			for (const response of responses) {
				for (const secretValue of [
					'Khalidov',
					'rana.private',
					'4155550177',
					'2750',
					'4827',
					staff.staffId,
					'rateMinor',
					'pinLookup',
				]) {
					expect(response.raw, secretValue).not.toContain(secretValue)
				}
			}
			expect(Object.keys(responses[2]!.body).sort()).toEqual([
				'at',
				'duplicate',
				'firstName',
				'kind',
				'outcome',
				'serverNow',
				'state',
			])
		})

		it('stores no raw address and no PIN anywhere in the clock tables', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const staff = await h.seedStaff(ORG_A, { pin: '4827' })
			await h.kiosk('POST', '/punch', {
				secret,
				headers: {
					'x-forwarded-for': '203.0.113.9',
					'cf-connecting-ip': '203.0.113.9',
				},
				body: {
					id: crypto.randomUUID(),
					kind: 'clock_in',
					pin: '4827',
					clientAt: h.clock.now,
				},
			})
			const db = await h.db(ORG_A)
			const dump = JSON.stringify([
				await db.select().from(timePunches),
				await db.select().from(timeEntries),
				await db.select().from(staffAuditLog),
			])
			expect(dump).not.toContain('203.0.113.9')
			expect(dump).not.toContain('"4827"')
			expect(dump).toMatch(/"ipHash":"[0-9a-f]{64}"/)
			void staff
		})
	})

	describe('append-only punches', () => {
		it('a punch row can be neither changed nor removed, whatever the outcome', async () => {
			const { secret } = await h.pair(ORG_A, LOC_1)
			const { pin } = await h.seedStaff(ORG_A, {})
			await h.punch(secret, { pin, kind: 'clock_in' })
			await h.punch(secret, { pin, kind: 'clock_in' })
			const db = await h.db(ORG_A)
			expect(
				(await db.select().from(timePunches)).map((p) => p.outcome).sort(),
			).toEqual(['accepted', 'rejected_state'])
			await expect(
				db.update(timePunches).set({ outcome: 'accepted' }),
			).rejects.toThrow()
			await expect(db.delete(timePunches)).rejects.toThrow()
		})
	})

	describe('regional node', () => {
		it('works the same on a KSA node, with no control plane involved', async () => {
			await h.cleanup()
			orgs.set(ORG_A, makeOrg(ORG_A, { dataRegion: 'ksa' }))
			h = await createClockHarness([ORG_A], 'ksa')
			facts.set(LOC_1, { name: 'Riyadh', timeZone: 'Asia/Riyadh' })
			const { secret } = await h.pair(ORG_A, LOC_1)
			const { pin } = await h.seedStaff(ORG_A, {})
			expect((await h.punch(secret, { pin, kind: 'clock_in' })).status).toBe(
				200,
			)
			expect(
				(await h.db(ORG_A).then((db) => db.select().from(timeEntries)))[0]!
					.timeZone,
			).toBe('Asia/Riyadh')
			const created = await h.operator('POST', '/kiosk/pairing-codes', {
				body: { scopeId: LOC_1, deviceName: 'x' },
			})
			expect(created.body.fragment).toContain('r=ksa')
		})
	})

	it('restores the real clock after each test', () => {
		expect(kioskDeps.punch.now()).toBe(h.clock.now)
	})
})
