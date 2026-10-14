import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { staffMembers } from '@repo/tenant-db'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	scheduleFixture,
	type ClockHarness,
	type ScheduleFixture,
} from '../../tests/schedule-harness.ts'
import {
	listPublishedShifts,
	matchPublishedShift,
	SHIFT_MATCH_LEAD_MS,
} from './schedule-registry.ts'
import { defaultPunchDeps } from './punch-service.ts'
import { scheduleSeam } from './schedule-seam.ts'

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

const HOUR = 3_600_000

describe('the schedule behind the time clock', () => {
	let h: ClockHarness
	let s: ScheduleFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		h = await createClockHarness([ORG_A])
		s = scheduleFixture(h)
		h.setClock(at('2026-03-02', '12:00'))
	})
	afterEach(async () => {
		await h.cleanup()
	})

	it('is registered when the schedule routes load', () => {
		expect(defaultPunchDeps.matchShift).toBe(matchPublishedShift)
		expect(scheduleSeam.listShifts).toBe(listPublishedShifts)
	})

	describe('matching a punch to a published shift', () => {
		it('says "not available" until the scope has published a schedule', async () => {
			const { staffId } = await s.staff()
			await s.shift({ staffId, date: '2026-03-03' })
			const db = await h.db(ORG_A)
			const input = {
				staffId,
				scopeId: LOC_1,
				atMs: at('2026-03-03', '09:00'),
				timeZone: CHI,
			}
			expect(await matchPublishedShift(db, input)).toBeUndefined()
			await s.publish(LOC_1, '2026-03-02')
			expect(await matchPublishedShift(db, input)).toMatchObject({
				startAt: at('2026-03-03', '09:00'),
				endAt: at('2026-03-03', '17:00'),
			})
			// Another scope with no schedule of its own stays "not available".
			expect(
				await matchPublishedShift(db, { ...input, scopeId: LOC_2 }),
			).toBeUndefined()
		})

		it('finds the current or next shift within the lead window and nothing else', async () => {
			const { staffId } = await s.staff()
			const other = await s.staff()
			await s.shift({
				staffId,
				date: '2026-03-03',
				start: '09:00',
				end: '13:00',
			})
			await s.shift({
				staffId,
				date: '2026-03-03',
				start: '17:00',
				end: '21:00',
			})
			await s.shift({
				staffId: other.staffId,
				date: '2026-03-03',
				start: '09:00',
				end: '13:00',
			})
			await s.publish(LOC_1, '2026-03-02')
			const db = await h.db(ORG_A)
			const ask = (atMs: number, who = staffId) =>
				matchPublishedShift(db, {
					staffId: who,
					scopeId: LOC_1,
					atMs,
					timeZone: CHI,
				})
			const nine = at('2026-03-03', '09:00')
			expect((await ask(nine - 2 * HOUR))!.startAt).toBe(nine)
			expect(await ask(nine - SHIFT_MATCH_LEAD_MS - 1)).toBeNull()
			expect((await ask(nine + HOUR))!.startAt).toBe(nine)
			// After the morning shift the evening one is next.
			expect((await ask(at('2026-03-03', '14:00')))!.startAt).toBe(
				at('2026-03-03', '17:00'),
			)
			expect(await ask(at('2026-03-03', '22:00'))).toBeNull()
		})

		it('ignores drafts, open shifts and pending edits, and uses the published times', async () => {
			const { staffId } = await s.staff()
			const live = await s.shift({
				staffId,
				date: '2026-03-03',
				start: '09:00',
				end: '13:00',
			})
			await s.publish(LOC_1, '2026-03-02')
			await s.send('PATCH', `/shifts/${live.id}`, {
				startTime: '15:00',
				endTime: '19:00',
			})
			await s.shift({ staffId, date: '2026-03-04' }) // draft
			await s.shift({ date: '2026-03-03', start: '09:00', end: '13:00' }) // open draft
			const db = await h.db(ORG_A)
			const match = await matchPublishedShift(db, {
				staffId,
				scopeId: LOC_1,
				atMs: at('2026-03-03', '08:00'),
				timeZone: CHI,
			})
			expect(match!.startAt).toBe(at('2026-03-03', '09:00'))
			expect(
				await matchPublishedShift(db, {
					staffId,
					scopeId: LOC_1,
					atMs: at('2026-03-04', '08:00'),
					timeZone: CHI,
				}),
			).toBeNull()
		})
	})

	describe('listing what is scheduled', () => {
		it('lists only published shifts of people still on the roster, in start order', async () => {
			const a = await s.staff()
			const b = await s.staff()
			await s.shift({
				staffId: b.staffId,
				date: '2026-03-04',
				start: '08:00',
				end: '12:00',
			})
			await s.shift({
				staffId: a.staffId,
				date: '2026-03-03',
				start: '09:00',
				end: '13:00',
			})
			await s.shift({ date: '2026-03-03', start: '09:00', end: '13:00' })
			const db = await h.db(ORG_A)
			const query = {
				startsFromMs: at('2026-03-01', '00:00'),
				startsToMs: at('2026-03-09', '00:00'),
			}
			expect(await listPublishedShifts(db, query)).toBeUndefined()
			await s.publish(LOC_1, '2026-03-02')
			await s.shift({ staffId: a.staffId, date: '2026-03-05' }) // new draft
			const listed = await listPublishedShifts(db, query)
			expect(listed!.map((x) => [x.staffId, x.startAt])).toEqual([
				[a.staffId, at('2026-03-03', '09:00')],
				[b.staffId, at('2026-03-04', '08:00')],
			])
			expect(listed![0]).toMatchObject({ scopeId: LOC_1, positionId: null })
			// The window is half-open: a shift starting exactly at the end is out.
			const narrow = await listPublishedShifts(db, {
				startsFromMs: at('2026-03-03', '09:00'),
				startsToMs: at('2026-03-04', '08:00'),
			})
			expect(narrow!.map((x) => x.staffId)).toEqual([a.staffId])
		})

		it('leaves out someone who has left', async () => {
			const a = await s.staff()
			await s.shift({ staffId: a.staffId, date: '2026-03-03' })
			await s.publish(LOC_1, '2026-03-02')
			const db = await h.db(ORG_A)
			await db
				.update(staffMembers)
				.set({ status: 'terminated' })
				.where(eq(staffMembers.id, a.staffId))
			expect(
				await listPublishedShifts(db, {
					startsFromMs: 0,
					startsToMs: Number.MAX_SAFE_INTEGER,
				}),
			).toEqual([])
		})
	})

	describe('through the kiosk', () => {
		it('judges punches on the schedule only once the scope has published one', async () => {
			await s.setPolicy(LOC_1, {
				preventEarlyMinutes: 30,
				allowUnscheduled: false,
			})
			const a = await h.seedStaff(ORG_A, { positions: [{ name: 'Cook' }] })
			const b = await h.seedStaff(ORG_A, { positions: [{ name: 'Cook' }] })
			const { secret } = await h.pair(ORG_A, LOC_1)

			// No schedule published yet: the time clock works on its own, as before.
			const free = await h.punch(secret, { pin: b.pin, kind: 'clock_in' })
			expect(free.status).toBe(200)
			await h.punch(secret, { pin: b.pin, kind: 'clock_out' })

			await s.shift({
				staffId: a.staffId,
				date: '2026-03-03',
				start: '09:00',
				end: '17:00',
			})
			await s.publish(LOC_1, '2026-03-02')

			h.setClock(at('2026-03-03', '07:00'))
			const early = await h.punch(secret, { pin: a.pin, kind: 'clock_in' })
			expect(early.status).toBe(422)
			expect(early.body.error).toBe('early_clock_in')
			expect(early.body.earliestAt).toBe(at('2026-03-03', '08:30'))

			h.setClock(at('2026-03-03', '08:45'))
			const inTime = await h.punch(secret, { pin: a.pin, kind: 'clock_in' })
			expect(inTime.status).toBe(200)

			const stranger = await h.punch(secret, { pin: b.pin, kind: 'clock_in' })
			expect(stranger.body.error).toBe('unscheduled_not_allowed')
		})
	})
})
