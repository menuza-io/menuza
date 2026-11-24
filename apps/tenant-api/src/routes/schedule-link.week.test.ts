import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	staffAuditLog,
	staffMembers,
	timeBreaks,
	timeCorrectionRequests,
	timeEntries,
} from '@repo/tenant-db'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	ORG_A,
	ORG_B,
	scheduleFixture,
	SCH_PAY,
	type ClockHarness,
	type ScheduleFixture,
} from '../../tests/schedule-harness.ts'
import { TS_PAY } from '../../tests/timesheet-harness.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import { resetRateLimits } from '../lib/rate-limit.ts'
import { ensureScheduleLink } from '../services/schedule-link-service.ts'
import { scheduleLinkDeps } from './schedule-link.ts'

const facts = vi.hoisted(
	() => new Map<string, { name: string; timeZone: string }>(),
)
const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(
		async (_org: string, scope: string) => facts.get(scope) ?? null,
	),
	getStaffingFeatures: vi.fn(async () => ({
		features: {
			enabled: true,
			timeclock: true,
			scheduling: true,
			hiring: false,
		},
		dataRegion: 'us',
	})),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

// 2026-03-02 is a Monday; the week runs Monday to Sunday here.
const MONDAY = '2026-03-02'
const HOUR = 3_600_000

