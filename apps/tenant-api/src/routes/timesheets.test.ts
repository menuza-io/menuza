import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import {
	notificationOutbox,
	staffAuditLog,
	timeBreaks,
	timeEntries,
	timeEntryEdits,
} from '@repo/tenant-db'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	at,
	CHI,
	createClockHarness,
	entryRow,
	LOC_1,
	LOC_2,
	ORG_A,
	ORG_B,
	TS_APPROVE,
	TS_EDIT,
	TS_PAY,
	TS_VIEW,
	timesheetFixture,
	type ClockHarness,
	type TimesheetFixture,
} from '../../tests/timesheet-harness.ts'

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

describe('/operator/timeclock/timesheets', () => {
	let h: ClockHarness
	let t: TimesheetFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		h = await createClockHarness([ORG_A, ORG_B])
		t = timesheetFixture(h)
		// Wednesday 2026-03-11 noon: the week of March 2 is fully in the past.
		h.setClock(at('2026-03-11', '12:00'))
	})
	afterEach(async () => {
		await h.cleanup()
	})

	async function db() {
		return h.db(ORG_A)
	}

	describe('adding a card', () => {
		it('adds a card from local times, with the rate snapshot and a full edit log row', async () => {
			const { staffId, positionIds } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'Forgot to clock in',
			})
			expect(created.status).toBe(201)
			const { card, edit, reducedHours } = created.body
			expect(card).toMatchObject({
				staffId,
				scopeId: LOC_1,
				positionId: positionIds[0],
				localDate: '2026-03-02',
				clockInAt: at('2026-03-02', '09:00'),
				clockOutAt: at('2026-03-02', '17:00'),
				timeZone: CHI,
				status: 'closed',
				edited: true,
				version: 1,
				minutes: { paidMinutes: 480, regularMinutes: 480, overtimeMinutes: 0 },
				money: {
					estimate: true,
					rateMinor: 2000,
					currency: 'USD',
					payMinor: 16000,
				},
			})
			expect(card.issues).toContain('edited')
			expect(reducedHours).toBe(false)
			expect(edit).toMatchObject({
				action: 'create',
				reason: 'Forgot to clock in',
				via: 'manager',
				editorId: 'operator-1',
				before: null,
				hoursDeltaMinutes: 480,
			})
			expect(edit.after).toMatchObject({ clockInAt: at('2026-03-02', '09:00') })

			// Appended to the log, queued for the employee, and audited.
			const logs = await (await db()).select().from(timeEntryEdits)
			expect(logs).toHaveLength(1)
			const outbox = await (await db()).select().from(notificationOutbox)
			expect(outbox).toHaveLength(1)
			expect(outbox[0]).toMatchObject({
				kind: 'time_card_edited',
				staffId,
				status: 'pending',
				dedupeKey: `time_card_edited:${edit.id}`,
			})
			expect(outbox[0]!.payload).toMatchObject({
				entryId: card.id,
				action: 'create',
				reducedHours: false,
			})
			const audits = await (
				await db()
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'timesheet.card.created'))
			expect(audits).toHaveLength(1)
			expect(audits[0]).toMatchObject({ staffId, scopeId: LOC_1 })
		})

		it('never puts pay in the staff notification payload', async () => {
			const { staffId } = await t.staff()
			await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				cashTipsMinor: 4500,
				reason: 'Missed punch',
			})
			const [row] = await (await db()).select().from(notificationOutbox)
			// Ids and a few facts, nothing else.
			expect(Object.keys(row!.payload as object).sort()).toEqual([
				'action',
				'editId',
				'entryId',
				'hoursDeltaMinutes',
				'localDate',
				'reducedHours',
			])
			expect(JSON.stringify(row!.payload)).not.toMatch(/2000|4500|16000/)
		})

		it('accepts instants and rounds them to the minute', async () => {
			const { staffId } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				clockInAt: at('2026-03-02', '09:00') + 17_000,
				clockOutAt: at('2026-03-02', '10:00') + 59_000,
				reason: 'Missed punch',
			})
			expect(created.status).toBe(201)
			expect(created.body.card.clockInAt).toBe(at('2026-03-02', '09:00'))
			expect(created.body.card.clockOutAt).toBe(at('2026-03-02', '10:00'))
		})

		it('handles an overnight card: it belongs to the day it started and keeps its length', async () => {
			const { staffId } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '22:00',
				endTime: '02:30',
				reason: 'Closing shift',
			})
			expect(created.status).toBe(201)
			expect(created.body.card).toMatchObject({
				localDate: '2026-03-02',
				clockInAt: at('2026-03-02', '22:00'),
				clockOutAt: at('2026-03-03', '02:30'),
				minutes: { paidMinutes: 270 },
			})
			const day = await t.get('/timesheets/day?date=2026-03-02')
			expect(day.body.people[0].cards).toHaveLength(1)
			const next = await t.get('/timesheets/day?date=2026-03-03')
			expect(next.body.people).toHaveLength(0)
		})

		it('is DST-correct: a night shift over spring-forward is one hour short', async () => {
			h.setClock(at('2026-03-20', '12:00'))
			const { staffId } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-07',
				startTime: '22:00',
				endTime: '06:00',
				reason: 'Night shift',
			})
			expect(created.body.card.minutes.paidMinutes).toBe(7 * 60)
		})

		it('keeps two roles on one day as two separate cards', async () => {
			const { staffId, positionIds } = await t.staff({
				positions: [
					{ name: 'Cook', rateMinor: 2000 },
					{ name: 'Host', rateMinor: 1400 },
				],
			})
			const needRole = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '08:00',
				endTime: '12:00',
				reason: 'Split day',
			})
			expect(needRole.status).toBe(422)
			expect(needRole.body.error).toBe('position_required')
			expect(needRole.body.positions).toHaveLength(2)

			const [cook, host] = positionIds
			const first = await t.card({
				staffId,
				scopeId: LOC_1,
				positionId: cook,
				date: '2026-03-02',
				startTime: '08:00',
				endTime: '12:00',
				reason: 'Split day',
			})
			const second = await t.card({
				staffId,
				scopeId: LOC_1,
				positionId: host,
				date: '2026-03-02',
				startTime: '12:00',
				endTime: '16:00',
				reason: 'Split day',
			})
			expect(first.status).toBe(201)
			expect(second.status).toBe(201)
			expect(first.body.card.money.rateMinor).toBe(2000)
			expect(second.body.card.money.rateMinor).toBe(1400)

			const day = await t.get('/timesheets/day?date=2026-03-02')
			const cards = day.body.people[0].cards
			expect(cards).toHaveLength(2)
			expect(cards.map((c: any) => c.positionId)).toEqual([cook, host])
			// Each card is priced at its own role, not blended.
			expect(day.body.people[0].money.payMinorByCurrency.USD).toBe(
				4 * 2000 + 4 * 1400,
			)
			expect(day.body.people[0].totals.paidMinutes).toBe(480)
		})

		it('refuses a position the person does not hold', async () => {
			const { staffId } = await t.staff()
			const other = await t.staff({
				positions: [{ name: 'Barista', rateMinor: 1000 }],
			})
			const response = await t.card({
				staffId,
				scopeId: LOC_1,
				positionId: other.positionIds[0],
				date: '2026-03-02',
				startTime: '08:00',
				endTime: '12:00',
				reason: 'Wrong role',
			})
			expect(response.status).toBe(422)
			expect(response.body.error).toBe('invalid_position')
		})

		it('hard-blocks an overlapping card for the same person, and allows one that touches', async () => {
			const { staffId } = await t.staff()
			const base = {
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				reason: 'Add shift',
			}
			const first = await t.card({
				...base,
				startTime: '09:00',
				endTime: '13:00',
			})
			expect(first.status).toBe(201)
			for (const [startTime, endTime] of [
				['12:00', '14:00'],
				['08:00', '09:30'],
				['10:00', '11:00'],
				['08:00', '14:00'],
			]) {
				const clash = await t.card({ ...base, startTime, endTime })
				expect(clash.status).toBe(409)
				expect(clash.body.error).toBe('overlaps_existing')
				expect(clash.body.conflict).toMatchObject({
					entryId: first.body.card.id,
					clockInAt: at('2026-03-02', '09:00'),
				})
			}
			const touching = await t.card({
				...base,
				startTime: '13:00',
				endTime: '15:00',
			})
			expect(touching.status).toBe(201)
			// Other people can work at the same time.
			const other = await t.staff()
			const sameTime = await t.card({
				...base,
				staffId: other.staffId,
				startTime: '09:00',
				endTime: '13:00',
			})
			expect(sameTime.status).toBe(201)
			// And nothing was written for the refused ones.
			const rows = await (await db()).select().from(timeEntries)
			expect(rows).toHaveLength(3)
		})

		it('blocks a card that overlaps an open card, even a later closed one', async () => {
			const { staffId, positionIds } = await t.staff({ pin: '4321' })
			void positionIds
			const { secret } = await h.pair(ORG_A, LOC_1)
			h.setClock(at('2026-03-11', '08:00'))
			expect(
				(await h.punch(secret, { pin: '4321', kind: 'clock_in' })).status,
			).toBe(200)
			h.setClock(at('2026-03-11', '12:00'))
			const clash = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-11',
				startTime: '10:00',
				endTime: '11:00',
				reason: 'Add shift',
			})
			expect(clash.status).toBe(409)
			const before = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-11',
				startTime: '05:00',
				endTime: '07:00',
				reason: 'Early prep',
			})
			expect(before.status).toBe(201)
		})

		it('rejects future times, reversed times and absurd lengths with stable codes', async () => {
			const { staffId } = await t.staff()
			const base = { staffId, scopeId: LOC_1, reason: 'Add shift' }
			const future = await t.card({
				...base,
				date: '2026-03-11',
				startTime: '09:00',
				endTime: '17:00',
			})
			expect(future.status).toBe(422)
			expect(future.body).toMatchObject({
				error: 'in_future',
				field: 'clockOutAt',
			})

			const tomorrow = await t.card({
				...base,
				date: '2026-03-12',
				startTime: '09:00',
				endTime: '10:00',
			})
			expect(tomorrow.body).toMatchObject({
				error: 'in_future',
				field: 'clockInAt',
			})

			const reversed = await t.card({
				...base,
				clockInAt: at('2026-03-02', '10:00'),
				clockOutAt: at('2026-03-02', '09:00'),
			})
			expect(reversed.body.error).toBe('ends_before_start')
			const zero = await t.card({
				...base,
				clockInAt: at('2026-03-02', '10:00'),
				clockOutAt: at('2026-03-02', '10:00'),
			})
			expect(zero.body.error).toBe('ends_before_start')

			const long = await t.card({
				...base,
				clockInAt: at('2026-03-02', '00:00'),
				clockOutAt: at('2026-03-04', '00:01'),
			})
			expect(long.body.error).toBe('too_long')
			// Exactly 48 hours is the limit.
			const limit = await t.card({
				...base,
				clockInAt: at('2026-03-02', '00:00'),
				clockOutAt: at('2026-03-04', '00:00'),
			})
			expect(limit.status).toBe(201)
			expect(await (await db()).select().from(timeEntries)).toHaveLength(1)
		})

		it('refuses a card for someone who is not assigned to the scope, as not found', async () => {
			const { staffId } = await t.staff({ scopeIds: [LOC_2] })
			const response = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'Wrong place',
			})
			expect(response.status).toBe(404)
			const missing = await t.card({
				staffId: 'nobody',
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'Ghost',
			})
			expect(missing.status).toBe(404)
			expect(missing.body).toEqual(response.body)
		})

		it('needs a policy or control-plane time zone', async () => {
			facts.delete(LOC_1)
			const { staffId } = await t.staff()
			const response = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'No zone',
			})
			expect(response.status).toBe(422)
			expect(response.body.error).toBe('time_zone_unavailable')
			// The policy snapshot is the fallback.
			await t.setPolicy(LOC_1, { timeZone: CHI })
			const retry = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'Fallback zone',
			})
			expect(retry.status).toBe(201)
		})
	})

	describe('breaks', () => {
		it('treats a meal break as unpaid and a rest break as paid by default', async () => {
			const { staffId } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				breaks: [
					{ kind: 'meal', startTime: '12:00', endTime: '12:30' },
					{ kind: 'rest', startTime: '15:00', endTime: '15:15' },
				],
				reason: 'Add breaks',
			})
			expect(created.status).toBe(201)
			const { card } = created.body
			expect(card.breaks.map((b: any) => [b.kind, b.paid])).toEqual([
				['meal', false],
				['rest', true],
			])
			expect(card.minutes).toMatchObject({
				paidMinutes: 450,
				unpaidBreakMinutes: 30,
			})
		})

		it('lets the scope policy decide whether a kind is paid, never the caller', async () => {
			await t.setPolicy(LOC_1, {
				breakRules: {
					rules: [
						{
							kind: 'meal',
							afterMinutes: 300,
							minutes: 30,
							paid: true,
							mandatory: false,
						},
						{
							kind: 'rest',
							afterMinutes: 120,
							minutes: 10,
							paid: false,
							mandatory: false,
						},
					],
					autoDeduction: null,
				},
			})
			const { staffId } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				breaks: [
					{ kind: 'meal', startTime: '12:00', endTime: '12:30' },
					{ kind: 'rest', startTime: '15:00', endTime: '15:15' },
				],
				reason: 'Add breaks',
			})
			expect(created.body.card.breaks.map((b: any) => b.paid)).toEqual([
				true,
				false,
			])
			expect(created.body.card.minutes.unpaidBreakMinutes).toBe(15)
			const forged = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-03',
				startTime: '09:00',
				endTime: '17:00',
				breaks: [
					{ kind: 'meal', startTime: '12:00', endTime: '12:30', paid: false },
				],
				reason: 'Forge paid',
			})
			expect(forged.status).toBe(400)
		})

		it('refuses breaks outside the card or overlapping each other', async () => {
			const { staffId } = await t.staff()
			const base = {
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'Add breaks',
			}
			const outside = await t.card({
				...base,
				breaks: [
					{
						kind: 'meal',
						startAt: at('2026-03-02', '08:30'),
						endAt: at('2026-03-02', '09:30'),
					},
				],
			})
			expect(outside.body.error).toBe('break_outside_card')
			const past = await t.card({
				...base,
				breaks: [
					{
						kind: 'meal',
						startAt: at('2026-03-02', '16:30'),
						endAt: at('2026-03-02', '17:30'),
					},
				],
			})
			expect(past.body.error).toBe('break_outside_card')
			const overlapping = await t.card({
				...base,
				breaks: [
					{ kind: 'meal', startTime: '12:00', endTime: '12:30' },
					{ kind: 'rest', startTime: '12:15', endTime: '12:45' },
				],
			})
			expect(overlapping.body.error).toBe('breaks_overlap')
			expect(await (await db()).select().from(timeBreaks)).toHaveLength(0)
		})

		it('flags a missed mandatory break and puts the card in the review queue', async () => {
			await t.setPolicy(LOC_1, {
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
			const { staffId } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'No break taken',
			})
			expect(created.body.card.status).toBe('needs_review')
			expect(created.body.card.issues).toContain('missed_break')
			const queue = await t.get('/timesheets/review')
			expect(queue.body.people[0].cards).toHaveLength(1)
			expect(queue.body.byIssue.missed_break).toBe(1)
		})
	})

	describe('tips and notes', () => {
		it('records cash and credit tips for a holder of the pay grant, and the note', async () => {
			const { staffId } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				cashTipsMinor: 4500,
				creditTipsMinor: 1250,
				managerNote: 'Covered the patio',
				reason: 'Add tips',
			})
			expect(created.body.card.money).toMatchObject({
				cashTipsMinor: 4500,
				creditTipsMinor: 1250,
			})
			expect(created.body.card.managerNote).toBe('Covered the patio')
			const day = await t.get('/timesheets/day?date=2026-03-02')
			expect(day.body.people[0].money).toMatchObject({
				cashTipsMinorByCurrency: { USD: 4500 },
				creditTipsMinorByCurrency: { USD: 1250 },
			})
		})

		it('refuses to set tips without the pay grant, and writes nothing', async () => {
			const { staffId } = await t.staff()
			const denied = await t.card(
				{
					staffId,
					scopeId: LOC_1,
					date: '2026-03-02',
					startTime: '09:00',
					endTime: '17:00',
					cashTipsMinor: 4500,
					reason: 'Add tips',
				},
				{ grants: TS_APPROVE },
			)
			expect(denied.status).toBe(403)
			expect(denied.body).toMatchObject({
				error: 'Forbidden',
				required: P.READ_STAFF_PAY,
			})
			expect(await (await db()).select().from(timeEntries)).toHaveLength(0)
			// A note alone is fine without the pay grant.
			const noted = await t.card(
				{
					staffId,
					scopeId: LOC_1,
					date: '2026-03-02',
					startTime: '09:00',
					endTime: '17:00',
					managerNote: 'Fine',
					reason: 'Add shift',
				},
				{ grants: TS_APPROVE },
			)
			expect(noted.status).toBe(201)
			expect(noted.body.card.money).toBeUndefined()
		})
	})

	describe('editing a card', () => {
		async function seeded() {
			const { staffId, positionIds } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'Add shift',
			})
			return { staffId, positionIds, card: created.body.card }
		}

		it('records before, after and the reason, and flags an edit that cuts hours', async () => {
			const { card, staffId } = await seeded()
			const response = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: card.version,
				endTime: undefined,
				date: '2026-03-02',
				startTime: '09:00',
				endTime2: undefined,
				reason: 'x',
			})
			// A body with an unknown key is refused outright.
			expect(response.status).toBe(400)

			const edited = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: card.version,
				clockOutAt: at('2026-03-02', '15:00'),
				reason: 'Left early, confirmed with the cook',
			})
			expect(edited.status).toBe(200)
			expect(edited.body.reducedHours).toBe(true)
			expect(edited.body.edit).toMatchObject({
				action: 'update',
				reason: 'Left early, confirmed with the cook',
				hoursDeltaMinutes: -120,
			})
			expect(edited.body.edit.before.clockOutAt).toBe(at('2026-03-02', '17:00'))
			expect(edited.body.edit.after.clockOutAt).toBe(at('2026-03-02', '15:00'))
			expect(edited.body.card).toMatchObject({
				version: 2,
				clockOutAt: at('2026-03-02', '15:00'),
				minutes: { paidMinutes: 360 },
			})
			const outbox = await (
				await db()
			)
				.select()
				.from(notificationOutbox)
				.where(eq(notificationOutbox.staffId, staffId))
			expect(outbox).toHaveLength(2)
			expect(outbox.map((r) => (r.payload as any).reducedHours).sort()).toEqual(
				[false, true],
			)
			const audit = await (
				await db()
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'timesheet.card.updated'))
			expect(audit[0]!.changes).toMatchObject({
				reducedHours: true,
				hoursDeltaMinutes: -120,
				fields: ['clockOutAt'],
			})
		})

		it('does not flag an edit that adds hours', async () => {
			const { card } = await seeded()
			const edited = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: card.version,
				clockOutAt: at('2026-03-02', '18:00'),
				reason: 'Stayed to close',
			})
			expect(edited.body.reducedHours).toBe(false)
			expect(edited.body.edit.hoursDeltaMinutes).toBe(60)
		})

		it('requires a reason, a current version, and an actual change', async () => {
			const { card } = await seeded()
			const noReason = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: card.version,
				clockOutAt: at('2026-03-02', '16:00'),
			})
			expect(noReason.status).toBe(400)
			for (const reason of ['', '   ', '​']) {
				const blank = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
					expectedVersion: card.version,
					clockOutAt: at('2026-03-02', '16:00'),
					reason,
				})
				expect(blank.status).toBe(400)
			}
			const stale = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: 7,
				clockOutAt: at('2026-03-02', '16:00'),
				reason: 'Stale edit',
			})
			expect(stale.status).toBe(409)
			expect(stale.body).toMatchObject({
				error: 'stale_version',
				currentVersion: 1,
			})
			const same = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: card.version,
				clockOutAt: at('2026-03-02', '17:00'),
				reason: 'No change',
			})
			expect(same.status).toBe(422)
			expect(same.body.error).toBe('nothing_to_change')
			// Nothing was logged for any of the refused edits.
			expect(await (await db()).select().from(timeEntryEdits)).toHaveLength(1)
			expect((await entryRow(h, card.id))!.version).toBe(1)
		})

		it('lets exactly one of two simultaneous edits win', async () => {
			const { card } = await seeded()
			const [a, b] = await Promise.all([
				t.send('PATCH', `/timesheets/entries/${card.id}`, {
					expectedVersion: 1,
					clockOutAt: at('2026-03-02', '16:00'),
					reason: 'First editor',
				}),
				t.send('PATCH', `/timesheets/entries/${card.id}`, {
					expectedVersion: 1,
					clockOutAt: at('2026-03-02', '15:00'),
					reason: 'Second editor',
				}),
			])
			expect([a.status, b.status].sort()).toEqual([200, 409])
			const logs = await (await db()).select().from(timeEntryEdits)
			expect(logs.filter((l) => l.action === 'update')).toHaveLength(1)
		})

		it('blocks an edit that would overlap another card of the person', async () => {
			const { card, staffId } = await seeded()
			await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '18:00',
				endTime: '20:00',
				reason: 'Evening shift',
			})
			const response = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: 1,
				clockOutAt: at('2026-03-02', '19:00'),
				reason: 'Stayed late',
			})
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('overlaps_existing')
			expect((await entryRow(h, card.id))!.clockOutAt).toBe(
				at('2026-03-02', '17:00'),
			)
		})

		it('replaces breaks when given and keeps them when not', async () => {
			const { card } = await seeded()
			const withBreak = await t.send(
				'PATCH',
				`/timesheets/entries/${card.id}`,
				{
					expectedVersion: 1,
					breaks: [{ kind: 'meal', startTime: '12:00', endTime: '12:30' }],
					reason: 'Add the lunch break',
				},
			)
			expect(withBreak.body.card.minutes.paidMinutes).toBe(450)
			const tips = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: 2,
				cashTipsMinor: 800,
				reason: 'Declared tips',
			})
			expect(tips.body.card.breaks).toHaveLength(1)
			const cleared = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: 3,
				breaks: [],
				reason: 'Break was not taken',
			})
			expect(cleared.body.card.breaks).toHaveLength(0)
			expect(cleared.body.card.minutes.paidMinutes).toBe(480)
			// Voided, not deleted: the history of breaks is still there.
			const rows = await (await db()).select().from(timeBreaks)
			expect(rows).toHaveLength(1)
			expect(rows[0]!.voidedAt).not.toBeNull()
		})

		it('refuses a kept break that falls outside the shortened card', async () => {
			const { card } = await seeded()
			await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: 1,
				breaks: [{ kind: 'meal', startTime: '16:00', endTime: '16:30' }],
				reason: 'Late lunch',
			})
			const response = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: 2,
				clockOutAt: at('2026-03-02', '15:00'),
				reason: 'Left early',
			})
			expect(response.status).toBe(422)
			expect(response.body.error).toBe('break_outside_card')
		})

		it('moves a card to another day with local times and recomputes its business date', async () => {
			const { card } = await seeded()
			const moved = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: 1,
				date: '2026-03-03',
				startTime: '10:00',
				endTime: '18:00',
				reason: 'Entered on the wrong day',
			})
			expect(moved.status).toBe(200)
			expect(moved.body.card.localDate).toBe('2026-03-03')
			expect(moved.body.edit.hoursDeltaMinutes).toBe(0)
			expect(moved.body.reducedHours).toBe(false)
		})

		it("changes the role and re-takes that role's rate snapshot", async () => {
			const { staffId, positionIds } = await t.staff({
				positions: [
					{ name: 'Cook', rateMinor: 2000 },
					{ name: 'Host', rateMinor: 1400 },
				],
			})
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				positionId: positionIds[0],
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'Add shift',
			})
			const changed = await t.send(
				'PATCH',
				`/timesheets/entries/${created.body.card.id}`,
				{
					expectedVersion: 1,
					positionId: positionIds[1],
					reason: 'Worked the door',
				},
			)
			expect(changed.body.card.money).toMatchObject({
				rateMinor: 1400,
				payMinor: 11200,
			})
			expect(changed.body.edit.before.rateMinor).toBe(2000)
			expect(changed.body.edit.after.rateMinor).toBe(1400)
		})

		it('closes a card the person forgot to clock out of, and ends their open break', async () => {
			const { staffId } = await t.staff({ pin: '4321' })
			const { secret } = await h.pair(ORG_A, LOC_1)
			h.setClock(at('2026-03-10', '08:00'))
			await h.punch(secret, { pin: '4321', kind: 'clock_in' })
			h.setClock(at('2026-03-10', '12:00'))
			await h.punch(secret, { pin: '4321', kind: 'break_start' })
			h.setClock(at('2026-03-11', '12:00'))
			const queue = await t.get('/timesheets/review')
			expect(queue.body.people[0].cards[0]).toMatchObject({
				status: 'open',
				issues: expect.arrayContaining(['missing_clock_out']),
			})
			const open = queue.body.people[0].cards[0]
			expect(open.staffId).toBe(staffId)
			const closed = await t.send('PATCH', `/timesheets/entries/${open.id}`, {
				expectedVersion: open.version,
				clockOutAt: at('2026-03-10', '17:00'),
				reason: 'Forgot to clock out; manager confirmed 5pm',
			})
			expect(closed.status).toBe(200)
			expect(closed.body.card).toMatchObject({
				clockOutAt: at('2026-03-10', '17:00'),
				clockOutKind: 'manager',
			})
			expect(closed.body.card.breaks).toHaveLength(1)
			expect(closed.body.card.breaks[0].endAt).toBe(at('2026-03-10', '17:00'))
			expect(closed.body.card.issues).not.toContain('missing_clock_out')
			const after = await t.get('/timesheets/review')
			const stillThere = after.body.people.flatMap((p: any) => p.cards)
			expect(stillThere.map((c: any) => c.id)).not.toContain(open.id)
		})

		it('cannot reopen a closed card into an open one', async () => {
			const { card } = await seeded()
			const response = await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: 1,
				clockOutAt: null,
				reason: 'Reopen',
			})
			expect(response.status).toBe(400)
		})
	})

	describe('deleting a card', () => {
		it('voids it with a reason and keeps the whole history', async () => {
			const { staffId } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				breaks: [{ kind: 'meal', startTime: '12:00', endTime: '12:30' }],
				reason: 'Add shift',
			})
			const id = created.body.card.id
			const noReason = await t.send('DELETE', `/timesheets/entries/${id}`, {
				expectedVersion: 1,
			})
			expect(noReason.status).toBe(400)
			const gone = await t.send('DELETE', `/timesheets/entries/${id}`, {
				expectedVersion: 1,
				reason: 'Entered for the wrong person',
			})
			expect(gone.status).toBe(200)
			expect(gone.body.card).toBeNull()
			expect(gone.body.reducedHours).toBe(true)
			expect(gone.body.edit).toMatchObject({
				action: 'void',
				reason: 'Entered for the wrong person',
				hoursDeltaMinutes: -450,
			})
			const row = await entryRow(h, id)
			expect(row).toMatchObject({ voidedBy: 'operator-1' })
			expect(row!.voidedAt).not.toBeNull()
			const day = await t.get('/timesheets/day?date=2026-03-02')
			expect(day.body.people).toHaveLength(0)
			// The time is free again.
			const again = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'Correct entry',
			})
			expect(again.status).toBe(201)
			const detail = await t.get(`/timesheets/entries/${id}`)
			expect(detail.status).toBe(404)
			// A voided card cannot be edited or voided twice.
			const twice = await t.send('DELETE', `/timesheets/entries/${id}`, {
				expectedVersion: 2,
				reason: 'Again',
			})
			expect(twice.status).toBe(404)
		})
	})

	describe('needs-review queue and review', () => {
		it('lists cards still open past the long-shift limit and clears them once fixed', async () => {
			await t.staff({ pin: '1111' })
			const { secret } = await h.pair(ORG_A, LOC_1)
			h.setClock(at('2026-03-10', '08:00'))
			await h.punch(secret, { pin: '1111', kind: 'clock_in' })
			h.setClock(at('2026-03-10', '20:00'))
			expect((await t.get('/timesheets/review')).body.people).toHaveLength(0)
			h.setClock(at('2026-03-11', '08:30'))
			const queue = await t.get('/timesheets/review')
			expect(queue.body.totals.open).toBe(1)
			expect(queue.body.byIssue.missing_clock_out).toBe(1)
		})

		it('marks a card reviewed (no time changes) and takes it out of the queue', async () => {
			await t.setPolicy(LOC_1, { longShiftMinutes: 600 })
			const { staffId } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '08:00',
				endTime: '19:00',
				reason: 'Double shift',
			})
			expect(created.body.card.status).toBe('needs_review')
			const id = created.body.card.id
			const reviewed = await t.send(
				'POST',
				`/timesheets/entries/${id}/review`,
				{
					expectedVersion: 1,
					note: 'Confirmed with the shift lead',
				},
			)
			expect(reviewed.status).toBe(200)
			expect(reviewed.body.card).toMatchObject({
				status: 'closed',
				reviewed: true,
				version: 2,
			})
			expect(reviewed.body.card.issues).toContain('long_shift')
			expect(reviewed.body.edit).toMatchObject({
				action: 'review',
				reason: 'Confirmed with the shift lead',
				hoursDeltaMinutes: null,
			})
			expect((await t.get('/timesheets/review')).body.people).toHaveLength(0)
			// An edit afterwards puts it back in front of a manager.
			const edit = await t.send('PATCH', `/timesheets/entries/${id}`, {
				expectedVersion: 2,
				clockOutAt: at('2026-03-02', '19:30'),
				reason: 'Adjusted by half an hour',
			})
			expect(edit.body.card.reviewed).toBe(false)
			expect(edit.body.card.status).toBe('needs_review')
			// Reviewing does not notify the employee: no time changed.
			const outbox = await (await db()).select().from(notificationOutbox)
			expect(outbox.map((r) => (r.payload as any).action).sort()).toEqual([
				'create',
				'update',
			])
		})

		it('refuses to review a card that is still open', async () => {
			await t.staff({ pin: '1111' })
			const { secret } = await h.pair(ORG_A, LOC_1)
			h.setClock(at('2026-03-10', '08:00'))
			await h.punch(secret, { pin: '1111', kind: 'clock_in' })
			h.setClock(at('2026-03-11', '08:30'))
			const queue = await t.get('/timesheets/review')
			const open = queue.body.people[0].cards[0]
			const response = await t.send(
				'POST',
				`/timesheets/entries/${open.id}/review`,
				{
					expectedVersion: open.version,
				},
			)
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('open_card')
		})
	})

	describe('approving and locking', () => {
		async function card(patch: Record<string, unknown> = {}) {
			const { staffId } = await t.staff()
			const created = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
				reason: 'Add shift',
				...patch,
			})
			return created.body.card
		}

		it('is off until the scope turns approval on', async () => {
			const c = await card()
			const response = await t.send('POST', '/timesheets/approve', {
				entries: [{ id: c.id, version: c.version }],
			})
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({ changed: 0, skipped: 1 })
			expect(response.body.results[0]).toMatchObject({
				id: c.id,
				ok: false,
				code: 'approval_not_enabled',
			})
		})

		it('approves with the approve grant only, and freezes edits until reopened', async () => {
			await t.setPolicy(LOC_1, { timesheetApprovalMode: 'approve' })
			const c = await card()
			const forbidden = await t.send(
				'POST',
				'/timesheets/approve',
				{ entries: [{ id: c.id, version: c.version }] },
				{ grants: TS_EDIT },
			)
			expect(forbidden.status).toBe(403)
			expect(forbidden.body.required).toBe(P.APPROVE_TIMESHEET)
			expect((await entryRow(h, c.id))!.status).toBe('closed')

			const approved = await t.send('POST', '/timesheets/approve', {
				entries: [{ id: c.id, version: c.version }],
				note: 'Checked against the schedule',
			})
			expect(approved.body).toMatchObject({ changed: 1, skipped: 0 })
			expect(approved.body.results[0]).toMatchObject({
				ok: true,
				status: 'approved',
				version: 2,
			})
			const row = await entryRow(h, c.id)
			expect(row).toMatchObject({
				status: 'approved',
				approvedBy: 'operator-1',
			})

			for (const response of [
				await t.send('PATCH', `/timesheets/entries/${c.id}`, {
					expectedVersion: 2,
					clockOutAt: at('2026-03-02', '16:00'),
					reason: 'Try after approval',
				}),
				await t.send('DELETE', `/timesheets/entries/${c.id}`, {
					expectedVersion: 2,
					reason: 'Try after approval',
				}),
				await t.send('POST', `/timesheets/entries/${c.id}/review`, {
					expectedVersion: 2,
				}),
			]) {
				expect(response.status).toBe(409)
				expect(response.body.error).toBe('card_approved')
			}

			const again = await t.send('POST', '/timesheets/approve', {
				entries: [{ id: c.id, version: 2 }],
			})
			expect(again.body.results[0].code).toBe('already_approved')

			const noReason = await t.send('POST', '/timesheets/reopen', {
				entries: [{ id: c.id, version: 2 }],
			})
			expect(noReason.status).toBe(400)
			const reopened = await t.send('POST', '/timesheets/reopen', {
				entries: [{ id: c.id, version: 2 }],
				reason: 'Tips were wrong',
			})
			expect(reopened.body.results[0]).toMatchObject({
				ok: true,
				status: 'closed',
			})
			const edit = await t.send('PATCH', `/timesheets/entries/${c.id}`, {
				expectedVersion: 3,
				cashTipsMinor: 900,
				reason: 'Fixed the tips',
			})
			expect(edit.status).toBe(200)
		})

		it('refuses to approve open cards, cards that must be fixed, and stale versions', async () => {
			await t.setPolicy(LOC_1, { timesheetApprovalMode: 'approve' })
			await t.staff({ pin: '1111' })
			const { secret } = await h.pair(ORG_A, LOC_1)
			h.setClock(at('2026-03-10', '08:00'))
			await h.punch(secret, { pin: '1111', kind: 'clock_in' })
			h.setClock(at('2026-03-11', '08:30'))
			const open = (await t.get('/timesheets/review')).body.people[0].cards[0]
			const c = await card()
			const result = await t.send('POST', '/timesheets/approve', {
				entries: [
					{ id: open.id, version: open.version },
					{ id: c.id, version: 99 },
					{ id: 'does-not-exist', version: 1 },
					{
						id: c.id.slice(0, -1) + (c.id.endsWith('a') ? 'b' : 'a'),
						version: 1,
					},
				],
			})
			expect(result.body.changed).toBe(0)
			expect(result.body.results.map((r: any) => r.code)).toEqual([
				'open_card',
				'stale_version',
				'not_found',
				'not_found',
			])
			expect(result.body.results[1]).toMatchObject({ version: 1 })
		})

		it('locks only approved cards, in a scope that locks, and a locked card is immutable', async () => {
			await t.setPolicy(LOC_1, { timesheetApprovalMode: 'approve' })
			const c = await card()
			const early = await t.send('POST', '/timesheets/lock', {
				entries: [{ id: c.id, version: 1 }],
			})
			expect(early.body.results[0].code).toBe('not_approved')

			await t.send('POST', '/timesheets/approve', {
				entries: [{ id: c.id, version: 1 }],
			})
			const noLock = await t.send('POST', '/timesheets/lock', {
				entries: [{ id: c.id, version: 2 }],
			})
			expect(noLock.body.results[0].code).toBe('lock_not_enabled')

			await t.setPolicy(LOC_1, { timesheetApprovalMode: 'approve_lock' })
			const locked = await t.send('POST', '/timesheets/lock', {
				entries: [{ id: c.id, version: 2 }],
			})
			expect(locked.body.results[0]).toMatchObject({
				ok: true,
				status: 'locked',
				version: 3,
			})
			expect(await entryRow(h, c.id)).toMatchObject({
				status: 'locked',
				lockedBy: 'operator-1',
			})

			const attempts = [
				[
					'PATCH',
					{
						expectedVersion: 3,
						clockOutAt: at('2026-03-02', '16:00'),
						reason: 'Try',
					},
				],
				[
					'PATCH',
					{ expectedVersion: 3, managerNote: 'sneaky', reason: 'Try a note' },
				],
				['PATCH', { expectedVersion: 3, breaks: [], reason: 'Try breaks' }],
				[
					'PATCH',
					{ expectedVersion: 3, cashTipsMinor: 100, reason: 'Try tips' },
				],
				['DELETE', { expectedVersion: 3, reason: 'Try delete' }],
			] as const
			for (const [method, body] of attempts) {
				const response = await t.send(
					method,
					`/timesheets/entries/${c.id}`,
					body,
				)
				expect(response.status).toBe(409)
				expect(response.body.error).toBe('card_locked')
			}
			const review = await t.send(
				'POST',
				`/timesheets/entries/${c.id}/review`,
				{
					expectedVersion: 3,
				},
			)
			expect(review.body.error).toBe('card_locked')
			const reopen = await t.send('POST', '/timesheets/reopen', {
				entries: [{ id: c.id, version: 3 }],
				reason: 'Try reopen',
			})
			expect(reopen.body.results[0].code).toBe('card_locked')
			const approveAgain = await t.send('POST', '/timesheets/approve', {
				entries: [{ id: c.id, version: 3 }],
			})
			expect(approveAgain.body.results[0].code).toBe('already_locked')

			// Nothing leaked through, and even raw SQL cannot change it.
			const row = await entryRow(h, c.id)
			expect(row).toMatchObject({
				clockOutAt: at('2026-03-02', '17:00'),
				managerNote: null,
				version: 3,
			})
			await expect(
				(await db())
					.update(timeEntries)
					.set({ managerNote: 'raw' })
					.where(eq(timeEntries.id, c.id)),
			).rejects.toThrow()
		})

		it('unlocks only with a reason, logs it, and the card then needs reopening before an edit', async () => {
			await t.setPolicy(LOC_1, { timesheetApprovalMode: 'approve_lock' })
			const c = await card()
			await t.send('POST', '/timesheets/approve', {
				entries: [{ id: c.id, version: 1 }],
			})
			await t.send('POST', '/timesheets/lock', {
				entries: [{ id: c.id, version: 2 }],
			})

			const forbidden = await t.send(
				'POST',
				'/timesheets/unlock',
				{ entries: [{ id: c.id, version: 3 }], reason: 'Need to fix tips' },
				{ grants: TS_EDIT },
			)
			expect(forbidden.status).toBe(403)
			const noReason = await t.send('POST', '/timesheets/unlock', {
				entries: [{ id: c.id, version: 3 }],
			})
			expect(noReason.status).toBe(400)
			const unlocked = await t.send('POST', '/timesheets/unlock', {
				entries: [{ id: c.id, version: 3 }],
				reason: 'Need to fix tips',
			})
			expect(unlocked.body.results[0]).toMatchObject({
				ok: true,
				status: 'approved',
				version: 4,
			})
			const row = await entryRow(h, c.id)
			expect(row).toMatchObject({
				status: 'approved',
				lockedBy: null,
				lockedAt: null,
			})

			const blocked = await t.send('PATCH', `/timesheets/entries/${c.id}`, {
				expectedVersion: 4,
				cashTipsMinor: 100,
				reason: 'Fix tips',
			})
			expect(blocked.body.error).toBe('card_approved')
			const audit = await (
				await db()
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'timesheet.card.unlocked'))
			expect(audit).toHaveLength(1)
			expect(audit[0]).toMatchObject({ entityId: c.id, actorId: 'operator-1' })
		})

		it('keeps an unbroken edit log for every action on a card', async () => {
			await t.setPolicy(LOC_1, { timesheetApprovalMode: 'approve_lock' })
			const c = await card()
			const id = c.id
			const steps: Array<() => Promise<unknown>> = [
				() =>
					t.send('PATCH', `/timesheets/entries/${id}`, {
						expectedVersion: 1,
						clockOutAt: at('2026-03-02', '16:00'),
						reason: 'Left early',
					}),
				() =>
					t.send('POST', `/timesheets/entries/${id}/review`, {
						expectedVersion: 2,
					}),
				() =>
					t.send('POST', '/timesheets/approve', {
						entries: [{ id, version: 3 }],
					}),
				() =>
					t.send('POST', '/timesheets/lock', { entries: [{ id, version: 4 }] }),
				() =>
					t.send('POST', '/timesheets/unlock', {
						entries: [{ id, version: 5 }],
						reason: 'Check again',
					}),
				() =>
					t.send('POST', '/timesheets/reopen', {
						entries: [{ id, version: 6 }],
						reason: 'Fix the rest break',
					}),
				() =>
					t.send('DELETE', `/timesheets/entries/${id}`, {
						expectedVersion: 7,
						reason: 'Duplicate',
					}),
			]
			for (const step of steps) await step()

			const logs = (
				await (
					await db()
				)
					.select()
					.from(timeEntryEdits)
					.where(eq(timeEntryEdits.entryId, id))
			).sort((a, b) => a.createdAt - b.createdAt)
			expect(logs.map((l) => l.action)).toEqual([
				'create',
				'update',
				'review',
				'approve',
				'lock',
				'unlock',
				'reopen',
				'void',
			])
			for (const log of logs) {
				expect(log.reason.trim().length).toBeGreaterThan(0)
				expect(log.editorId).toBe('operator-1')
				expect(log.via).toBe('manager')
			}
			expect(logs.map((l) => l.hoursDeltaMinutes)).toEqual([
				480,
				-60,
				null,
				null,
				null,
				null,
				null,
				-420,
			])
			// Every step also left an audit row.
			const audits = await (
				await db()
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.entityId, id))
			expect(audits.map((a) => a.action).sort()).toEqual(
				[
					'timesheet.card.approved',
					'timesheet.card.created',
					'timesheet.card.locked',
					'timesheet.card.reopened',
					'timesheet.card.reviewed',
					'timesheet.card.unlocked',
					'timesheet.card.updated',
					'timesheet.card.voided',
				].sort(),
			)
			// And only the three time changes told the employee.
			const outbox = await (await db()).select().from(notificationOutbox)
			expect(outbox.map((o) => (o.payload as any).action).sort()).toEqual([
				'create',
				'update',
				'void',
			])
			// A voided card has no detail page.
			expect((await t.get(`/timesheets/entries/${id}`)).status).toBe(404)
		})

		it('shows the log and the punches on the card detail', async () => {
			const c = await card()
			await t.send('PATCH', `/timesheets/entries/${c.id}`, {
				expectedVersion: 1,
				clockOutAt: at('2026-03-02', '16:00'),
				reason: 'Left early',
			})
			const detail = await t.get(`/timesheets/entries/${c.id}`)
			expect(detail.status).toBe(200)
			expect(detail.body.card.id).toBe(c.id)
			expect(detail.body.edits.map((e: any) => e.action)).toEqual([
				'update',
				'create',
			])
			expect(detail.body.edits[0].before.clockOutAt).toBe(
				at('2026-03-02', '17:00'),
			)
			expect(detail.body.punches).toEqual([])
		})
	})
})
