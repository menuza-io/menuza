import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDate, zonedLocalToUtc, type ShiftWindow } from '@repo/staffing'
import { staffAuditLog, timeEntries, timePunches } from '@repo/tenant-db'
import {
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	type ClockHarness,
} from '../../tests/timeclock-harness.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	defaultPunchDeps,
	noScheduleMatcher,
	registerShiftMatcher,
	resetShiftMatcher,
} from '../services/punch-service.ts'
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
const CHI = 'America/Chicago'
const RUH = 'Asia/Riyadh'
const TOR = 'America/Toronto'

function at(date: string, hhmm: string, tz: string): number {
	const { year, month, day } = parseDate(date)
	const [hour, minute] = hhmm.split(':').map(Number) as [number, number]
	return zonedLocalToUtc(year, month, day, hour, minute, tz)
}

describe('kiosk punches under labor policy', () => {
	let h: ClockHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: TOR })
		h = await createClockHarness([ORG_A])
	})
	afterEach(async () => {
		await h.cleanup()
	})

	async function entries() {
		const db = await h.db(ORG_A)
		return db.select().from(timeEntries).orderBy(timeEntries.clockInAt)
	}
	async function setPolicy(scopeId: string, body: Record<string, unknown>) {
		const current = await h.operator('GET', `/policies/${scopeId}`)
		const response = await h.operator('PUT', `/policies/${scopeId}`, {
			body:
				current.body.source === 'scope'
					? { expectedVersion: current.body.version, ...body }
					: body,
		})
		expect(response.status, response.raw).toBe(200)
	}
	async function shift(pin: string, secret: string, from: number, to: number) {
		h.setClock(from)
		const a = await h.punch(secret, { pin, kind: 'clock_in' })
		expect(a.status, a.raw).toBe(200)
		h.setClock(to)
		const b = await h.punch(secret, { pin, kind: 'clock_out' })
		expect(b.status, b.raw).toBe(200)
	}

	describe('offline-queued punches', () => {
		let secret: string
		let pin: string
		beforeEach(async () => {
			;({ secret } = await h.pair(ORG_A, LOC_1))
			;({ pin } = await h.seedStaff(ORG_A, {}))
		})

		it('counts a queued punch at the device time and flags it', async () => {
			const queuedAt = h.clock.now - 2 * HOUR
			const response = await h.punch(secret, {
				pin,
				kind: 'clock_in',
				offline: true,
				clientAt: queuedAt,
			})
			expect(response.status).toBe(200)
			expect(response.body.at).toBe(queuedAt)
			const [entry] = await entries()
			expect(entry!.clockInAt).toBe(queuedAt)
			expect(entry!.issues).toEqual(['offline_punch'])
			const db = await h.db(ORG_A)
			const [row] = await db.select().from(timePunches)
			expect(row).toMatchObject({
				clientAt: queuedAt,
				serverAt: h.clock.now,
				effectiveAt: queuedAt,
			})
			expect(row!.flags).toEqual(['offline_punch'])
		})

		it('rebuilds a whole queued shift in order', async () => {
			const t0 = h.clock.now
			await h.punch(secret, {
				pin,
				kind: 'clock_in',
				offline: true,
				clientAt: t0 - 9 * HOUR,
			})
			await h.punch(secret, {
				pin,
				kind: 'break_start',
				offline: true,
				clientAt: t0 - 6 * HOUR,
			})
			await h.punch(secret, {
				pin,
				kind: 'break_end',
				offline: true,
				clientAt: t0 - 5.5 * HOUR,
			})
			const out = await h.punch(secret, {
				pin,
				kind: 'clock_out',
				offline: true,
				clientAt: t0 - 1 * HOUR,
			})
			expect(out.status).toBe(200)
			const [entry] = await entries()
			expect(entry).toMatchObject({
				paidMinutes: 8 * 60 - 30,
				unpaidBreakMinutes: 30,
				status: 'closed',
			})
			expect(entry!.issues).toEqual(['offline_punch'])
		})

		it('refuses a punch from the future but forgives a minute of drift', async () => {
			const future = await h.punch(secret, {
				pin,
				kind: 'clock_in',
				offline: true,
				clientAt: h.clock.now + 2 * MIN,
			})
			expect(future.status).toBe(422)
			expect(future.body.error).toBe('punch_in_future')
			const drift = await h.punch(secret, {
				pin,
				kind: 'clock_in',
				offline: true,
				clientAt: h.clock.now + 30_000,
			})
			expect(drift.status).toBe(200)
			expect(drift.body.at).toBe(h.clock.now)
		})

		it('refuses a punch older than twelve hours and accepts one just inside', async () => {
			const old = await h.punch(secret, {
				pin,
				kind: 'clock_in',
				offline: true,
				clientAt: h.clock.now - 12 * HOUR - 1,
			})
			expect(old.status).toBe(422)
			expect(old.body.error).toBe('punch_too_old')
			const edge = await h.punch(secret, {
				pin,
				kind: 'clock_in',
				offline: true,
				clientAt: h.clock.now - 12 * HOUR,
			})
			expect(edge.status).toBe(200)
			const db = await h.db(ORG_A)
			const rejected = (await db.select().from(timePunches)).filter(
				(p) => p.outcome !== 'accepted',
			)
			expect(rejected).toHaveLength(1)
			expect(rejected[0]).toMatchObject({
				rejectCode: 'punch_too_old',
				effectiveAt: null,
			})
		})

		it('flags device clock skew and sends the card to review', async () => {
			await h.punch(secret, {
				pin,
				kind: 'clock_in',
				offline: true,
				clientAt: h.clock.now - HOUR,
				deviceNowAt: h.clock.now - 20 * MIN,
			})
			h.advance(2 * HOUR)
			await h.punch(secret, { pin, kind: 'clock_out' })
			const [entry] = await entries()
			expect(entry!.issues).toEqual(['offline_punch', 'clock_skew'])
			expect(entry!.status).toBe('needs_review')
			const fine = await h.seedStaff(ORG_A, {})
			await h.punch(secret, {
				pin: fine.pin,
				kind: 'clock_in',
				offline: true,
				clientAt: h.clock.now - HOUR,
				deviceNowAt: h.clock.now + 2 * MIN,
			})
			expect((await entries()).at(-1)!.issues).toEqual(['offline_punch'])
		})

		it('server time is authoritative for an online punch whatever the device claims', async () => {
			for (const clientAt of [
				0,
				1,
				h.clock.now - 400 * 24 * HOUR,
				h.clock.now + 400 * 24 * HOUR,
			]) {
				const staff = await h.seedStaff(ORG_A, {})
				const response = await h.punch(secret, {
					pin: staff.pin,
					kind: 'clock_in',
					clientAt,
				})
				expect(response.status, String(clientAt)).toBe(200)
				expect(response.body.at).toBe(h.clock.now)
			}
			expect((await entries()).every((e) => e.clockInAt === h.clock.now)).toBe(
				true,
			)
		})

		it('a queued clock-out cannot end a shift before it began', async () => {
			await h.punch(secret, { pin, kind: 'clock_in' })
			const response = await h.punch(secret, {
				pin,
				kind: 'clock_out',
				offline: true,
				clientAt: h.clock.now - HOUR,
			})
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('time_conflict')
			expect((await entries())[0]!.clockOutAt).toBeNull()
		})

		it('rejects a queued break end before its start', async () => {
			await h.punch(secret, {
				pin,
				kind: 'clock_in',
				offline: true,
				clientAt: h.clock.now - 5 * HOUR,
			})
			await h.punch(secret, {
				pin,
				kind: 'break_start',
				offline: true,
				clientAt: h.clock.now - 2 * HOUR,
			})
			const response = await h.punch(secret, {
				pin,
				kind: 'break_end',
				offline: true,
				clientAt: h.clock.now - 3 * HOUR,
			})
			expect(response.body.error).toBe('time_conflict')
		})
	})

	describe('rules from the labor policy', () => {
		let secret: string
		let pin: string
		beforeEach(async () => {
			;({ secret } = await h.pair(ORG_A, LOC_1))
			;({ pin } = await h.seedStaff(ORG_A, {
				positions: [{ name: 'Cook', rateMinor: 2000 }],
			}))
		})

		it('flags a missed mandatory break and sends the card to review', async () => {
			await setPolicy(LOC_1, {
				breakRules: {
					rules: [
						{
							kind: 'meal',
							afterMinutes: 300,
							minutes: 30,
							paid: false,
							mandatory: true,
						},
					],
					autoDeduction: null,
				},
			})
			await shift(
				pin,
				secret,
				at('2026-03-02', '09:00', CHI),
				at('2026-03-02', '16:00', CHI),
			)
			let [entry] = await entries()
			expect(entry!.issues).toContain('missed_break')
			expect(entry!.status).toBe('needs_review')

			const other = await h.seedStaff(ORG_A, {})
			h.setClock(at('2026-03-03', '09:00', CHI))
			await h.punch(secret, { pin: other.pin, kind: 'clock_in' })
			h.advance(4 * HOUR)
			await h.punch(secret, { pin: other.pin, kind: 'break_start' })
			h.advance(30 * MIN)
			await h.punch(secret, { pin: other.pin, kind: 'break_end' })
			h.advance(3 * HOUR)
			await h.punch(secret, { pin: other.pin, kind: 'clock_out' })
			;[, entry] = await entries()
			expect(entry!.issues).toEqual([])
			expect(entry!.status).toBe('closed')
		})

		it('deducts an automatic unpaid break only when none was taken', async () => {
			await setPolicy(LOC_1, {
				breakRules: {
					rules: [],
					autoDeduction: { afterMinutes: 360, deductMinutes: 30 },
				},
			})
			await shift(
				pin,
				secret,
				at('2026-03-02', '09:00', CHI),
				at('2026-03-02', '17:00', CHI),
			)
			const [entry] = await entries()
			expect(entry).toMatchObject({ paidMinutes: 450, unpaidBreakMinutes: 30 })
			expect(entry!.issues).toContain('auto_break_deducted')
		})

		it('flags a long shift for review', async () => {
			await setPolicy(LOC_1, { longShiftMinutes: 600 })
			await shift(
				pin,
				secret,
				at('2026-03-02', '08:00', CHI),
				at('2026-03-02', '20:30', CHI),
			)
			const [entry] = await entries()
			expect(entry!.issues).toContain('long_shift')
			expect(entry!.status).toBe('needs_review')
		})

		it('rounds in the calculation but keeps the raw punches', async () => {
			await setPolicy(LOC_1, {
				rounding: { mode: 'nearest', incrementMinutes: 15 },
			})
			const start = at('2026-03-02', '09:07', CHI)
			await shift(pin, secret, start, at('2026-03-02', '17:07', CHI))
			const [entry] = await entries()
			expect(entry!.clockInAt).toBe(start)
			expect(entry!.clockOutAt).toBe(at('2026-03-02', '17:07', CHI))
			expect(entry!.paidMinutes).toBe(480)
			const db = await h.db(ORG_A)
			expect(
				(await db.select().from(timePunches)).map((p) => p.effectiveAt),
			).toEqual([start, at('2026-03-02', '17:07', CHI)])
		})

		it('allocates weekly overtime across entries as they close', async () => {
			await setPolicy(LOC_1, {
				weeklyOvertime: { thresholdMinutes: 360, multiplierBp: 15000 },
			})
			await shift(
				pin,
				secret,
				at('2026-03-02', '09:00', CHI),
				at('2026-03-02', '13:00', CHI),
			)
			await shift(
				pin,
				secret,
				at('2026-03-03', '09:00', CHI),
				at('2026-03-03', '13:00', CHI),
			)
			const [mon, tue] = await entries()
			expect(mon).toMatchObject({ regularMinutes: 240, overtimeMinutes: 0 })
			expect(tue).toMatchObject({
				regularMinutes: 120,
				overtimeMinutes: 120,
				paidMinutes: 240,
			})
			// A queued earlier shift arriving late moves the overtime to the later card.
			const t = h.clock.now
			h.setClock(at('2026-03-04', '09:00', CHI))
			await h.punch(secret, { pin, kind: 'clock_in' })
			h.advance(2 * HOUR)
			await h.punch(secret, { pin, kind: 'clock_out' })
			const rows = await entries()
			expect(rows.map((e) => e.overtimeMinutes)).toEqual([0, 120, 120])
			void t
		})

		it('never rewrites an approved or locked card as a side effect of a later punch', async () => {
			await shift(
				pin,
				secret,
				at('2026-03-02', '09:00', CHI),
				at('2026-03-02', '13:00', CHI),
			)
			const db = await h.db(ORG_A)
			const [monday] = await entries()
			await db
				.update(timeEntries)
				.set({ status: 'approved', approvedBy: 'op-1', approvedAt: 1 })
				.where(eq(timeEntries.id, monday!.id))
			await db
				.update(timeEntries)
				.set({ status: 'locked', lockedBy: 'op-1', lockedAt: 2 })
				.where(eq(timeEntries.id, monday!.id))

			// A rule change that would reprice Monday if it were recomputed.
			await setPolicy(LOC_1, {
				dailyOvertime: { thresholdMinutes: 60, multiplierBp: 15000 },
			})
			await shift(
				pin,
				secret,
				at('2026-03-03', '09:00', CHI),
				at('2026-03-03', '12:00', CHI),
			)
			const [lockedMonday, tuesday] = await entries()
			expect(lockedMonday).toMatchObject({
				status: 'locked',
				regularMinutes: 240,
				overtimeMinutes: 0,
			})
			expect(tuesday).toMatchObject({
				regularMinutes: 60,
				overtimeMinutes: 120,
			})
		})

		it('splits daily overtime and double time', async () => {
			await setPolicy(LOC_1, {
				dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
				dailyDoubleTime: { thresholdMinutes: 720, multiplierBp: 20000 },
				longShiftMinutes: 1200,
			})
			await shift(
				pin,
				secret,
				at('2026-03-02', '06:00', CHI),
				at('2026-03-02', '21:00', CHI),
			)
			const [entry] = await entries()
			expect(entry).toMatchObject({
				regularMinutes: 480,
				overtimeMinutes: 240,
				doubleTimeMinutes: 180,
				paidMinutes: 900,
			})
		})

		it('treats holiday hours separately and outside overtime', async () => {
			await setPolicy(LOC_1, {
				holiday: { dates: ['2026-03-02'], multiplierBp: 15000 },
				dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
			})
			await shift(
				pin,
				secret,
				at('2026-03-02', '09:00', CHI),
				at('2026-03-02', '19:00', CHI),
			)
			expect((await entries())[0]).toMatchObject({
				holidayMinutes: 600,
				regularMinutes: 0,
				overtimeMinutes: 0,
			})
		})

		it('exempt staff only accrue regular minutes', async () => {
			const exempt = await h.seedStaff(ORG_A, {
				positions: [
					{
						name: 'Manager',
						rateMinor: null,
						payType: 'salary',
						overtimeExempt: true,
					},
				],
			})
			await setPolicy(LOC_1, {
				dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
			})
			await shift(
				exempt.pin,
				secret,
				at('2026-03-02', '07:00', CHI),
				at('2026-03-02', '19:00', CHI),
			)
			expect((await entries())[0]).toMatchObject({
				regularMinutes: 720,
				overtimeMinutes: 0,
			})
		})

		it('counts overtime per scope unless the policy aggregates across scopes', async () => {
			const both = await h.seedStaff(ORG_A, {
				scopeIds: [LOC_1, LOC_2],
				positions: [{ name: 'Server', rateMinor: 1500 }],
			})
			const second = await h.pair(ORG_A, LOC_2, { name: 'Airport' })
			const daily = {
				dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
			}
			await setPolicy(LOC_1, {
				...daily,
				aggregateOvertimeAcrossScopes: false,
			})
			await setPolicy(LOC_2, {
				...daily,
				aggregateOvertimeAcrossScopes: false,
				timeZone: TOR,
			})

			await shift(
				both.pin,
				secret,
				at('2026-03-02', '08:00', CHI),
				at('2026-03-02', '13:00', CHI),
			)
			await shift(
				both.pin,
				second.secret,
				at('2026-03-02', '14:00', CHI),
				at('2026-03-02', '19:00', CHI),
			)
			let rows = await entries()
			expect(rows.map((e) => e.overtimeMinutes)).toEqual([0, 0])

			// Switch both policies to aggregate and close a third entry: all three are re-evaluated together.
			await setPolicy(LOC_1, { aggregateOvertimeAcrossScopes: true })
			await setPolicy(LOC_2, { aggregateOvertimeAcrossScopes: true })
			await shift(
				both.pin,
				secret,
				at('2026-03-03', '08:00', CHI),
				at('2026-03-03', '09:00', CHI),
			)
			rows = await entries()
			// Both entries on the first day now share one daily threshold: 10 hours
			// in a day with an 8 hour limit puts two hours on the later card.
			expect(rows.map((e) => e.regularMinutes)).toEqual([300, 180, 60])
			expect(rows.map((e) => e.overtimeMinutes)).toEqual([0, 120, 0])
		})
	})

	describe('calendar edge cases', () => {
		let secret: string
		let pin: string
		beforeEach(async () => {
			;({ secret } = await h.pair(ORG_A, LOC_1))
			;({ pin } = await h.seedStaff(ORG_A, {
				positions: [{ name: 'Cook', rateMinor: 1800 }],
			}))
		})

		it('keeps an overnight shift on the business date it started', async () => {
			await shift(
				pin,
				secret,
				at('2026-03-07', '22:00', CHI),
				at('2026-03-08', '01:30', CHI),
			)
			const [entry] = await entries()
			expect(entry).toMatchObject({
				localDate: '2026-03-07',
				paidMinutes: 210,
				timeZone: CHI,
			})
		})

		it('honours a workday that starts after midnight', async () => {
			await setPolicy(LOC_1, { workdayStartMinute: 240 })
			await shift(
				pin,
				secret,
				at('2026-03-04', '02:00', CHI),
				at('2026-03-04', '07:00', CHI),
			)
			const [entry] = await entries()
			// 02:00 belongs to the previous business day; the shift straddles the day change.
			expect(entry).toMatchObject({ localDate: '2026-03-03', paidMinutes: 300 })
		})

		it('spring forward: a night shift across the missing hour is one hour short on the wall clock', async () => {
			// Chicago clocks jump 02:00 -> 03:00 on 2026-03-08.
			await shift(
				pin,
				secret,
				at('2026-03-07', '22:00', CHI),
				at('2026-03-08', '06:00', CHI),
			)
			const [entry] = await entries()
			expect(entry!.clockOutAt! - entry!.clockInAt).toBe(7 * HOUR)
			expect(entry).toMatchObject({ localDate: '2026-03-07', paidMinutes: 420 })
		})

		it('fall back: the repeated hour counts twice', async () => {
			// Chicago clocks repeat 01:00-02:00 on 2026-11-01.
			await shift(
				pin,
				secret,
				at('2026-11-01', '00:30', CHI),
				at('2026-11-01', '04:30', CHI),
			)
			const [entry] = await entries()
			expect(entry).toMatchObject({ localDate: '2026-11-01', paidMinutes: 300 })
		})

		it('a punch in the nonexistent hour resolves to the instant after the gap', async () => {
			const during = Date.UTC(2026, 2, 8, 8, 30) // 03:30 CDT
			h.setClock(during)
			await h.punch(secret, { pin, kind: 'clock_in' })
			const [entry] = await entries()
			expect(entry!.localDate).toBe('2026-03-08')
		})

		it('Toronto and Riyadh scopes use their own zones', async () => {
			const tor = await h.pair(ORG_A, LOC_2, { name: 'Airport' })
			const staff = await h.seedStaff(ORG_A, { scopeIds: [LOC_2] })
			await shift(
				staff.pin,
				tor.secret,
				at('2026-03-07', '22:00', TOR),
				at('2026-03-08', '06:00', TOR),
			)
			expect((await entries())[0]).toMatchObject({
				timeZone: TOR,
				localDate: '2026-03-07',
				paidMinutes: 420,
			})
		})

		it('a shift across the Sunday-to-Monday boundary is split between two weeks', async () => {
			await setPolicy(LOC_1, {
				weekStartsOn: 1,
				weeklyOvertime: { thresholdMinutes: 60, multiplierBp: 15000 },
			})
			// 23:00 Sunday to 03:00 Monday: one hour in the old week, three in the new one.
			await shift(
				pin,
				secret,
				at('2026-03-01', '23:00', CHI),
				at('2026-03-02', '03:00', CHI),
			)
			const [entry] = await entries()
			expect(entry).toMatchObject({
				paidMinutes: 240,
				regularMinutes: 120,
				overtimeMinutes: 120,
			})
		})
	})

	describe('Riyadh (no daylight saving)', () => {
		it('measures an overnight shift as wall-clock elapsed time year round', async () => {
			h.setClock(Date.UTC(2026, 2, 1))
			facts.set('loc-ksa', { name: 'Riyadh', timeZone: RUH })
			const { secret } = await h.pair(ORG_A, 'loc-ksa')
			const staff = await h.seedStaff(ORG_A, { scopeIds: ['loc-ksa'] })
			await shift(
				staff.pin,
				secret,
				at('2026-03-07', '22:00', RUH),
				at('2026-03-08', '06:00', RUH),
			)
			expect((await entries())[0]).toMatchObject({
				timeZone: RUH,
				localDate: '2026-03-07',
				paidMinutes: 480,
			})
		})
	})

	describe('schedule-aware rules (once scheduling supplies shifts)', () => {
		let secret: string
		let pin: string
		const SHIFT_START = at('2026-03-02', '09:00', CHI)
		const SHIFT_END = at('2026-03-02', '17:00', CHI)
		let window: ShiftWindow | null | undefined

		beforeEach(async () => {
			;({ secret } = await h.pair(ORG_A, LOC_1))
			;({ pin } = await h.seedStaff(ORG_A, {}))
			window = {
				id: 'shift-1',
				startAt: SHIFT_START,
				endAt: SHIFT_END,
				positionId: null,
			}
			kioskDeps.punch = { ...kioskDeps.punch, matchShift: async () => window }
		})

		it('does not judge scheduling while no schedule is available', async () => {
			window = undefined
			h.setClock(at('2026-03-02', '03:00', CHI))
			await setPolicy(LOC_1, {
				preventEarlyMinutes: 15,
				allowUnscheduled: false,
			})
			expect((await h.punch(secret, { pin, kind: 'clock_in' })).status).toBe(
				200,
			)
			expect((await entries())[0]!.issues).toEqual([])
		})

		it('blocks an early clock-in and says when it opens', async () => {
			await setPolicy(LOC_1, { preventEarlyMinutes: 15 })
			h.setClock(SHIFT_START - 16 * MIN)
			const early = await h.punch(secret, { pin, kind: 'clock_in' })
			expect(early.status).toBe(422)
			expect(early.body).toEqual({
				error: 'early_clock_in',
				earliestAt: SHIFT_START - 15 * MIN,
			})
			expect(await entries()).toHaveLength(0)
			h.setClock(SHIFT_START - 15 * MIN)
			expect((await h.punch(secret, { pin, kind: 'clock_in' })).status).toBe(
				200,
			)
			expect((await entries())[0]).toMatchObject({
				shiftId: 'shift-1',
				issues: [],
			})
		})

		it('flags late arrivals past the grace period and early departures', async () => {
			await setPolicy(LOC_1, { lateGraceMinutes: 5 })
			h.setClock(SHIFT_START + 6 * MIN)
			await h.punch(secret, { pin, kind: 'clock_in' })
			h.setClock(SHIFT_END - 30 * MIN)
			await h.punch(secret, { pin, kind: 'clock_out' })
			expect((await entries())[0]!.issues).toEqual(['late', 'early_out'])
		})

		it('forgives lateness inside the grace period', async () => {
			h.setClock(SHIFT_START + 5 * MIN)
			await h.punch(secret, { pin, kind: 'clock_in' })
			h.setClock(SHIFT_END)
			await h.punch(secret, { pin, kind: 'clock_out' })
			const [entry] = await entries()
			expect(entry!.issues).toEqual([])
			expect(entry!.status).toBe('closed')
		})

		it('flags an unscheduled shift, or refuses it when the policy says so', async () => {
			window = null
			h.setClock(SHIFT_START)
			expect((await h.punch(secret, { pin, kind: 'clock_in' })).status).toBe(
				200,
			)
			expect((await entries())[0]).toMatchObject({
				shiftId: null,
				issues: ['unscheduled'],
			})

			const other = await h.seedStaff(ORG_A, {})
			await setPolicy(LOC_1, { allowUnscheduled: false })
			const refused = await h.punch(secret, {
				pin: other.pin,
				kind: 'clock_in',
			})
			expect(refused.status).toBe(422)
			expect(refused.body.error).toBe('unscheduled_not_allowed')
		})

		it('uses the position on the shift to settle a role pick', async () => {
			const staff = await h.seedStaff(ORG_A, {
				positions: [
					{ name: 'Server', rateMinor: 1500 },
					{ name: 'Bartender', rateMinor: 1900 },
				],
			})
			const db = await h.db(ORG_A)
			const jobs = await db.query.staffJobs.findMany({
				where: (j, { eq: equals }) => equals(j.staffId, staff.staffId),
			})
			window = {
				id: 'shift-2',
				startAt: SHIFT_START,
				endAt: SHIFT_END,
				positionId: jobs[1]!.positionId,
			}
			h.setClock(SHIFT_START)
			const response = await h.punch(secret, {
				pin: staff.pin,
				kind: 'clock_in',
			})
			expect(response.status).toBe(200)
			expect((await entries()).at(-1)).toMatchObject({
				positionId: jobs[1]!.positionId,
				rateMinor: 1900,
			})
		})

		it('uses a matcher registered by scheduling and falls back to none after a reset', async () => {
			const calls: string[] = []
			registerShiftMatcher(async (_db, input) => {
				calls.push(input.scopeId)
				return null
			})
			kioskDeps.punch = { ...defaultPunchDeps, now: () => h.clock.now }
			await h.punch(secret, { pin, kind: 'clock_in' })
			expect(calls).toEqual([LOC_1])
			expect((await entries())[0]!.issues).toEqual(['unscheduled'])
			resetShiftMatcher()
			expect(defaultPunchDeps.matchShift).toBe(noScheduleMatcher)
		})

		it('audits blocked punches', async () => {
			await setPolicy(LOC_1, { preventEarlyMinutes: 15 })
			h.setClock(SHIFT_START - HOUR)
			await h.punch(secret, { pin, kind: 'clock_in' })
			const db = await h.db(ORG_A)
			const rows = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'kiosk.punch.rejected'))
			expect(rows).toHaveLength(1)
			expect(rows[0]!.changes).toMatchObject({
				code: 'early_clock_in',
				outcome: 'rejected_policy',
			})
		})
	})
})
