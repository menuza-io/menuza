import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shifts, staffMembers } from '@repo/tenant-db'
import {
	makeOrg,
	mintStaffToken,
	OPERATOR_SECRET,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	ORG_B,
	SCH_EDIT,
	SCH_PAY,
	scheduleFixture,
	type ClockHarness,
	type ScheduleFixture,
} from '../../tests/schedule-harness.ts'

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

const WEEK = '2026-03-02'
const validShift = {
	scopeId: LOC_1,
	dates: [WEEK],
	startTime: '09:00',
	endTime: '17:00',
}

describe('/operator/schedule adversarial', () => {
	let h: ClockHarness
	let s: ScheduleFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		h = await createClockHarness([ORG_A, ORG_B])
		s = scheduleFixture(h)
		h.setClock(at('2026-03-02', '12:00'))
	})
	afterEach(async () => {
		await h.cleanup()
	})

	describe('tokens', () => {
		it('rejects a forged, expired, wrongly addressed or other-secret token', async () => {
			const path = `/week?scopeId=${LOC_1}&date=${WEEK}`
			const bad = [
				await mintStaffToken({
					scope: 'schedule',
					grants: SCH_PAY,
					secret: 'x'.repeat(40),
				}),
				await mintStaffToken({
					scope: 'schedule',
					grants: SCH_PAY,
					audience: 'tenant-api-operator',
				}),
				await mintStaffToken({
					scope: 'schedule',
					grants: SCH_PAY,
					typ: 'JWT',
				}),
				await mintStaffToken({
					scope: 'schedule',
					grants: SCH_PAY,
					issuedAt: Math.floor(Date.now() / 1000) - 7200,
				}),
				await mintStaffToken({
					scope: 'schedule',
					grants: SCH_PAY,
					lifetimeSeconds: 7200,
				}),
				await mintStaffToken({
					scope: 'schedule',
					grants: SCH_PAY,
					role: 'customer',
				}),
			]
			for (const token of bad) {
				expect((await s.get(path, { token })).status).toBe(401)
			}
			expect(OPERATOR_SECRET.length).toBeGreaterThan(16)
		})

		it('refuses a token for another scope, even with every grant', async () => {
			for (const scope of ['staff', 'timeclock', 'hiring']) {
				const response = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, {
					scope,
				})
				expect(response.status).toBe(403)
			}
		})

		it('never reaches another organization through ids or tokens', async () => {
			const { staffId } = await s.staff({}, ORG_A)
			const shift = await s.shift({ staffId, date: WEEK })
			// A manager of organization B cannot see, change or remove it.
			const asB = { orgId: ORG_B }
			expect(
				(await s.send('PATCH', `/shifts/${shift.id}`, { notes: 'x' }, asB))
					.status,
			).toBe(404)
			expect(
				(await s.send('DELETE', `/shifts/${shift.id}`, undefined, asB)).status,
			).toBe(404)
			expect(
				(await s.send('POST', `/shifts/${shift.id}/assign`, { staffId }, asB))
					.status,
			).toBe(422)
			const week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, asB)
			expect(week.body.shifts).toEqual([])
			expect(week.raw).not.toContain(staffId)
			// An unprovisioned or unknown organization is not found.
			orgs.set(ORG_B, makeOrg(ORG_B, { hasProvisionedDb: false }))
			expect(
				(await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, asB)).status,
			).toBe(404)
		})

		it('refuses a node in another region', async () => {
			await h.cleanup()
			orgs.set(ORG_A, makeOrg(ORG_A, { dataRegion: 'ksa' }))
			h = await createClockHarness([ORG_A], 'us')
			s = scheduleFixture(h)
			const response = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('region_mismatch')
		})

		it('lets an impersonated session look but never see wages or write', async () => {
			const { staffId, positionIds } = await s.staff()
			await s.shift({ staffId, positionId: positionIds[0], date: WEEK })
			const view = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, {
				impersonated: true,
			})
			expect(view.status).toBe(200)
			expect(view.raw).not.toMatch(
				/costMinor|weekCostMinor|laborTarget|16000|2000/,
			)
			for (const [method, path, body] of [
				['POST', '/shifts', validShift],
				['POST', '/publish', { scopeId: LOC_1, weekStart: WEEK }],
				[
					'POST',
					'/copy',
					{ scopeId: LOC_1, fromWeekStart: WEEK, toWeekStart: '2026-03-09' },
				],
				['PUT', '/settings', { minRestMinutes: 0 }],
			] as const) {
				expect(
					(await s.send(method, path, body, { impersonated: true })).status,
				).toBe(403)
			}
		})
	})

	describe('scope limit', () => {
		it('treats shifts at other scopes as missing, and refuses writes that name them', async () => {
			const away = await s.staff({ scopeIds: [LOC_2] })
			const there = await s.shift({
				scopeId: LOC_2,
				staffId: away.staffId,
				date: WEEK,
			})
			const scoped = { scopeIds: [LOC_1] }
			expect(
				(await s.send('PATCH', `/shifts/${there.id}`, { notes: 'x' }, scoped))
					.status,
			).toBe(404)
			expect(
				(await s.send('DELETE', `/shifts/${there.id}`, undefined, scoped))
					.status,
			).toBe(404)
			expect(
				(await s.send('POST', `/shifts/${there.id}/unassign`, {}, scoped))
					.status,
			).toBe(404)
			expect(
				(await s.send('POST', `/shifts/${there.id}/revert`, undefined, scoped))
					.status,
			).toBe(404)
			expect(
				(
					await s.send(
						'POST',
						'/shifts',
						{ ...validShift, scopeId: LOC_2 },
						scoped,
					)
				).status,
			).toBe(403)
			expect(
				(
					await s.send(
						'POST',
						'/publish',
						{ scopeId: LOC_2, weekStart: WEEK },
						scoped,
					)
				).status,
			).toBe(403)
			expect(
				(
					await s.send(
						'POST',
						'/recommend',
						{
							scopeId: LOC_2,
							baseWeekStart: WEEK,
							targetWeekStart: '2026-03-09',
						},
						scoped,
					)
				).status,
			).toBe(403)
			expect(
				(await s.get(`/publications?scopeId=${LOC_2}`, scoped)).status,
			).toBe(404)
			// Nothing changed behind the 404s.
			const db = await h.db(ORG_A)
			const [row] = await db
				.select()
				.from(shifts)
				.where(eq(shifts.id, there.id))
			expect(row).toMatchObject({
				staffId: away.staffId,
				notes: null,
				version: 1,
			})
		})

		it('cannot put someone from another scope on a shift it can see', async () => {
			const away = await s.staff({ scopeIds: [LOC_2] })
			const open = await s.shift({ date: WEEK })
			const response = await s.send(
				'POST',
				`/shifts/${open.id}/assign`,
				{ staffId: away.staffId },
				{ scopeIds: [LOC_1] },
			)
			expect(response.status).toBe(422)
			expect(response.body.error).toBe('staff_not_found')
		})

		it('gives a token with no scopes at all nothing to see or change', async () => {
			const none = { scopeIds: [] as string[] }
			expect(
				(await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, none)).status,
			).toBe(404)
			expect((await s.send('POST', '/shifts', validShift, none)).status).toBe(
				403,
			)
			expect((await s.get('/time-off', none)).body).toEqual([])
			expect((await s.get('/availability', none)).body).toEqual([])
			expect((await s.get('/requests', none)).body).toEqual([])
		})
	})

	describe('input', () => {
		it('refuses extra keys, so a shift cannot be created already published or at a version', async () => {
			for (const extra of [
				{ status: 'published' },
				{ version: 9 },
				{ draftPatch: { cancel: true } },
				{ createdBy: 'someone' },
				{ timeZone: 'UTC' },
			]) {
				const response = await s.send('POST', '/shifts', {
					...validShift,
					...extra,
				})
				expect(response.status).toBe(400)
			}
			const proto = await h.app.request('/operator/schedule/shifts', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${await mintStaffToken({ scope: 'schedule', grants: SCH_PAY })}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(validShift).replace(
					'{',
					'{"__proto__":{"admin":true},',
				),
			})
			expect(proto.status).toBe(400)
			const created = await s.shift({ date: WEEK })
			for (const extra of [
				{ status: 'cancelled' },
				{ scopeId: LOC_2 },
				{ startsAt: 1 },
			]) {
				const response = await s.send('PATCH', `/shifts/${created.id}`, {
					notes: 'x',
					...extra,
				})
				expect(response.status).toBe(400)
			}
		})

		it('does not echo rejected values back', async () => {
			const response = await s.send('POST', '/shifts', {
				...validShift,
				startTime: '<script>alert(1)</script>',
			})
			expect(response.status).toBe(400)
			expect(response.raw).not.toContain('script')
			const enumBad = await s.send('POST', '/publish', {
				scopeId: LOC_1,
				weekStart: WEEK,
				notifyMode: 'bcc-everyone-evil',
			})
			expect(enumBad.status).toBe(400)
			expect(enumBad.raw).not.toContain('evil')
		})

		it('rejects broken or hostile bodies and ids', async () => {
			const headers = {
				Authorization: `Bearer ${await mintStaffToken({ scope: 'schedule', grants: SCH_PAY })}`,
			}
			const raw = await h.app.request('/operator/schedule/shifts', {
				method: 'POST',
				headers: { ...headers, 'content-type': 'application/json' },
				body: '{not json',
			})
			expect(raw.status).toBe(400)
			const array = await s.send('POST', '/shifts', [validShift])
			expect(array.status).toBe(400)
			for (const id of [
				"' OR 1=1 --",
				'../../etc/passwd',
				'%00',
				'x'.repeat(200),
			]) {
				expect(
					(
						await s.send('PATCH', `/shifts/${encodeURIComponent(id)}`, {
							notes: 'x',
						})
					).status,
				).toBe(404)
				expect(
					(await s.send('DELETE', `/shifts/${encodeURIComponent(id)}`)).status,
				).toBe(404)
				expect(
					(
						await s.send(
							'POST',
							`/requests/${encodeURIComponent(id)}/decision`,
							{ decision: 'approve' },
						)
					).status,
				).toBe(404)
			}
		})

		it('bounds lists and batches', async () => {
			const dates = Array.from({ length: 32 }, (_, i) =>
				new Date(Date.UTC(2026, 2, 1 + i)).toISOString().slice(0, 10),
			)
			expect(
				(await s.send('POST', '/shifts', { ...validShift, dates })).status,
			).toBe(400)
			expect(
				(
					await s.send('POST', '/shifts', {
						...validShift,
						dates: [WEEK, WEEK],
					})
				).status,
			).toBe(400)
			expect(
				(await s.send('POST', '/shifts', { ...validShift, dates: [] })).status,
			).toBe(400)
			expect(
				(
					await s.send('POST', '/shifts', {
						...validShift,
						dates: ['2026-02-30'],
					})
				).status,
			).toBe(400)
			expect(
				(
					await s.send('POST', '/shifts', {
						...validShift,
						notes: 'n'.repeat(501),
					})
				).status,
			).toBe(400)
			const people = Array.from({ length: 501 }, (_, i) => `p${i}`)
			expect(
				(
					await s.send('POST', '/recommend', {
						scopeId: LOC_1,
						baseWeekStart: WEEK,
						targetWeekStart: '2026-03-09',
						scope: { mode: 'people', staffIds: people },
					})
				).status,
			).toBe(400)
			expect((await s.get('/time-off?limit=100000')).status).toBe(400)
			expect(
				(
					await s.send('POST', '/availability/decision', {
						ids: [],
						decision: 'approve',
					})
				).status,
			).toBe(400)
		})

		it('stores notes as plain text, never interpreting them', async () => {
			const note = '<img src=x onerror=alert(1)> =HYPERLINK("http://x")'
			const view = await s.shift({ date: WEEK, notes: note })
			expect(view.notes).toBe(note)
			const week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`)
			expect(week.body.shifts[0].notes).toBe(note)
			expect(week.headers.get('content-type')).toContain('application/json')
			expect(week.headers.get('cache-control')).toContain('no-store')
		})
	})

	describe('races and integrity', () => {
		it('lets exactly one of two edits from the same version win', async () => {
			const created = await s.shift({ date: WEEK })
			const results = await Promise.all([
				s.send('PATCH', `/shifts/${created.id}`, {
					notes: 'a',
					expectedVersion: 1,
				}),
				s.send('PATCH', `/shifts/${created.id}`, {
					notes: 'b',
					expectedVersion: 1,
				}),
			])
			expect(results.map((r) => r.status).sort()).toEqual([200, 409])
		})

		it('publishes a week once when two managers press the button together', async () => {
			const { staffId } = await s.staff()
			await s.shift({ staffId, date: WEEK })
			const results = await Promise.all([
				s.publish(LOC_1, WEEK),
				s.publish(LOC_1, WEEK),
			])
			expect(results.map((r) => r.status).sort()).toEqual([200, 409])
			const history = await s.get(`/publications?scopeId=${LOC_1}`)
			expect(history.body).toHaveLength(1)
		})

		it('never publishes a draft onto someone who has left', async () => {
			const { staffId } = await s.staff()
			const draft = await s.shift({ staffId, date: WEEK })
			const db = await h.db(ORG_A)
			await db
				.update(staffMembers)
				.set({ status: 'terminated' })
				.where(eq(staffMembers.id, staffId))
			const published = await s.publish(LOC_1, WEEK)
			expect(published.body.publication.changes).toEqual([
				{ shiftId: draft.id, kind: 'created', staffId: null },
			])
			const [row] = await db
				.select()
				.from(shifts)
				.where(eq(shifts.id, draft.id))
			expect(row).toMatchObject({ staffId: null, status: 'published' })
		})

		it('keeps publications free of names, times and pay', async () => {
			const { staffId, positionIds } = await s.staff({
				firstName: 'Zelda',
				lastName: 'Quinn',
			})
			await s.shift({
				staffId,
				positionId: positionIds[0],
				date: WEEK,
				notes: 'secret',
			})
			const published = await s.publish(LOC_1, WEEK)
			expect(published.raw).not.toMatch(/Zelda|Quinn|secret|2000|16000|09:00/)
		})

		it('is guarded by the database itself, whatever writes to it', async () => {
			const db = await h.db(ORG_A)
			await expect(
				db.insert(shifts).values({
					scopeId: LOC_1,
					startsAt: 2000,
					endsAt: 1000,
					localDate: WEEK,
					timeZone: CHI,
				}),
			).rejects.toThrow()
			const created = await s.shift({ date: WEEK })
			await s.publish(LOC_1, WEEK)
			await s.send('DELETE', `/shifts/${created.id}`)
			await s.publish(LOC_1, WEEK)
			await expect(
				db
					.update(shifts)
					.set({ notes: 'rewrite history' })
					.where(eq(shifts.id, created.id)),
			).rejects.toThrow()
		})

		it('answers a database failure without leaking the statement', async () => {
			const db = await h.db(ORG_A)
			await db.run(sql`drop table shift_requests`)
			const response = await s.get(`/requests`)
			expect(response.status).toBe(500)
			expect(response.body).toEqual({ error: 'Internal Server Error' })
			expect(response.raw).not.toMatch(/select|shift_requests|from/i)
		})
	})

	describe('scale', () => {
		it('loads a busy week of many people and shifts', async () => {
			const crew = []
			for (let i = 0; i < 40; i++) crew.push(await s.staff())
			const db = await h.db(ORG_A)
			const rows = []
			for (const [index, member] of crew.entries()) {
				for (let day = 0; day < 6; day++) {
					const date = new Date(Date.UTC(2026, 2, 2 + day))
						.toISOString()
						.slice(0, 10)
					rows.push({
						scopeId: LOC_1,
						staffId: member.staffId,
						positionId: member.positionIds[0],
						startsAt: at(date, '09:00') + (index % 3) * 3_600_000,
						endsAt: at(date, '17:00') + (index % 3) * 3_600_000,
						localDate: date,
						timeZone: CHI,
						status: 'published' as const,
					})
				}
			}
			for (let i = 0; i < rows.length; i += 100)
				await db.insert(shifts).values(rows.slice(i, i + 100))
			const started = Date.now()
			const week = await s.get(`/week?scopeId=${LOC_1}&date=${WEEK}`, {
				grants: SCH_PAY,
			})
			expect(week.status).toBe(200)
			expect(week.body.shifts).toHaveLength(240)
			expect(week.body.people).toHaveLength(40)
			expect(Date.now() - started).toBeLessThan(5000)
			expect(SCH_EDIT.length).toBeGreaterThan(0)
		})
	})
})
