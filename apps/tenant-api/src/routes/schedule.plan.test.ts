import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shifts, staffMembers } from '@repo/tenant-db'
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

const WEEK = '2026-03-02' // Monday, before the March 8 clock change
const NEXT = '2026-03-09'

async function weekShifts(s: ScheduleFixture, week: string, options = {}) {
	const response = await s.get(`/week?scopeId=${LOC_1}&date=${week}`, options)
	return response.body.shifts as any[]
}

describe('copy, templates and recommend', () => {
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

	describe('copy week', () => {
		it('copies to the same weekday and keeps local times across a clock change', async () => {
			const { staffId, positionIds } = await s.staff()
			await s.shift({
				staffId,
				positionId: positionIds[0],
				date: '2026-03-02',
				start: '09:00',
				end: '17:00',
				notes: 'Open',
			})
			await s.shift({
				staffId,
				date: '2026-03-07',
				start: '22:00',
				end: '01:00',
			})
			await s.shift({ date: '2026-03-04', start: '10:00', end: '14:00' })

			const copied = await s.send('POST', '/copy', {
				scopeId: LOC_1,
				fromWeekStart: WEEK,
				toWeekStart: NEXT,
			})
			expect(copied.status).toBe(201)
			expect(copied.body).toEqual({
				weekStart: NEXT,
				created: 3,
				skippedDuplicates: 0,
				skippedUnplaceable: 0,
				openedForInactive: 0,
			})
			const copies = await weekShifts(s, NEXT)
			expect(copies).toHaveLength(3)
			expect(copies.every((x) => x.state === 'draft')).toBe(true)
			const byDate = Object.fromEntries(copies.map((x) => [x.localDate, x]))
			// 09:00 stays 09:00 on the new Monday, an hour earlier in UTC after the change.
			expect(byDate['2026-03-09'].startsAt).toBe(at('2026-03-09', '09:00'))
			expect(at('2026-03-09', '09:00') - at('2026-03-02', '09:00')).toBe(
				7 * 86_400_000 - 3_600_000,
			)
			expect(byDate['2026-03-09'].notes).toBe('Open')
			// The Saturday night shift crosses midnight into the new Sunday.
			expect(byDate['2026-03-14'].startsAt).toBe(at('2026-03-14', '22:00'))
			expect(byDate['2026-03-14'].endsAt).toBe(at('2026-03-15', '01:00'))
			expect(byDate['2026-03-11'].staffId).toBeNull()
		})

		it('copies again without doubling anything', async () => {
			const { staffId } = await s.staff()
			await s.shift({ staffId, date: WEEK })
			const body = { scopeId: LOC_1, fromWeekStart: WEEK, toWeekStart: NEXT }
			expect((await s.send('POST', '/copy', body)).body.created).toBe(1)
			const again = await s.send('POST', '/copy', body)
			expect(again.body).toMatchObject({ created: 0, skippedDuplicates: 1 })
			expect(await weekShifts(s, NEXT)).toHaveLength(1)
		})

		it('limits a copy to positions or to people, and can leave open shifts out', async () => {
			const a = await s.staff({
				positions: [{ name: 'Cook', rateMinor: 2000 }],
			})
			const b = await s.staff({
				positions: [{ name: 'Server', rateMinor: 1500 }],
			})
			await s.shift({
				staffId: a.staffId,
				positionId: a.positionIds[0],
				date: WEEK,
			})
			await s.shift({
				staffId: b.staffId,
				positionId: b.positionIds[0],
				date: WEEK,
			})
			await s.shift({ date: WEEK, start: '18:00', end: '22:00' })

			const byPosition = await s.send('POST', '/copy', {
				scopeId: LOC_1,
				fromWeekStart: WEEK,
				toWeekStart: NEXT,
				scope: { mode: 'positions', positionIds: [a.positionIds[0]] },
			})
			expect(byPosition.body.created).toBe(1)

			const byPeople = await s.send('POST', '/copy', {
				scopeId: LOC_1,
				fromWeekStart: WEEK,
				toWeekStart: '2026-03-16',
				scope: { mode: 'people', staffIds: [b.staffId] },
			})
			// A people scope names people: open shifts never come along.
			expect(byPeople.body.created).toBe(1)

			const noOpen = await s.send('POST', '/copy', {
				scopeId: LOC_1,
				fromWeekStart: WEEK,
				toWeekStart: '2026-03-23',
				includeOpenShifts: false,
			})
			expect(noOpen.body.created).toBe(2)
		})

		it('turns the shifts of someone who has left into open shifts', async () => {
			const { staffId } = await s.staff()
			await s.shift({ staffId, date: WEEK })
			const db = await h.db(ORG_A)
			await db
				.update(staffMembers)
				.set({ status: 'terminated' })
				.where(eq(staffMembers.id, staffId))
			const copied = await s.send('POST', '/copy', {
				scopeId: LOC_1,
				fromWeekStart: WEEK,
				toWeekStart: NEXT,
			})
			expect(copied.body).toMatchObject({ created: 1, openedForInactive: 1 })
			expect((await weekShifts(s, NEXT))[0].staffId).toBeNull()
		})

		it('ignores shifts waiting to be removed and never copies into the same week', async () => {
			const { staffId } = await s.staff()
			const live = await s.shift({ staffId, date: WEEK })
			await s.publish(LOC_1, WEEK)
			await s.send('DELETE', `/shifts/${live.id}`)
			const copied = await s.send('POST', '/copy', {
				scopeId: LOC_1,
				fromWeekStart: WEEK,
				toWeekStart: NEXT,
			})
			expect(copied.body.created).toBe(0)
			const same = await s.send('POST', '/copy', {
				scopeId: LOC_1,
				fromWeekStart: WEEK,
				toWeekStart: '2026-03-04',
			})
			expect(same.body.error).toBe('same_week')
		})

		it('snaps both dates to week starts for a Sunday-start scope', async () => {
			await s.setPolicy(LOC_1, { weekStartsOn: 0 })
			const { staffId } = await s.staff()
			await s.shift({ staffId, date: '2026-03-01' }) // Sunday: first day of the week
			const copied = await s.send('POST', '/copy', {
				scopeId: LOC_1,
				fromWeekStart: '2026-03-04',
				toWeekStart: '2026-03-12',
			})
			expect(copied.body).toMatchObject({ weekStart: '2026-03-08', created: 1 })
			expect((await weekShifts(s, '2026-03-08'))[0].localDate).toBe(
				'2026-03-08',
			)
		})

		it('refuses a scope outside the token with 403', async () => {
			const response = await s.send(
				'POST',
				'/copy',
				{ scopeId: LOC_2, fromWeekStart: WEEK, toWeekStart: NEXT },
				{ scopeIds: [LOC_1] },
			)
			expect(response.status).toBe(403)
			expect(response.body.error).toBe('scope_out_of_scope')
		})

		it('refuses a week that is already full', async () => {
			const db = await h.db(ORG_A)
			const base = at(NEXT, '09:00')
			const rows = Array.from({ length: 2500 }, (_, i) => ({
				scopeId: LOC_1,
				startsAt: base + i * 60_000,
				endsAt: base + i * 60_000 + 3_600_000,
				localDate: NEXT,
				timeZone: CHI,
			}))
			for (let i = 0; i < rows.length; i += 250) {
				await db.insert(shifts).values(rows.slice(i, i + 250))
			}
			const response = await s.send('POST', '/shifts', {
				scopeId: LOC_1,
				dates: [NEXT],
				startTime: '09:00',
				endTime: '10:00',
			})
			expect(response.status).toBe(422)
			expect(response.body).toMatchObject({
				error: 'week_full',
				weekStart: NEXT,
			})
		})
	})

	describe('templates', () => {
		it('saves a week as a template and applies it to another week', async () => {
			const { staffId } = await s.staff()
			await s.shift({
				staffId,
				date: '2026-03-02',
				start: '09:00',
				end: '15:00',
			})
			await s.shift({ date: '2026-03-06', start: '17:00', end: '23:00' })

			const created = await s.send('POST', '/templates', {
				scopeId: LOC_1,
				name: 'Standard week',
				fromWeekStart: WEEK,
			})
			expect(created.status).toBe(201)
			expect(created.body).toMatchObject({
				name: 'Standard week',
				slotCount: 2,
				scopeId: LOC_1,
			})

			const list = await s.get(`/templates?scopeId=${LOC_1}`)
			expect(list.body.map((t: any) => t.name)).toEqual(['Standard week'])
			expect(list.raw).not.toContain(staffId)

			const applied = await s.send(
				'POST',
				`/templates/${created.body.id}/apply`,
				{
					weekStart: '2026-03-16',
				},
			)
			expect(applied.status).toBe(201)
			expect(applied.body).toMatchObject({
				weekStart: '2026-03-16',
				created: 2,
			})
			const shiftsOut = await weekShifts(s, '2026-03-16')
			expect(shiftsOut.map((x) => [x.localDate, x.staffId === null])).toEqual([
				['2026-03-16', false],
				['2026-03-20', true],
			])

			const twice = await s.send(
				'POST',
				`/templates/${created.body.id}/apply`,
				{
					weekStart: '2026-03-16',
				},
			)
			expect(twice.body).toMatchObject({ created: 0, skippedDuplicates: 2 })

			const open = await s.send('POST', `/templates/${created.body.id}/apply`, {
				weekStart: '2026-03-23',
				assignments: 'open',
			})
			expect(open.body.created).toBe(2)
			expect(
				(await weekShifts(s, '2026-03-23')).every((x) => x.staffId === null),
			).toBe(true)
		})

		it('keeps template names unique per scope, ignoring case', async () => {
			await s.shift({ date: WEEK })
			const body = { scopeId: LOC_1, name: 'Busy', fromWeekStart: WEEK }
			expect((await s.send('POST', '/templates', body)).status).toBe(201)
			const dup = await s.send('POST', '/templates', { ...body, name: 'busy' })
			expect(dup.status).toBe(409)
			expect(dup.body.error).toBe('template_name_taken')
		})

		it('refuses an empty template, and deletes one', async () => {
			const empty = await s.send('POST', '/templates', {
				scopeId: LOC_1,
				name: 'Nothing',
				fromWeekStart: WEEK,
			})
			expect(empty.body.error).toBe('empty_template')
			await s.shift({ date: WEEK })
			const created = await s.send('POST', '/templates', {
				scopeId: LOC_1,
				name: 'One',
				fromWeekStart: WEEK,
			})
			expect(
				(await s.send('DELETE', `/templates/${created.body.id}`)).status,
			).toBe(200)
			expect(
				(await s.send('DELETE', `/templates/${created.body.id}`)).status,
			).toBe(404)
		})

		it('places weekdays correctly in a Sunday-start week', async () => {
			await s.setPolicy(LOC_1, { weekStartsOn: 0 })
			await s.shift({ date: '2026-03-01' }) // Sunday
			await s.shift({ date: '2026-03-07' }) // Saturday
			const created = await s.send('POST', '/templates', {
				scopeId: LOC_1,
				name: 'Weekend',
				fromWeekStart: '2026-03-01',
			})
			await s.send('POST', `/templates/${created.body.id}/apply`, {
				weekStart: '2026-03-15',
			})
			expect(
				(await weekShifts(s, '2026-03-15')).map((x) => x.localDate),
			).toEqual(['2026-03-15', '2026-03-21'])
		})

		it('hides templates and cannot apply them outside the token scopes', async () => {
			await s.shift({ date: WEEK })
			const created = await s.send('POST', '/templates', {
				scopeId: LOC_1,
				name: 'Mine',
				fromWeekStart: WEEK,
			})
			const other = { scopeIds: [LOC_2] }
			expect((await s.get(`/templates?scopeId=${LOC_1}`, other)).status).toBe(
				404,
			)
			expect(
				(
					await s.send(
						'POST',
						`/templates/${created.body.id}/apply`,
						{ weekStart: NEXT },
						other,
					)
				).status,
			).toBe(404)
			expect(
				(
					await s.send(
						'DELETE',
						`/templates/${created.body.id}`,
						undefined,
						other,
					)
				).status,
			).toBe(404)
		})
	})

	describe('recommend a schedule', () => {
		async function seedBase() {
			const ana = await s.staff({ firstName: 'Ana' })
			const ben = await s.staff({ firstName: 'Ben' })
			const cy = await s.staff({ firstName: 'Cy' })
			await s.shift({ staffId: ana.staffId, date: '2026-03-02' })
			await s.shift({ staffId: ben.staffId, date: '2026-03-03' })
			await s.shift({ staffId: cy.staffId, date: '2026-03-04' })
			await s.shift({ date: '2026-03-05' })
			return { ana, ben, cy }
		}

		it('proposes without writing, and keeps everyone available where they were', async () => {
			const { ana } = await seedBase()
			const proposal = await s.send('POST', '/recommend', {
				scopeId: LOC_1,
				baseWeekStart: WEEK,
				targetWeekStart: NEXT,
			})
			expect(proposal.status).toBe(200)
			expect(proposal.body).toMatchObject({
				estimate: true,
				applied: false,
				weekStart: NEXT,
				counts: { total: 4, opened: 0, created: 0 },
			})
			expect(proposal.body.shifts[0]).toMatchObject({
				staffId: ana.staffId,
				localDate: '2026-03-09',
			})
			expect(await weekShifts(s, NEXT)).toHaveLength(0)
		})

		it('opens a shift when the person has approved time off, is unavailable, or is gone', async () => {
			const { ana, ben, cy } = await seedBase()
			await s.send('POST', '/time-off', {
				staffId: ana.staffId,
				startDate: '2026-03-09',
				endDate: '2026-03-09',
			})
			await s.send('POST', '/availability', {
				staffId: ben.staffId,
				rows: [
					{
						kind: 'weekly',
						weekday: 2,
						availability: 'unavailable',
						allDay: true,
					},
				],
			})
			const db = await h.db(ORG_A)
			await db
				.update(staffMembers)
				.set({ status: 'terminated' })
				.where(eq(staffMembers.id, cy.staffId))
			const proposal = await s.send('POST', '/recommend', {
				scopeId: LOC_1,
				baseWeekStart: WEEK,
				targetWeekStart: NEXT,
			})
			expect(proposal.body.counts).toMatchObject({ total: 4, opened: 3 })
			const reasons = Object.fromEntries(
				proposal.body.shifts
					.filter((x: any) => x.openReason)
					.map((x: any) => [x.previousStaffId, x.openReason]),
			)
			expect(reasons).toEqual({
				[ana.staffId]: 'time_off',
				[ben.staffId]: 'unavailable',
				[cy.staffId]: 'inactive',
			})
			expect(
				proposal.body.shifts.filter((x: any) => x.staffId === null),
			).toHaveLength(4)
		})

		it('does not let pending requests or overtime take a shift away', async () => {
			await s.setPolicy(LOC_1, {
				weeklyOvertime: { thresholdMinutes: 60, multiplierBp: 15000 },
			})
			const { ana } = await seedBase()
			await s.send('POST', '/time-off', {
				staffId: ana.staffId,
				startDate: '2026-03-09',
				endDate: '2026-03-09',
				submission: 'staff_request',
			})
			const proposal = await s.send('POST', '/recommend', {
				scopeId: LOC_1,
				baseWeekStart: WEEK,
				targetWeekStart: NEXT,
			})
			expect(proposal.body.counts.opened).toBe(0)
		})

		it('opens a shift that would double-book a person already scheduled', async () => {
			const { ana } = await seedBase()
			await s.shift({
				staffId: ana.staffId,
				date: '2026-03-09',
				start: '12:00',
				end: '20:00',
			})
			const proposal = await s.send('POST', '/recommend', {
				scopeId: LOC_1,
				baseWeekStart: WEEK,
				targetWeekStart: NEXT,
			})
			const opened = proposal.body.shifts.find(
				(x: any) => x.previousStaffId === ana.staffId,
			)
			expect(opened).toMatchObject({ staffId: null, openReason: 'overlap' })
		})

		it('applies as drafts, is deterministic, and adds nothing the second time', async () => {
			await seedBase()
			const body = {
				scopeId: LOC_1,
				baseWeekStart: WEEK,
				targetWeekStart: NEXT,
			}
			const first = await s.send('POST', '/recommend', body)
			const second = await s.send('POST', '/recommend', body)
			expect(second.body).toEqual(first.body)
			const applied = await s.send('POST', '/recommend', {
				...body,
				apply: true,
			})
			expect(applied.status).toBe(201)
			expect(applied.body).toMatchObject({
				applied: true,
				counts: { created: 4 },
			})
			expect(
				(await weekShifts(s, NEXT)).every((x) => x.state === 'draft'),
			).toBe(true)
			const again = await s.send('POST', '/recommend', { ...body, apply: true })
			expect(again.body.counts).toMatchObject({
				created: 0,
				skippedDuplicates: 4,
			})
			expect(await weekShifts(s, NEXT)).toHaveLength(4)
		})

		it('limits the base to positions or people', async () => {
			const { ben } = await seedBase()
			const proposal = await s.send('POST', '/recommend', {
				scopeId: LOC_1,
				baseWeekStart: WEEK,
				targetWeekStart: NEXT,
				scope: { mode: 'people', staffIds: [ben.staffId] },
			})
			expect(proposal.body.counts.total).toBe(1)
		})
	})
})
