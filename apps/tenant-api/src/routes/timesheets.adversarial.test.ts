import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import {
	notificationOutbox,
	staffAuditLog,
	timeEntries,
	timeEntryEdits,
} from '@repo/tenant-db'
import {
	makeOrg,
	mintStaffToken,
	type TestOrg,
} from '../../tests/staff-harness.ts'
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

const MONEY_KEYS =
	/rateMinor|payMinor|cashTips|creditTips|"money"|"labor"|"currency"/

describe('timesheets: adversarial', () => {
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
		h.setClock(at('2026-03-20', '12:00'))
	})
	afterEach(async () => {
		await h.cleanup()
	})

	const shift = (
		staffId: string,
		scopeId: string,
		date = '2026-03-02',
		extra = {},
	) =>
		t.card({
			staffId,
			scopeId,
			date,
			startTime: '09:00',
			endTime: '17:00',
			reason: 'Shift',
			...extra,
		})

	/** One card at each scope, for a person who works at both. */
	async function twoScopes() {
		const both = await t.staff({
			firstName: 'Both',
			scopeIds: [LOC_1, LOC_2],
		})
		const only2 = await t.staff({
			firstName: 'Only',
			lastName: 'Airport',
			scopeIds: [LOC_2],
		})
		const a = await shift(both.staffId, LOC_1)
		const b = await shift(both.staffId, LOC_2, '2026-03-03')
		const c = await shift(only2.staffId, LOC_2)
		return { both, only2, a: a.body.card, b: b.body.card, c: c.body.card }
	}

	describe('authentication and grants', () => {
		const READS = [
			'/timesheets/day?date=2026-03-02',
			'/timesheets/period?date=2026-03-02',
			'/timesheets/review',
			'/timesheets/summary?date=2026-03-02',
			'/timesheets/export?date=2026-03-02',
			'/timesheets/entries/some-id',
		]

		it('refuses a missing, forged, expired or misdirected token on every route', async () => {
			const good = await mintStaffToken({ scope: 'timeclock', grants: TS_PAY })
			const bads: Array<[string, string | null]> = [
				['no token', null],
				['garbage', 'not.a.jwt'],
				[
					'wrong secret',
					await mintStaffToken({
						scope: 'timeclock',
						grants: TS_PAY,
						secret: 'x'.repeat(40),
					}),
				],
				[
					'wrong audience',
					await mintStaffToken({
						scope: 'timeclock',
						grants: TS_PAY,
						audience: 'tenant-api-operator',
					}),
				],
				[
					'wrong typ',
					await mintStaffToken({
						scope: 'timeclock',
						grants: TS_PAY,
						typ: 'JWT',
					}),
				],
				[
					'expired',
					await mintStaffToken({
						scope: 'timeclock',
						grants: TS_PAY,
						issuedAt: 1_000_000,
					}),
				],
				[
					'too long lived',
					await mintStaffToken({
						scope: 'timeclock',
						grants: TS_PAY,
						lifetimeSeconds: 3600,
					}),
				],
				[
					'not an operator',
					await mintStaffToken({
						scope: 'timeclock',
						grants: TS_PAY,
						role: 'customer',
					}),
				],
			]
			for (const [label, token] of bads) {
				for (const path of READS) {
					const r = await t.get(path, { token })
					expect(r.status, `${label} ${path}`).toBe(401)
				}
				const w = await t.send('POST', '/timesheets/entries', {}, { token })
				expect(w.status, label).toBe(401)
			}
			expect((await t.get(READS[0]!, { token: good })).status).toBe(200)
		})

		it('refuses a token for another scope, even with every grant', async () => {
			for (const scope of ['staff', 'schedule', 'hiring']) {
				const token = await mintStaffToken({ scope, grants: TS_PAY })
				for (const path of READS) {
					expect(
						(await t.get(path, { token })).status,
						`${scope} ${path}`,
					).toBe(403)
				}
				const approve = await t.send(
					'POST',
					'/timesheets/approve',
					{ entries: [{ id: 'x', version: 1 }] },
					{ token },
				)
				expect(approve.status).toBe(403)
			}
		})

		it('refuses a token minted for another region', async () => {
			const token = await mintStaffToken({
				scope: 'timeclock',
				grants: TS_PAY,
				region: 'ksa',
			})
			expect((await t.get(READS[0]!, { token })).status).toBe(409)
		})

		it('needs both the timesheet and the roster read grant to view, and the right grant to write', async () => {
			for (const grants of [
				[P.READ_TIMESHEET],
				[P.READ_STAFF],
				[P.READ_LABOR],
				[P.READ_STAFF_PAY],
			]) {
				for (const path of READS.slice(0, 5)) {
					const r = await t.get(path, { grants })
					expect(r.status, `${grants} ${path}`).toBe(403)
					expect(r.body.error).toBe('Forbidden')
				}
			}
			const { staffId } = await t.staff()
			const created = await shift(staffId, LOC_1)
			const id = created.body.card.id
			const writes: Array<[string, string, unknown]> = [
				[
					'POST',
					'/timesheets/entries',
					{
						staffId,
						scopeId: LOC_1,
						date: '2026-03-03',
						startTime: '09:00',
						endTime: '10:00',
						reason: 'x1',
					},
				],
				[
					'PATCH',
					`/timesheets/entries/${id}`,
					{
						expectedVersion: 1,
						clockOutAt: at('2026-03-02', '16:00'),
						reason: 'Edit',
					},
				],
				[
					'DELETE',
					`/timesheets/entries/${id}`,
					{ expectedVersion: 1, reason: 'Delete' },
				],
				['POST', `/timesheets/entries/${id}/review`, { expectedVersion: 1 }],
			]
			for (const [method, path, body] of writes) {
				for (const grants of [
					TS_VIEW,
					[P.READ_TIMESHEET],
					[P.APPROVE_TIMESHEET],
					[P.READ_LABOR_POLICY, P.UPDATE_LABOR_POLICY],
				]) {
					const r = await t.send(method, path, body, { grants })
					expect(r.status, `${method} ${path} ${grants}`).toBe(403)
				}
			}
			for (const op of ['approve', 'lock', 'unlock', 'reopen']) {
				for (const grants of [TS_VIEW, TS_EDIT, [P.UPDATE_TIMESHEET]]) {
					const r = await t.send(
						'POST',
						`/timesheets/${op}`,
						{ entries: [{ id, version: 1 }], reason: 'Because' },
						{ grants },
					)
					expect(r.status, `${op} ${grants}`).toBe(403)
					expect(r.body.required).toBe(P.APPROVE_TIMESHEET)
				}
			}
			// None of it changed anything.
			expect((await entryRow(h, id))!.version).toBe(1)
			expect(
				await (await h.db(ORG_A)).select().from(timeEntryEdits),
			).toHaveLength(1)
		})

		it('lets a stronger grant stand in for a read, but never the other way round', async () => {
			const { staffId } = await t.staff()
			await shift(staffId, LOC_1)
			for (const grants of [
				[P.READ_STAFF, P.UPDATE_TIMESHEET],
				[P.READ_STAFF, P.APPROVE_TIMESHEET],
			]) {
				expect(
					(await t.get('/timesheets/day?date=2026-03-02', { grants })).status,
				).toBe(200)
			}
		})

		it('keeps an impersonated session read-only and wage-blind, whatever its token says', async () => {
			const { staffId } = await t.staff()
			const created = await shift(staffId, LOC_1, '2026-03-02', {
				cashTipsMinor: 700,
			})
			const id = created.body.card.id
			for (const path of READS.slice(0, 5)) {
				const r = await t.get(path, { grants: TS_PAY, impersonated: true })
				expect(r.status, path).toBe(200)
				expect(r.raw, path).not.toMatch(MONEY_KEYS)
			}
			const detail = await t.get(`/timesheets/entries/${id}`, {
				grants: TS_PAY,
				impersonated: true,
			})
			expect(detail.raw).not.toMatch(MONEY_KEYS)
			const writes: Array<[string, string, unknown]> = [
				[
					'POST',
					'/timesheets/entries',
					{
						staffId,
						scopeId: LOC_1,
						date: '2026-03-03',
						startTime: '09:00',
						endTime: '10:00',
						reason: 'Edit',
					},
				],
				[
					'PATCH',
					`/timesheets/entries/${id}`,
					{ expectedVersion: 1, managerNote: 'x', reason: 'Edit' },
				],
				[
					'DELETE',
					`/timesheets/entries/${id}`,
					{ expectedVersion: 1, reason: 'Edit' },
				],
				['POST', `/timesheets/entries/${id}/review`, { expectedVersion: 1 }],
				['POST', '/timesheets/approve', { entries: [{ id, version: 1 }] }],
				[
					'POST',
					'/timesheets/unlock',
					{ entries: [{ id, version: 1 }], reason: 'Edit' },
				],
				[
					'PUT',
					'/timesheets/settings',
					{ payPeriod: 'weekly', payPeriodAnchor: null },
				],
			]
			for (const [method, path, body] of writes) {
				const r = await t.send(method, path, body, {
					grants: TS_PAY,
					impersonated: true,
				})
				expect(r.status, `${method} ${path}`).toBe(403)
			}
			expect((await entryRow(h, id))!.version).toBe(1)
			// Impersonated reads of money never reach the audit log either.
			const reads = await (
				await h.db(ORG_A)
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'timesheet.pay.read'))
			expect(reads.every((r) => r.impersonated === false)).toBe(true)
		})
	})

	describe('organization isolation', () => {
		it("cannot see or change another organization's cards, with a valid token of its own", async () => {
			const { staffId } = await t.staff()
			const created = await shift(staffId, LOC_1)
			const id = created.body.card.id
			const own = { orgId: ORG_B, grants: TS_PAY }
			expect((await t.get(`/timesheets/entries/${id}`, own)).status).toBe(404)
			expect(
				(await t.get('/timesheets/day?date=2026-03-02', own)).body.people,
			).toEqual([])
			const patch = await t.send(
				'PATCH',
				`/timesheets/entries/${id}`,
				{ expectedVersion: 1, managerNote: 'x', reason: 'Edit' },
				own,
			)
			expect(patch.status).toBe(404)
			const approve = await t.send(
				'POST',
				'/timesheets/approve',
				{ entries: [{ id, version: 1 }] },
				own,
			)
			expect(approve.body.results[0].code).toBe('not_found')
			const create = await t.send(
				'POST',
				'/timesheets/entries',
				{
					staffId,
					scopeId: LOC_1,
					date: '2026-03-03',
					startTime: '09:00',
					endTime: '10:00',
					reason: 'Edit',
				},
				own,
			)
			expect(create.status).toBe(404)
			expect(await (await h.db(ORG_A)).select().from(timeEntries)).toHaveLength(
				1,
			)
			expect(await (await h.db(ORG_B)).select().from(timeEntries)).toHaveLength(
				0,
			)
		})

		it('answers a token for an unknown or unprovisioned organization with 404', async () => {
			orgs.delete(ORG_B)
			expect(
				(await t.get('/timesheets/day?date=2026-03-02', { orgId: ORG_B }))
					.status,
			).toBe(404)
			orgs.set(ORG_B, makeOrg(ORG_B, { hasProvisionedDb: false }))
			expect(
				(await t.get('/timesheets/day?date=2026-03-02', { orgId: ORG_B }))
					.status,
			).toBe(404)
			orgs.set(ORG_B, makeOrg(ORG_B, { dataRegion: 'ksa' }))
			expect(
				(await t.get('/timesheets/day?date=2026-03-02', { orgId: ORG_B }))
					.status,
			).toBe(409)
		})
	})

	describe('cross-scope limit', () => {
		const scoped = { scopeIds: [LOC_1] as string[] }

		it("shows a scoped manager only their scope's cards, in every view", async () => {
			const { a, b, c, both, only2 } = await twoScopes()
			for (const path of [
				'/timesheets/day?date=2026-03-02',
				'/timesheets/day?date=2026-03-03',
				'/timesheets/period?date=2026-03-02',
				'/timesheets/summary?date=2026-03-02',
				'/timesheets/export?date=2026-03-02',
				'/timesheets/export?date=2026-03-02&kind=summary',
			]) {
				const r = await t.get(path, scoped)
				expect(r.status, path).toBe(200)
				expect(r.raw, path).not.toContain(b.id)
				expect(r.raw, path).not.toContain(c.id)
				expect(r.raw, path).not.toContain(only2.staffId)
				expect(r.raw, path).not.toContain('Airport')
				expect(r.raw, path).not.toContain(LOC_2)
			}
			const period = await t.get('/timesheets/period?date=2026-03-02', scoped)
			expect(period.body.people.map((p: any) => p.staffId)).toEqual([
				both.staffId,
			])
			expect(period.body.people[0].cards.map((x: any) => x.id)).toEqual([a.id])
			expect(period.body.totals).toMatchObject({ cards: 1, paidMinutes: 480 })
			// Totals are of what the manager can see, not of the person's whole week.
			const summary = await t.get('/timesheets/summary?date=2026-03-02', scoped)
			expect(summary.body.rows).toHaveLength(1)
			expect(summary.body.rows[0].paidMinutes).toBe(480)
		})

		it('answers an out-of-scope limit filter like an unknown one, never with an empty list', async () => {
			await twoScopes()
			for (const base of [
				'/timesheets/day?date=2026-03-02',
				'/timesheets/period?date=2026-03-02',
				'/timesheets/review',
				'/timesheets/summary?date=2026-03-02',
				'/timesheets/export?date=2026-03-02',
			]) {
				const hidden = await t.get(
					`${base}&scopeId=${LOC_2}`.replace('review&', 'review?'),
					scoped,
				)
				const unknown = await t.get(
					`${base}&scopeId=loc-nope`.replace('review&', 'review?'),
					scoped,
				)
				expect(hidden.status, base).toBe(404)
				expect(hidden.body, base).toEqual(unknown.body)
			}
		})

		it('does not let a scoped manager read, edit, void, review, approve or add at another scope', async () => {
			const { b, both, only2 } = await twoScopes()
			const detail = await t.get(`/timesheets/entries/${b.id}`, scoped)
			const unknown = await t.get('/timesheets/entries/nope', scoped)
			expect(detail.status).toBe(404)
			expect(detail.body).toEqual(unknown.body)
			const calls: Array<[string, string, unknown]> = [
				[
					'PATCH',
					`/timesheets/entries/${b.id}`,
					{ expectedVersion: 1, managerNote: 'x', reason: 'Edit' },
				],
				[
					'DELETE',
					`/timesheets/entries/${b.id}`,
					{ expectedVersion: 1, reason: 'Delete' },
				],
				['POST', `/timesheets/entries/${b.id}/review`, { expectedVersion: 1 }],
				[
					'POST',
					'/timesheets/entries',
					{
						staffId: both.staffId,
						scopeId: LOC_2,
						date: '2026-03-10',
						startTime: '09:00',
						endTime: '10:00',
						reason: 'Add',
					},
				],
				[
					'POST',
					'/timesheets/entries',
					{
						staffId: only2.staffId,
						scopeId: LOC_2,
						date: '2026-03-10',
						startTime: '09:00',
						endTime: '10:00',
						reason: 'Add',
					},
				],
			]
			for (const [method, path, body] of calls) {
				const r = await t.send(method, path, body, scoped)
				expect(r.status, `${method} ${path}`).toBe(404)
			}
			for (const op of ['approve', 'lock', 'unlock', 'reopen']) {
				const needsReason = op === 'unlock' || op === 'reopen'
				const r = await t.send(
					'POST',
					`/timesheets/${op}`,
					{
						entries: [{ id: b.id, version: 1 }],
						...(needsReason ? { reason: 'Because' } : {}),
					},
					scoped,
				)
				expect(r.body.results[0], op).toMatchObject({
					ok: false,
					code: 'not_found',
				})
			}
			const row = await entryRow(h, b.id)
			expect(row).toMatchObject({
				version: 1,
				status: 'closed',
				managerNote: null,
			})
			expect(await (await h.db(ORG_A)).select().from(timeEntries)).toHaveLength(
				3,
			)
		})

		it('cannot add a card at an allowed scope for a person who only works elsewhere', async () => {
			const { only2 } = await twoScopes()
			const r = await shift(only2.staffId, LOC_1, '2026-03-10')
			expect(r.status).toBe(404)
		})

		it('gives a manager scoped to nothing no access at all', async () => {
			const { a } = await twoScopes()
			const none = { scopeIds: [] as string[] }
			for (const path of [
				'/timesheets/day?date=2026-03-02',
				'/timesheets/period?date=2026-03-02',
				'/timesheets/review',
				'/timesheets/summary?date=2026-03-02',
			]) {
				const r = await t.get(path, none)
				expect(r.status).toBe(200)
				expect(r.body.people ?? r.body.rows).toEqual([])
			}
			expect((await t.get(`/timesheets/entries/${a.id}`, none)).status).toBe(
				404,
			)
			expect(
				((await shift(a.staffId, LOC_1, '2026-03-12')) as any).status,
			).toBe(201)
			const blocked = await t.card(
				{
					staffId: a.staffId,
					scopeId: LOC_1,
					date: '2026-03-13',
					startTime: '09:00',
					endTime: '10:00',
					reason: 'Add',
				},
				none,
			)
			expect(blocked.status).toBe(404)
		})

		it("keeps another scope's open card out of a scoped review queue", async () => {
			await t.staff({ pin: '2222', scopeIds: [LOC_2] })
			const { secret } = await h.pair(ORG_A, LOC_2)
			h.setClock(at('2026-03-10', '08:00'))
			await h.punch(secret, { pin: '2222', kind: 'clock_in' })
			h.setClock(at('2026-03-12', '08:00'))
			const own = await t.get('/timesheets/review', scoped)
			expect(own.body.people).toEqual([])
			expect(own.body.totals.cards).toBe(0)
			const all = await t.get('/timesheets/review')
			expect(all.body.totals.open).toBe(1)
		})

		it('does not let a scoped manager change org-wide pay period settings', async () => {
			const r = await t.send(
				'PUT',
				'/timesheets/settings',
				{ payPeriod: 'biweekly', payPeriodAnchor: null },
				scoped,
			)
			expect(r.status).toBe(403)
			expect((await t.get('/timesheets/settings')).body.payPeriod).toBe(
				'weekly',
			)
		})
	})

	describe('money is omitted, not hidden', () => {
		async function priced() {
			const { staffId } = await t.staff()
			const created = await shift(staffId, LOC_1, '2026-03-02', {
				cashTipsMinor: 1234,
				creditTipsMinor: 777,
			})
			return { staffId, card: created.body.card }
		}

		it('leaves every money key out of every response for a token without the pay grant', async () => {
			const { card } = await priced()
			const grants = TS_APPROVE
			const responses = [
				await t.get('/timesheets/day?date=2026-03-02', { grants }),
				await t.get('/timesheets/period?date=2026-03-02', { grants }),
				await t.get('/timesheets/review', { grants }),
				await t.get('/timesheets/summary?date=2026-03-02', { grants }),
				await t.get(`/timesheets/entries/${card.id}`, { grants }),
				await t.get('/timesheets/export?date=2026-03-02', { grants }),
				await t.get('/timesheets/export?date=2026-03-02&kind=summary', {
					grants,
				}),
				await t.send(
					'PATCH',
					`/timesheets/entries/${card.id}`,
					{ expectedVersion: 1, managerNote: 'note', reason: 'Add a note' },
					{ grants },
				),
				await t.send(
					'POST',
					'/timesheets/entries',
					{
						staffId: card.staffId,
						scopeId: LOC_1,
						date: '2026-03-03',
						startTime: '09:00',
						endTime: '10:00',
						reason: 'Add',
					},
					{ grants },
				),
			]
			for (const r of responses) {
				expect(r.status).toBe(
					200 +
						(r.raw.includes('"card"') && r.body.edit?.action === 'create'
							? 1
							: 0),
				)
				expect(r.raw).not.toMatch(MONEY_KEYS)
				expect(r.raw).not.toMatch(/[:[,](?:1234|777|2000|16000)[,\]}]/)
			}
		})

		it('strips tips and the rate from the edit log for a reader without the pay grant', async () => {
			const { card } = await priced()
			await t.send('PATCH', `/timesheets/entries/${card.id}`, {
				expectedVersion: 1,
				cashTipsMinor: 999,
				reason: 'Fix tips',
			})
			const open = await t.get(`/timesheets/entries/${card.id}`)
			expect(open.body.edits[0].before.cashTipsMinor).toBe(1234)
			expect(open.body.edits[0].after.cashTipsMinor).toBe(999)
			const hours = await t.get(`/timesheets/entries/${card.id}`, {
				grants: TS_APPROVE,
			})
			expect(hours.body.edits).toHaveLength(2)
			for (const edit of hours.body.edits) {
				for (const side of [edit.before, edit.after]) {
					if (side) {
						for (const key of [
							'cashTipsMinor',
							'creditTipsMinor',
							'rateMinor',
							'currency',
						]) {
							expect(side).not.toHaveProperty(key)
						}
						expect(side).toHaveProperty('clockInAt')
					}
				}
			}
		})

		it('refuses a tips change without the pay grant and leaves the card alone', async () => {
			const { card } = await priced()
			for (const body of [{ cashTipsMinor: 0 }, { creditTipsMinor: 5 }]) {
				const r = await t.send(
					'PATCH',
					`/timesheets/entries/${card.id}`,
					{ expectedVersion: 1, reason: 'Tips', ...body },
					{ grants: TS_APPROVE },
				)
				expect(r.status).toBe(403)
			}
			expect(await entryRow(h, card.id)).toMatchObject({
				cashTipsMinor: 1234,
				creditTipsMinor: 777,
				version: 1,
			})
		})

		it('gives the labor grant the aggregate and nothing per person', async () => {
			await priced()
			const grants = [...TS_VIEW, P.READ_LABOR]
			const r = await t.get('/timesheets/period?date=2026-03-02', { grants })
			expect(r.body.labor).toMatchObject({
				estimate: true,
				payMinorByCurrency: { USD: 16000 },
			})
			expect(r.body.people[0].money).toBeUndefined()
			expect(r.body.people[0].cards[0].money).toBeUndefined()
			expect(r.raw).not.toMatch(/rateMinor|cashTips|creditTips|1234|777/)
			// And a labor-only read of the aggregate is not a pay read: no audit row.
			const reads = await (
				await h.db(ORG_A)
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'timesheet.pay.read'))
			expect(reads).toHaveLength(0)
		})
	})

	describe('hostile input', () => {
		it('refuses mass assignment and unknown keys on every write body', async () => {
			const { staffId } = await t.staff()
			const created = await shift(staffId, LOC_1)
			const id = created.body.card.id
			const base = {
				staffId,
				scopeId: LOC_1,
				date: '2026-03-03',
				startTime: '09:00',
				endTime: '10:00',
				reason: 'Add',
			}
			for (const extra of [
				{ status: 'approved' },
				{ approvedBy: 'me' },
				{ lockedAt: 1 },
				{ voidedAt: 1 },
				{ rateMinor: 99999 },
				{ currency: 'SAR' },
				{ id: 'chosen' },
				{ version: 9 },
				{ issues: [] },
				{ paidMinutes: 9999 },
				{ regularMinutes: 1 },
				{ clockOutKind: 'kiosk' },
				{ timeZone: 'UTC' },
				JSON.parse('{"__proto__":{"admin":true}}'),
			]) {
				const r = await t.send('POST', '/timesheets/entries', {
					...base,
					...extra,
				})
				expect(r.status, JSON.stringify(extra)).toBe(400)
				const p = await t.send('PATCH', `/timesheets/entries/${id}`, {
					expectedVersion: 1,
					managerNote: 'x',
					reason: 'Edit',
					...extra,
				})
				expect(p.status, JSON.stringify(extra)).toBe(400)
			}
			expect(await (await h.db(ORG_A)).select().from(timeEntries)).toHaveLength(
				1,
			)
			expect((await entryRow(h, id))!.version).toBe(1)
		})

		it('refuses malformed JSON, non-objects, bad types and bounds, without echoing them', async () => {
			const { staffId } = await t.staff()
			const base = {
				staffId,
				scopeId: LOC_1,
				date: '2026-03-03',
				startTime: '09:00',
				endTime: '10:00',
				reason: 'Add',
			}
			const secret = 'SECRET-VALUE-12345'
			const bodies: unknown[] = [
				[],
				'text',
				null,
				42,
				{ ...base, staffId: 5 },
				{ ...base, staffId: '' },
				{ ...base, scopeId: secret + '/'.repeat(70) },
				{ ...base, date: secret },
				{ ...base, startTime: '9:00' },
				{ ...base, startTime: '25:00' },
				{ ...base, reason: secret.repeat(40) },
				{ ...base, cashTipsMinor: -1 },
				{ ...base, cashTipsMinor: 1.5 },
				{ ...base, cashTipsMinor: 1e12 },
				{ ...base, cashTipsMinor: '100' },
				{ ...base, managerNote: 'n'.repeat(1001) },
				{ ...base, breaks: 'x' },
				{
					...base,
					breaks: [{ kind: secret, startTime: '09:10', endTime: '09:20' }],
				},
				{ ...base, clockInAt: 1, clockOutAt: 2 },
				{
					staffId,
					scopeId: LOC_1,
					clockInAt: Number.MAX_SAFE_INTEGER,
					clockOutAt: Number.MAX_SAFE_INTEGER,
					reason: 'Add',
				},
				{
					staffId,
					scopeId: LOC_1,
					clockInAt: -1,
					clockOutAt: 5,
					reason: 'Add',
				},
			]
			for (const body of bodies) {
				const r = await t.send('POST', '/timesheets/entries', body)
				expect(r.status, JSON.stringify(body)?.slice(0, 80)).toBe(400)
				expect(r.raw).not.toContain(secret)
			}
			const bad = await h.operator('POST', '/timesheets/entries', {
				grants: TS_PAY,
			})
			expect(bad.status).toBe(400)
			const raw = await h.app.request(
				'/operator/timeclock/timesheets/entries',
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${await mintStaffToken({ scope: 'timeclock', grants: TS_PAY })}`,
						'content-type': 'application/json',
					},
					body: '{"staffId": ',
				},
			)
			expect(raw.status).toBe(400)
			expect(await (await h.db(ORG_A)).select().from(timeEntries)).toHaveLength(
				0,
			)
		})

		it('treats hostile ids as not found and leaves the database intact', async () => {
			const { staffId } = await t.staff()
			await shift(staffId, LOC_1)
			for (const id of [
				"'; DROP TABLE time_entries;--",
				'1 OR 1=1',
				'../../etc/passwd',
				'a'.repeat(200),
				'%00',
				'..%2f',
			]) {
				const encoded = encodeURIComponent(id)
				expect((await t.get(`/timesheets/entries/${encoded}`)).status, id).toBe(
					404,
				)
				const p = await t.send('PATCH', `/timesheets/entries/${encoded}`, {
					expectedVersion: 1,
					managerNote: 'x',
					reason: 'Edit',
				})
				expect(p.status, id).toBe(404)
				const d = await t.send('DELETE', `/timesheets/entries/${encoded}`, {
					expectedVersion: 1,
					reason: 'Delete',
				})
				expect(d.status, id).toBe(404)
			}
			const batch = await t.send('POST', '/timesheets/approve', {
				entries: [{ id: "'; DROP TABLE time_entries;--", version: 1 }],
			})
			expect(batch.status).toBe(400)
			expect(await (await h.db(ORG_A)).select().from(timeEntries)).toHaveLength(
				1,
			)
		})

		it('bounds the approval batch and refuses duplicates', async () => {
			const entries = Array.from({ length: 201 }, (_, i) => ({
				id: `e${i}`,
				version: 1,
			}))
			expect(
				(await t.send('POST', '/timesheets/approve', { entries })).status,
			).toBe(400)
			expect(
				(await t.send('POST', '/timesheets/approve', { entries: [] })).status,
			).toBe(400)
			expect(
				(
					await t.send('POST', '/timesheets/approve', {
						entries: [
							{ id: 'a', version: 1 },
							{ id: 'a', version: 1 },
						],
					})
				).status,
			).toBe(400)
			expect(
				(
					await t.send('POST', '/timesheets/approve', {
						entries: [{ id: 'a', version: 0 }],
					})
				).status,
			).toBe(400)
			const ok200 = await t.send('POST', '/timesheets/approve', {
				entries: entries.slice(0, 200),
			})
			expect(ok200.status).toBe(200)
			expect(ok200.body).toMatchObject({ changed: 0, skipped: 200 })
		})

		it('stores a reason that looks like markup as plain text and returns it as JSON data', async () => {
			const { staffId } = await t.staff()
			const reason = '<img src=x onerror=alert(1)> and "quotes"'
			const created = await shift(staffId, LOC_1, '2026-03-02', { reason })
			expect(created.status).toBe(201)
			expect(created.body.edit.reason).toBe(reason)
		})

		it('compares times against the server clock, not the caller', async () => {
			const { staffId } = await t.staff()
			const now = h.clock.now
			const atNow = await t.card({
				staffId,
				scopeId: LOC_1,
				clockInAt: now - 3_600_000,
				clockOutAt: now,
				reason: 'Just ended',
			})
			expect(atNow.status).toBe(201)
			const second = await t.staff()
			const ahead = await t.card({
				staffId: second.staffId,
				scopeId: LOC_1,
				clockInAt: now - 3_600_000,
				clockOutAt: now + 60_000,
				reason: 'A minute ahead',
			})
			expect(ahead.status).toBe(422)
			expect(ahead.body.error).toBe('in_future')
		})
	})

	describe('integrity', () => {
		it('lets exactly one of two simultaneous overlapping cards in', async () => {
			const { staffId } = await t.staff()
			const results = await Promise.all(
				[0, 1, 2, 3].map((i) =>
					t.card({
						staffId,
						scopeId: LOC_1,
						date: '2026-03-02',
						startTime: `09:${String(i * 10).padStart(2, '0')}`,
						endTime: '12:00',
						reason: `Racer ${i}`,
					}),
				),
			)
			expect(results.filter((r) => r.status === 201)).toHaveLength(1)
			expect(results.filter((r) => r.status === 409)).toHaveLength(3)
			expect(await (await h.db(ORG_A)).select().from(timeEntries)).toHaveLength(
				1,
			)
			expect(
				await (await h.db(ORG_A)).select().from(timeEntryEdits),
			).toHaveLength(1)
			expect(
				await (await h.db(ORG_A)).select().from(notificationOutbox),
			).toHaveLength(1)
		})

		it("keeps a locked card's figures even when a neighbouring card moves overtime", async () => {
			await t.setPolicy(LOC_1, {
				dailyOvertime: { thresholdMinutes: 480, multiplierBp: 15000 },
				timesheetApprovalMode: 'approve_lock',
			})
			const { staffId } = await t.staff()
			const eight = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '08:00',
				endTime: '16:00',
				reason: 'Shift',
			})
			const id = eight.body.card.id
			await t.send('POST', '/timesheets/approve', {
				entries: [{ id, version: 1 }],
			})
			await t.send('POST', '/timesheets/lock', {
				entries: [{ id, version: 2 }],
			})
			const before = await entryRow(h, id)
			await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '05:00',
				endTime: '07:00',
				reason: 'Earlier prep',
			})
			const earlier = await t.card({
				staffId,
				scopeId: LOC_1,
				date: '2026-03-02',
				startTime: '17:00',
				endTime: '19:00',
				reason: 'Late prep',
			})
			expect(earlier.status).toBe(201)
			expect(await entryRow(h, id)).toEqual(before)
		})

		it('never deletes a card, never edits the log, never edits a punch', async () => {
			const { staffId } = await t.staff()
			const created = await shift(staffId, LOC_1)
			const db = await h.db(ORG_A)
			await expect(
				db.delete(timeEntries).where(eq(timeEntries.id, created.body.card.id)),
			).rejects.toThrow()
			await expect(db.delete(timeEntryEdits)).rejects.toThrow()
			await expect(
				db.update(timeEntryEdits).set({ reason: 'rewritten' }),
			).rejects.toThrow()
		})

		it('lets a person clock in again after their open card was voided, and refuses a stale void', async () => {
			await t.staff({ pin: '3333' })
			const { secret } = await h.pair(ORG_A, LOC_1)
			h.setClock(at('2026-03-10', '08:00'))
			await h.punch(secret, { pin: '3333', kind: 'clock_in' })
			h.setClock(at('2026-03-12', '08:00'))
			const open = (await t.get('/timesheets/review')).body.people[0].cards[0]
			const stale = await t.send('DELETE', `/timesheets/entries/${open.id}`, {
				expectedVersion: 5,
				reason: 'Ghost card',
			})
			expect(stale.status).toBe(409)
			const voided = await t.send('DELETE', `/timesheets/entries/${open.id}`, {
				expectedVersion: open.version,
				reason: 'Ghost card from a test punch',
			})
			expect(voided.status).toBe(200)
			// An open card measured nothing, so this did not cut anyone's hours.
			expect(voided.body.reducedHours).toBe(false)
			const again = await h.punch(secret, { pin: '3333', kind: 'clock_in' })
			expect(again.status).toBe(200)
		})

		it('keeps one edit-log row per successful write and none per refused one, across a random run', async () => {
			await t.setPolicy(LOC_1, { timesheetApprovalMode: 'approve_lock' })
			const people = [await t.staff(), await t.staff(), await t.staff()]
			let seed = 12345
			const rand = (n: number) => {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff
				return seed % n
			}
			const dates = ['2026-03-02', '2026-03-03', '2026-03-04']
			const known = new Map<
				string,
				{ version: number; status: string; voided: boolean }
			>()
			let successes = 0
			let refusals = 0
			let logged = 0

			const expectLogDelta = async (fn: () => Promise<boolean>) => {
				const before = (await (await h.db(ORG_A)).select().from(timeEntryEdits))
					.length
				const wrote = await fn()
				const after = (await (await h.db(ORG_A)).select().from(timeEntryEdits))
					.length
				expect(after - before).toBe(wrote ? 1 : 0)
				if (wrote) successes++
				else refusals++
				logged = after
			}

			for (let step = 0; step < 120; step++) {
				const ids = [...known.keys()]
				const action = rand(8)
				const id = ids.length ? ids[rand(ids.length)]! : null
				if (action === 0 || id === null) {
					await expectLogDelta(async () => {
						const person = people[rand(people.length)]!
						const startH = 6 + rand(10)
						const r = await t.card({
							staffId: person.staffId,
							scopeId: LOC_1,
							date: dates[rand(dates.length)],
							startTime: `${String(startH).padStart(2, '0')}:00`,
							endTime: `${String(startH + 1 + rand(3)).padStart(2, '0')}:00`,
							reason: `Random add ${step}`,
						})
						if (r.status === 201)
							known.set(r.body.card.id, {
								version: 1,
								status: 'closed',
								voided: false,
							})
						return r.status === 201
					})
					continue
				}
				const state = known.get(id)!
				const version = rand(6) === 0 ? state.version + 3 : state.version
				await expectLogDelta(async () => {
					let response: { status: number; body: any }
					if (action === 1 || action === 2) {
						response = await t.send('PATCH', `/timesheets/entries/${id}`, {
							expectedVersion: version,
							cashTipsMinor: rand(5000),
							reason: `Random edit ${step}`,
						})
					} else if (action === 3) {
						response = await t.send('DELETE', `/timesheets/entries/${id}`, {
							expectedVersion: version,
							reason: `Random void ${step}`,
						})
					} else if (action === 4) {
						response = await t.send(
							'POST',
							`/timesheets/entries/${id}/review`,
							{ expectedVersion: version },
						)
					} else {
						const op =
							['approve', 'lock', 'unlock', 'reopen'][action - 5] ?? 'approve'
						const r = await t.send('POST', `/timesheets/${op}`, {
							entries: [{ id, version }],
							reason: `Random ${op} ${step}`,
						})
						response = { status: r.status, body: r.body.results?.[0] ?? r.body }
						const wrote = r.body.results?.[0]?.ok === true
						if (wrote)
							known.set(id, {
								...state,
								version: r.body.results[0].version,
								status: r.body.results[0].status,
							})
						return wrote
					}
					if (response.status === 200) {
						state.version = response.body.card?.version ?? state.version + 1
						if (response.body.card === null) state.voided = true
						return true
					}
					return false
				})
			}
			expect(successes).toBeGreaterThan(20)
			expect(refusals).toBeGreaterThan(10)

			// Invariants after the run: every card's version is 1 plus its logged
			// changes, every log row has a reason, and nothing locked drifted.
			const db = await h.db(ORG_A)
			const rows = await db.select().from(timeEntries)
			const edits = await db.select().from(timeEntryEdits)
			expect(edits).toHaveLength(logged)
			for (const row of rows) {
				const mine = edits.filter((e) => e.entryId === row.id)
				expect(mine.length, row.id).toBe(row.version)
				expect(mine[0]!.action).toBe('create')
				for (const e of mine) expect(e.reason.trim().length).toBeGreaterThan(0)
				if (row.voidedAt !== null)
					expect(mine[mine.length - 1]!.action).toBe('void')
			}
			const outbox = await db.select().from(notificationOutbox)
			const timeEdits = edits.filter((e) =>
				['create', 'update', 'void'].includes(e.action),
			)
			expect(outbox).toHaveLength(timeEdits.length)
		})
	})
	describe('completeness of what payroll takes away', () => {
		it('refuses an export, and never calls the period ready, when the view was cut off', async () => {
			const person = await t.staff({ firstName: 'Many', scopeIds: [LOC_1] })
			const db = await h.db(ORG_A)
			const base = at('2026-03-02', '00:00')
			const rows = Array.from({ length: 2001 }, (_, i) => ({
				staffId: person.staffId,
				scopeId: LOC_1,
				clockInAt: base + i * 60_000,
				clockOutAt: base + i * 60_000 + 30_000,
				timeZone: CHI,
				localDate: '2026-03-02',
				status: 'closed' as const,
				createdAt: base,
				updatedAt: base,
			}))
			for (let i = 0; i < rows.length; i += 100) {
				await db.insert(timeEntries).values(rows.slice(i, i + 100))
			}

			const day = await t.get('/timesheets/day?date=2026-03-02')
			expect(day.status).toBe(200)
			expect(day.body.truncated).toBe(true)

			const summary = await t.get('/timesheets/summary?date=2026-03-02')
			expect(summary.status).toBe(200)
			expect(summary.body.truncated).toBe(true)
			expect(summary.body.readyForPayroll).toBe(false)

			for (const kind of ['cards', 'summary']) {
				const response = await t.get(
					`/timesheets/export?date=2026-03-02&kind=${kind}`,
				)
				expect(response.status, kind).toBe(422)
				expect(response.body.error).toBe('range_too_large')
				expect(response.raw).not.toContain('csv')
			}

			// A period within the cap still exports.
			const narrow = await t.get('/timesheets/export?date=2026-03-09')
			expect(narrow.status).toBe(200)
		})
	})
})