describe('my week, estimated pay and "Something\'s wrong" (#514)', () => {
	let h: ClockHarness
	let s: ScheduleFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		resetRateLimits()
		h = await createClockHarness([ORG_A, ORG_B])
		s = scheduleFixture(h)
		h.setClock(at('2026-03-04', '12:00'))
		scheduleLinkDeps.now = () => h.clock.now
	})
	afterEach(async () => {
		scheduleLinkDeps.now = () => Date.now()
		await h.cleanup()
	})

	const db = () => h.db(ORG_A)

	async function person(first = 'Ana') {
		return s.staff({ firstName: first })
	}

	async function token(staffId: string) {
		return (await ensureScheduleLink(await db(), ORG_A, staffId, h.clock.now))
			.token
	}

	async function call(
		method: string,
		path: string,
		options: { token: string; body?: unknown },
	) {
		const response = await h.app.request(`/schedule-link${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${options.token}`,
				...(options.body !== undefined
					? { 'content-type': 'application/json' }
					: {}),
			},
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
		})
		const raw = await response.text()
		return {
			status: response.status,
			raw,
			body: raw ? (JSON.parse(raw) as any) : null,
		}
	}

	async function card(
		staffId: string,
		date: string,
		hours = 8,
		patch: Partial<typeof timeEntries.$inferInsert> = {},
	) {
		const clockIn = at(date, '09:00')
		const [row] = await (
			await db()
		)
			.insert(timeEntries)
			.values({
				staffId,
				scopeId: LOC_1,
				clockInAt: clockIn,
				clockOutAt: clockIn + hours * HOUR,
				timeZone: CHI,
				localDate: date,
				status: 'closed',
				rateMinor: 2000,
				currency: 'USD',
				...patch,
			})
			.returning()
		return row!
	}

	async function setPayEstimate(on: boolean) {
		const response = await s.send('PUT', '/settings', {
			showStaffPayEstimate: on,
		})
		expect(response.status).toBe(200)
	}

	describe('this week', () => {
		it('shows hours worked so far, hours scheduled and the next shift', async () => {
			const ana = await person()
			await s.shift({
				staffId: ana.staffId,
				date: '2026-03-05',
				start: '10:00',
				end: '18:00',
				unpaidBreakMinutes: 30,
			})
			await s.shift({
				staffId: ana.staffId,
				date: '2026-03-06',
				start: '10:00',
				end: '14:00',
			})
			expect(
				(await s.publish(LOC_1, MONDAY, { notifyMode: 'nobody' })).status,
			).toBe(200)
			await card(ana.staffId, '2026-03-02', 8)
			await card(ana.staffId, '2026-03-03', 6)
			// Last week and a colleague do not count.
			await card(ana.staffId, '2026-02-24', 8)
			const ben = await person('Ben')
			await card(ben.staffId, '2026-03-02', 8)

			const week = await call('GET', '/me/week', {
				token: await token(ana.staffId),
			})
			expect(week.status).toBe(200)
			expect(week.body).toMatchObject({
				weekStart: MONDAY,
				weekEnd: '2026-03-08',
				workedMinutes: 14 * 60,
				// 7.5 paid hours on Thursday plus 4 on Friday.
				scheduledMinutes: 450 + 240,
			})
			expect(week.body.nextShift).toMatchObject({ localDate: '2026-03-05' })
			// Pay is off until the organization turns it on, and the key is absent.
			expect(week.body).not.toHaveProperty('pay')
			for (const leak of ['rate', 'currency', 'USD']) {
				expect(week.raw).not.toContain(leak)
			}
		})

		it('shows an estimate before tax only when turned on, with overtime rules', async () => {
			const ana = await person()
			await s.setPolicy(LOC_1, {
				dailyOvertime: { thresholdMinutes: 360, multiplierBp: 15000 },
			})
			await card(ana.staffId, '2026-03-02', 8)
			const t = await token(ana.staffId)
			expect(
				(await call('GET', '/me/week', { token: t })).body,
			).not.toHaveProperty('pay')

			await setPayEstimate(true)
			const on = await call('GET', '/me/week', { token: t })
			expect(on.body.pay).toMatchObject({
				label: 'estimate_before_tax',
				currency: 'USD',
				// 6 hours at 20.00 plus 2 overtime hours at 30.00.
				estimateMinor: 6 * 2000 + 2 * 3000,
				overtimeMinutes: 120,
			})

			await setPayEstimate(false)
			expect(
				(await call('GET', '/me/week', { token: t })).body,
			).not.toHaveProperty('pay')
		})

		it('says nothing about pay for someone with no rate, and never mixes people', async () => {
			const ana = await person()
			await card(ana.staffId, '2026-03-02', 8, {
				rateMinor: null,
				currency: null,
			})
			await setPayEstimate(true)
			const week = await call('GET', '/me/week', {
				token: await token(ana.staffId),
			})
			expect(week.body.pay.estimateMinor).toBeNull()
			expect(week.body.pay.unpricedMinutes).toBe(480)
		})
	})

	describe('time cards', () => {
		it('lists the breaks, and never a pay figure', async () => {
			const ana = await person()
			const row = await card(ana.staffId, '2026-03-02', 9)
			await (await db()).insert(timeBreaks).values({
				entryId: row.id,
				kind: 'meal',
				paid: false,
				startAt: row.clockInAt + 4 * HOUR,
				endAt: row.clockInAt + 4.5 * HOUR,
			})
			const cards = await call('GET', '/me/time-cards', {
				token: await token(ana.staffId),
			})
			expect(cards.body.cards[0].breaks).toEqual([
				{
					startAt: row.clockInAt + 4 * HOUR,
					endAt: row.clockInAt + 4.5 * HOUR,
					paid: false,
				},
			])
			expect(cards.body.cards[0].correctionRequested).toBe(false)
			expect(cards.raw).not.toMatch(/rate|currency|USD/)
		})
	})

	describe('"Something\'s wrong"', () => {
		/** The cards on the manager's Needs review list. */
		const review = async () => {
			const response = await h.operator('GET', '/timesheets/review', {
				grants: TS_PAY,
			})
			expect(response.status).toBe(200)
			return {
				cards: response.body.people.flatMap((person: any) => person.cards),
				byIssue: response.body.byIssue,
			}
		}

		it('reaches the manager’s Needs review list, and a manager edit with a reason answers it', async () => {
			const ana = await person()
			const row = await card(ana.staffId, '2026-03-02', 8)
			const t = await token(ana.staffId)
			expect((await review()).cards).toEqual([])

			const sent = await call('POST', `/me/time-cards/${row.id}/correction`, {
				token: t,
				body: { note: 'I left at 4, not 5' },
			})
			expect(sent.status).toBe(201)
			expect(sent.body.correction.status).toBe('open')

			const queue = await review()
			expect(queue.cards).toHaveLength(1)
			expect(queue.cards[0]).toMatchObject({
				id: row.id,
				status: 'needs_review',
				issues: expect.arrayContaining(['correction_requested']),
			})
			// The person sees that it was sent, and no manager-side status.
			const mine = await call('GET', '/me/time-cards', { token: t })
			expect(mine.body.cards[0]).toMatchObject({
				correctionRequested: true,
				status: 'closed',
			})
			expect(mine.raw).not.toContain('needs_review')

			// The note stays with the request; the audit row carries ids only.
			const requests = await (await db()).select().from(timeCorrectionRequests)
			expect(requests).toEqual([
				expect.objectContaining({
					entryId: row.id,
					note: 'I left at 4, not 5',
					status: 'open',
				}),
			])
			const audit = await (
				await db()
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'timesheet.correction.requested'))
			expect(audit).toHaveLength(1)
			expect(JSON.stringify(audit[0]!.changes)).not.toContain('I left at 4')

			// The manager fixes the card with a reason, as for any edit.
			const edited = await h.operator(
				'PATCH',
				`/timesheets/entries/${row.id}`,
				{
					grants: TS_PAY,
					body: {
						expectedVersion: queue.cards[0].version,
						clockOutAt: at('2026-03-02', '16:00'),
						reason: 'Confirmed with Ana: she left at 4',
					},
				},
			)
			expect(edited.status).toBe(200)
			expect((await review()).cards).toEqual([])
			const [resolved] = await (
				await db()
			)
				.select()
				.from(timeCorrectionRequests)
			expect(resolved).toMatchObject({ status: 'resolved' })
			expect(resolved!.resolvedBy).toBeTruthy()
			const [after] = await (
				await db()
			)
				.select()
				.from(timeEntries)
				.where(eq(timeEntries.id, row.id))
			expect(after!.issues).not.toContain('correction_requested')
		})

		it('a repeat is the same request, and a manager marking it reviewed answers it', async () => {
			const ana = await person()
			const row = await card(ana.staffId, '2026-03-02', 8)
			const t = await token(ana.staffId)
			const first = await call('POST', `/me/time-cards/${row.id}/correction`, {
				token: t,
				body: {},
			})
			const again = await call('POST', `/me/time-cards/${row.id}/correction`, {
				token: t,
				body: { note: 'still wrong' },
			})
			expect(again.status).toBe(201)
			expect(again.body.correction.id).toBe(first.body.correction.id)
			expect(
				await (await db()).select().from(timeCorrectionRequests),
			).toHaveLength(1)
			const queue = await review()
			const reviewed = await h.operator(
				'POST',
				`/timesheets/entries/${row.id}/review`,
				{
					grants: TS_PAY,
					body: {
						expectedVersion: queue.cards[0].version,
						note: 'Looks right',
					},
				},
			)
			expect(reviewed.status).toBe(200)
			expect((await review()).cards).toEqual([])
			expect(
				(await (await db()).select().from(timeCorrectionRequests))[0]!.status,
			).toBe('resolved')
		})

		it('cannot be sent for someone else’s card, an open card, or an approved one', async () => {
			const ana = await person()
			const ben = await person('Ben')
			const t = await token(ana.staffId)
			const others = await card(ben.staffId, '2026-03-02', 8)
			const approved = await card(ana.staffId, '2026-03-03', 8, {
				status: 'approved',
			})
			// An open card overlaps any later one, so it goes last.
			const open = await card(ana.staffId, '2026-03-04', 8, {
				clockOutAt: null,
			})
			expect(
				(
					await call('POST', `/me/time-cards/${others.id}/correction`, {
						token: t,
						body: {},
					})
				).status,
			).toBe(404)
			expect(
				(
					await call('POST', `/me/time-cards/${open.id}/correction`, {
						token: t,
						body: {},
					})
				).body.error,
			).toBe('open_card')
			expect(
				(
					await call('POST', `/me/time-cards/${approved.id}/correction`, {
						token: t,
						body: {},
					})
				).body.error,
			).toBe('card_finalized')
			expect(await (await db()).select().from(timeCorrectionRequests)).toEqual(
				[],
			)
			const [untouched] = await (
				await db()
			)
				.select()
				.from(timeEntries)
				.where(and(eq(timeEntries.id, others.id)))
			expect(untouched!.issues).not.toContain('correction_requested')
		})

		it('refuses a blank note and an unknown field', async () => {
			const ana = await person()
			const row = await card(ana.staffId, '2026-03-02', 8)
			const t = await token(ana.staffId)
			expect(
				(
					await call('POST', `/me/time-cards/${row.id}/correction`, {
						token: t,
						body: { note: '   ' },
					})
				).status,
			).toBe(400)
			expect(
				(
					await call('POST', `/me/time-cards/${row.id}/correction`, {
						token: t,
						body: { status: 'resolved' },
					})
				).status,
			).toBe(400)
			void staffMembers
			void SCH_PAY
		})
	})
})
