import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	formatScheduleLinkToken,
	SCHEDULE_LINK_TTL_MS,
	type ManagerAlertEvent,
} from '@repo/staffing'
import {
	scheduleLinks,
	shiftRequests,
	staffAuditLog,
	staffAvailability,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	timeEntries,
	timeEntryEdits,
	timeOffRequests,
	shifts,
} from '@repo/tenant-db'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	ORG_B,
	scheduleFixture,
	type ClockHarness,
	type ScheduleFixture,
} from '../../tests/schedule-harness.ts'
import {
	makeOrg,
	mintStaffToken,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import { resetRateLimits } from '../lib/rate-limit.ts'
import { scheduleLinkDeps } from './schedule-link.ts'
import {
	ensureScheduleLink,
	revokeScheduleLink,
} from '../services/schedule-link-service.ts'
import {
	resetStaffTickTasks,
	resetTickLocks,
	runStaffTickForOrg,
	type TickDeps,
} from '../services/staff-tick-service.ts'

const facts = vi.hoisted(
	() => new Map<string, { name: string; timeZone: string }>(),
)
const orgs = vi.hoisted(() => new Map<string, TestOrg>())
const flags = vi.hoisted(() => ({
	value: null as null | {
		features: {
			enabled: boolean
			timeclock: boolean
			scheduling: boolean
			hiring: boolean
		}
		dataRegion: string | null
	},
}))

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(
		async (_org: string, scope: string) => facts.get(scope) ?? null,
	),
	getStaffingFeatures: vi.fn(async () => flags.value),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const WEEK = '2026-03-02'
const DAY = 24 * 60 * 60 * 1000

const FEATURES_ON = {
	features: { enabled: true, timeclock: true, scheduling: true, hiring: false },
	dataRegion: 'us',
}

describe('my schedule link', () => {
	let h: ClockHarness
	let s: ScheduleFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		flags.value = FEATURES_ON
		resetTickLocks()
		resetStaffTickTasks()
		h = await createClockHarness([ORG_A, ORG_B])
		s = scheduleFixture(h)
		h.setClock(at('2026-03-02', '12:00'))
		scheduleLinkDeps.now = () => h.clock.now
		vi.stubEnv('STAFFING_EMAIL_ENABLED', '')
	})
	afterEach(async () => {
		scheduleLinkDeps.now = () => Date.now()
		await h.cleanup()
	})

	const db = (org = ORG_A) => h.db(org)

	async function person(
		seed: Parameters<ScheduleFixture['staff']>[0] = {},
		patch: Partial<typeof staffMembers.$inferInsert> = {},
	) {
		const made = await s.staff(seed)
		if (Object.keys(patch).length > 0) {
			await (
				await db()
			)
				.update(staffMembers)
				.set(patch)
				.where(eq(staffMembers.id, made.staffId))
		}
		return made
	}

	async function token(staffId: string, org = ORG_A) {
		return (await ensureScheduleLink(await db(org), org, staffId, h.clock.now))
			.token
	}

	async function call(
		method: string,
		path: string,
		options: {
			token?: string | null
			body?: unknown
			headers?: Record<string, string>
		} = {},
	) {
		const headers: Record<string, string> = { ...options.headers }
		if (options.token) headers.Authorization = `Bearer ${options.token}`
		let body: string | undefined
		if (options.body !== undefined) {
			body = JSON.stringify(options.body)
			headers['content-type'] = 'application/json'
		}
		const response = await h.app.request(`/schedule-link${path}`, {
			method,
			headers,
			body,
		})
		const raw = await response.text()
		let parsed: any = null
		try {
			parsed = raw ? JSON.parse(raw) : null
		} catch {
			parsed = null
		}
		return {
			status: response.status,
			body: parsed,
			raw,
			headers: response.headers,
		}
	}

	async function draft(
		staffId: string | null,
		positionId: string | undefined,
		date = WEEK,
		start = '09:00',
		end = '17:00',
		scopeId = LOC_1,
	) {
		return s.shift({ staffId, positionId, date, start, end, scopeId })
	}

	async function publish(scopeId = LOC_1) {
		const response = await s.publish(scopeId, WEEK, { notifyMode: 'nobody' })
		expect(response.status).toBe(200)
	}

	describe('who is let in', () => {
		it('refuses a request with no token, a malformed one or someone else credential', async () => {
			const ana = await person()
			const good = await token(ana.staffId)
			const parts = good.split('.')
			const operator = await mintStaffToken({
				orgId: ORG_A,
				scope: 'schedule',
				grants: ['read:schedule:any'],
			})
			for (const bad of [
				null,
				'',
				'nonsense',
				good.slice(0, -1),
				`${good}x`,
				// A well-formed token with the wrong secret.
				formatScheduleLinkToken(parts[1]!, parts[2]!, 'a'.repeat(64)),
				// A well-formed token for a link that does not exist.
				formatScheduleLinkToken(parts[1]!, 'no-such-link', parts[3]!),
				// A kiosk-looking secret and an operator token are not links.
				`kdv1.${parts[1]}.${parts[2]}.${'a'.repeat(43)}`,
				operator,
			]) {
				const response = await call('GET', '/me', { token: bad })
				expect(response.status, String(bad)).toBe(401)
				expect(response.body).toEqual({ error: 'invalid_link' })
			}
		})

		it('does not accept a link on another organization or from another person', async () => {
			const ana = await person()
			const good = await token(ana.staffId)
			const parts = good.split('.')
			// The same link id and secret under another organization: no such link there.
			const crossed = formatScheduleLinkToken(ORG_B, parts[2]!, parts[3]!)
			expect((await call('GET', '/me', { token: crossed })).status).toBe(401)
			// An unknown organization has no database on this node.
			const unknown = formatScheduleLinkToken('nope_org', parts[2]!, parts[3]!)
			expect((await call('GET', '/me', { token: unknown })).status).toBe(401)
		})

		it('does not let one link read another person, whatever it asks for', async () => {
			const ana = await person()
			const ben = await person()
			await draft(ana.staffId, ana.positionIds[0], WEEK, '09:00', '12:00')
			await draft(ben.staffId, ben.positionIds[0], WEEK, '13:00', '20:00')
			await publish()
			const mine = await call('GET', `/me?from=${WEEK}&to=2026-03-08`, {
				token: await token(ana.staffId),
			})
			expect(mine.status).toBe(200)
			expect(mine.body.shifts).toHaveLength(1)
			expect(mine.raw).not.toContain(ben.staffId)
			expect(mine.raw).not.toContain('Person')
			// A staff id in the query or the path changes nothing.
			const sneaky = await call(
				'GET',
				`/me?staffId=${ben.staffId}&from=${WEEK}&to=2026-03-08`,
				{ token: await token(ana.staffId) },
			)
			expect(sneaky.body.shifts).toHaveLength(1)
			expect(sneaky.body.shifts[0].startsAt).toBe(at(WEEK, '09:00'))
		})

		it('refuses a revoked link, with its own code', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			expect((await call('GET', '/me', { token: t })).status).toBe(200)
			expect(
				(await s.send('POST', `/links/${ana.staffId}/revoke`, {})).status,
			).toBe(200)
			const after = await call('GET', '/me', { token: t })
			expect(after.status).toBe(401)
			expect(after.body.error).toBe('link_revoked')
			// A new link for the same person is a different credential.
			const fresh = await token(ana.staffId)
			expect(fresh).not.toBe(t)
			expect((await call('GET', '/me', { token: fresh })).status).toBe(200)
			expect((await call('GET', '/me', { token: t })).body.error).toBe(
				'link_revoked',
			)
		})

		it('refuses an expired link', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			h.advance(SCHEDULE_LINK_TTL_MS + DAY)
			const response = await call('GET', '/me', { token: t })
			expect(response.status).toBe(401)
			expect(response.body.error).toBe('link_expired')
		})

		it('refuses someone who left, even if their link was never revoked', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			await (
				await db()
			)
				.update(staffMembers)
				.set({ status: 'terminated' })
				.where(eq(staffMembers.id, ana.staffId))
			const response = await call('GET', '/me', { token: t })
			expect(response.status).toBe(401)
			expect(response.body.error).toBe('staff_inactive')
		})

		it('refuses every link while scheduling is off, or when the flags are unknown', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			flags.value = {
				...FEATURES_ON,
				features: { ...FEATURES_ON.features, scheduling: false },
			}
			expect((await call('GET', '/me', { token: t })).status).toBe(403)
			flags.value = {
				...FEATURES_ON,
				features: { ...FEATURES_ON.features, enabled: false },
			}
			expect((await call('GET', '/me', { token: t })).body.error).toBe(
				'schedule_disabled',
			)
			flags.value = null
			expect((await call('GET', '/me', { token: t })).status).toBe(403)
			flags.value = { ...FEATURES_ON, dataRegion: 'ksa' }
			expect((await call('GET', '/me', { token: t })).status).toBe(403)
			flags.value = FEATURES_ON
			expect((await call('GET', '/me', { token: t })).status).toBe(200)
		})

		it('stores only a hash and records use sparingly', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			const secret = t.split('.')[3]!
			const [row] = await (await db()).select().from(scheduleLinks)
			expect(JSON.stringify(row)).not.toContain(secret)
			expect(row!.lastUsedAt).toBeNull()
			await call('GET', '/me', { token: t })
			const [used] = await (await db()).select().from(scheduleLinks)
			expect(used!.lastUsedAt).toBe(h.clock.now)
			h.advance(60_000)
			await call('GET', '/me', { token: t })
			const [again] = await (await db()).select().from(scheduleLinks)
			expect(again!.lastUsedAt).toBe(used!.lastUsedAt)
		})

		it('has one live link per person and keeps a revoked one as history', async () => {
			const ana = await person()
			const first = await token(ana.staffId)
			expect(await token(ana.staffId)).toBe(first)
			await revokeScheduleLink(await db(), ana.staffId, h.clock.now, 'user-1')
			const second = await token(ana.staffId)
			expect(second).not.toBe(first)
			expect(await (await db()).select().from(scheduleLinks)).toHaveLength(2)
		})

		it('limits how fast one link can file requests, and reads stay open', async () => {
			vi.stubEnv('NODE_ENV', 'production')
			resetRateLimits()
			try {
				const ana = await person()
				const t = await token(ana.staffId)
				for (let i = 0; i < 40; i++) {
					expect(
						(await call('POST', '/me/time-off/missing/cancel', { token: t }))
							.status,
					).toBe(404)
				}
				const limited = await call('POST', '/me/time-off/missing/cancel', {
					token: t,
				})
				expect(limited.status).toBe(429)
				expect(limited.body.error).toBe('rate_limit_exceeded')
				expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
				// A different link is not affected, and reading is not a write.
				const ben = await person()
				expect(
					(
						await call('POST', '/me/time-off/missing/cancel', {
							token: await token(ben.staffId),
						})
					).status,
				).toBe(404)
				expect((await call('GET', '/me', { token: t })).status).toBe(200)
			} finally {
				vi.stubEnv('NODE_ENV', 'test')
				resetRateLimits()
			}
		})

		it('only answers GET and POST on the documented paths', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			expect((await call('DELETE', '/me', { token: t })).status).toBe(404)
			expect(
				(await call('PUT', '/me/time-off', { token: t, body: {} })).status,
			).toBe(404)
			expect((await call('GET', '/me/unknown', { token: t })).status).toBe(404)
			expect((await call('POST', '/me', { token: t, body: {} })).status).toBe(
				404,
			)
		})

		it('sends nothing a cache or a referrer could keep', async () => {
			const ana = await person()
			const response = await call('GET', '/me', {
				token: await token(ana.staffId),
			})
			expect(response.headers.get('cache-control')).toMatch(/no-store/)
			expect(response.headers.get('referrer-policy')).toBe('no-referrer')
		})
	})

	describe('the schedule it shows', () => {
		it('shows only published shifts, never drafts, pending edits, cancelled or open shifts', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			const live = await draft(
				ana.staffId,
				ana.positionIds[0],
				WEEK,
				'09:00',
				'17:00',
			)
			const edited = await draft(
				ana.staffId,
				ana.positionIds[0],
				'2026-03-03',
				'10:00',
				'14:00',
			)
			const doomed = await draft(
				ana.staffId,
				ana.positionIds[0],
				'2026-03-04',
				'10:00',
				'14:00',
			)
			await draft(null, undefined, '2026-03-05') // open shift
			await publish()

			// After publishing: a pending edit, a pending removal, and a new draft.
			expect(
				(
					await s.send('PATCH', `/shifts/${edited.id}`, {
						startTime: '12:00',
						endTime: '20:00',
					})
				).status,
			).toBe(200)
			expect((await s.send('DELETE', `/shifts/${doomed.id}`)).status).toBe(200)
			await draft(
				ana.staffId,
				ana.positionIds[0],
				'2026-03-06',
				'09:00',
				'10:00',
			)

			const view = await call('GET', `/me?from=${WEEK}&to=2026-03-08`, {
				token: t,
			})
			expect(view.status).toBe(200)
			const byId = new Map(view.body.shifts.map((x: any) => [x.id, x]))
			expect([...byId.keys()].sort()).toEqual(
				[live.id, edited.id, doomed.id].sort(),
			)
			// The published version, not the pending change.
			expect(byId.get(edited.id)).toMatchObject({
				startsAt: at('2026-03-03', '10:00'),
				endsAt: at('2026-03-03', '14:00'),
			})
			// A shift not yet published reads as if it does not exist.
			const drafts = await (
				await db()
			)
				.select()
				.from(shifts)
				.where(eq(shifts.status, 'draft'))
			expect(drafts).toHaveLength(1)
			expect(byId.has(drafts[0]!.id)).toBe(false)

			// Once the removal is published it disappears.
			h.advance(1000)
			expect(
				(await s.publish(LOC_1, WEEK, { notifyMode: 'nobody' })).status,
			).toBe(200)
			const after = await call('GET', `/me?from=${WEEK}&to=2026-03-08`, {
				token: t,
			})
			expect(after.body.shifts.map((x: any) => x.id)).not.toContain(doomed.id)
			expect(
				after.body.shifts.find((x: any) => x.id === edited.id),
			).toMatchObject({
				startsAt: at('2026-03-03', '12:00'),
			})
		})

		it('shows the place, the zone, the position in both languages, and no pay', async () => {
			const ana = await person(
				{ positions: [{ name: 'Cook', nameAr: 'طباخ', rateMinor: 98765 }] },
				{ firstName: 'Ana', firstNameAr: 'آنا', locale: 'ar' },
			)
			await draft(ana.staffId, ana.positionIds[0])
			await publish()
			const view = await call('GET', `/me?from=${WEEK}&to=2026-03-08`, {
				token: await token(ana.staffId),
			})
			expect(view.body.person).toEqual({
				firstName: 'Ana',
				firstNameAr: 'آنا',
				locale: 'ar',
			})
			expect(view.body.scopes).toEqual([
				{
					id: LOC_1,
					name: 'Downtown',
					timeZone: CHI,
					scheduleVisibility: 'own',
				},
			])
			expect(view.body.shifts[0]).toMatchObject({
				scopeId: LOC_1,
				positionNameAr: 'طباخ',
				timeZone: CHI,
				localDate: WEEK,
			})
			expect(view.raw).not.toMatch(/98765|rate|wage|pay|cost|money/i)
			// No other staff data: no id of the person, no email, no phone.
			expect(view.raw).not.toContain(ana.staffId)
			for (const key of [
				'email',
				'phone',
				'lastName',
				'employeeNumber',
				'userId',
			]) {
				expect(view.raw).not.toContain(key)
			}
		})

		it('defaults to the days around today and refuses an unbounded range', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			const view = await call('GET', '/me', { token: t })
			expect(view.body.from).toBe('2026-03-01')
			expect(view.body.to).toBe('2026-04-06')
			expect(
				(await call('GET', '/me?from=2026-01-01&to=2026-12-31', { token: t }))
					.status,
			).toBe(422)
			expect(
				(await call('GET', '/me?from=2026-03-09&to=2026-03-02', { token: t }))
					.status,
			).toBe(400)
			expect((await call('GET', '/me?from=nope', { token: t })).status).toBe(
				400,
			)
		})

		it('keeps a shift at a scope the person no longer works at visible, and names it', async () => {
			const ana = await person({ scopeIds: [LOC_1, LOC_2] })
			await draft(
				ana.staffId,
				ana.positionIds[0],
				WEEK,
				'09:00',
				'12:00',
				LOC_2,
			)
			await publish(LOC_2)
			await (
				await db()
			)
				.update(staffScopeAssignments)
				.set({ active: false })
				.where(
					and(
						eq(staffScopeAssignments.staffId, ana.staffId),
						eq(staffScopeAssignments.scopeId, LOC_2),
					),
				)
			const view = await call('GET', `/me?from=${WEEK}&to=2026-03-08`, {
				token: await token(ana.staffId),
			})
			expect(view.body.shifts).toHaveLength(1)
			expect(view.body.scopes.map((l: any) => l.id).sort()).toEqual([
				LOC_1,
				LOC_2,
			])
		})
	})

	describe('time cards and their edit history', () => {
		async function card(
			staffId: string,
			date: string,
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
					clockOutAt: clockIn + 8 * 3_600_000,
					timeZone: CHI,
					localDate: date,
					status: 'closed',
					rateMinor: 4321,
					currency: 'USD',
					cashTipsMinor: 777,
					managerNote: 'internal: late twice',
					...patch,
				})
				.returning()
			return row!
		}

		it('lists only the persons own cards, with edit history and no money or manager notes', async () => {
			const ana = await person()
			const ben = await person()
			const mine = await card(ana.staffId, '2026-03-02')
			await card(ben.staffId, '2026-03-02', {
				managerNote: 'ben private',
			})
			await (await db()).insert(timeEntryEdits).values({
				entryId: mine.id,
				staffId: ana.staffId,
				scopeId: LOC_1,
				editorId: 'manager-user-77',
				via: 'manager',
				action: 'update',
				reason: 'Forgot to clock out',
				before: {
					clockInAt: mine.clockInAt,
					clockOutAt: null,
					rateMinor: 4321,
					cashTipsMinor: 777,
					managerNote: 'internal: late twice',
				},
				after: {
					clockInAt: mine.clockInAt,
					clockOutAt: mine.clockOutAt,
					rateMinor: 4321,
				},
				hoursDeltaMinutes: -30,
			})
			const view = await call('GET', '/me/time-cards', {
				token: await token(ana.staffId),
			})
			expect(view.status).toBe(200)
			expect(view.body.cards).toHaveLength(1)
			expect(view.body.cards[0]).toMatchObject({
				id: mine.id,
				localDate: '2026-03-02',
				status: 'closed',
				paidMinutes: 480,
				edited: true,
			})
			expect(view.body.cards[0].edits).toEqual([
				expect.objectContaining({
					action: 'update',
					reason: 'Forgot to clock out',
					hoursDeltaMinutes: -30,
					before: { clockInAt: mine.clockInAt, clockOutAt: null },
					after: { clockInAt: mine.clockInAt, clockOutAt: mine.clockOutAt },
				}),
			])
			for (const leak of [
				'4321',
				'777',
				'internal',
				'manager-user-77',
				'ben private',
				'rateMinor',
				'tips',
				'currency',
				'editorId',
			]) {
				expect(view.raw).not.toContain(leak)
			}
		})

		it('hides the managers review state and shows approval and lock', async () => {
			const ana = await person()
			await card(ana.staffId, '2026-03-02', {
				status: 'needs_review',
				clockOutAt: null,
			})
			await card(ana.staffId, '2026-02-27', { status: 'approved' })
			await card(ana.staffId, '2026-02-26', { status: 'locked' })
			const view = await call('GET', '/me/time-cards', {
				token: await token(ana.staffId),
			})
			const statuses = view.body.cards.map(
				(c: any) => `${c.localDate}:${c.status}`,
			)
			expect(statuses).toEqual([
				'2026-03-02:open',
				'2026-02-27:approved',
				'2026-02-26:locked',
			])
			expect(view.raw).not.toContain('needs_review')
		})

		it('does not include a voided card, and bounds the range', async () => {
			const ana = await person()
			await card(ana.staffId, '2026-03-02', { voidedAt: h.clock.now })
			const t = await token(ana.staffId)
			expect(
				(await call('GET', '/me/time-cards', { token: t })).body.cards,
			).toEqual([])
			expect(
				(
					await call('GET', '/me/time-cards?from=2025-01-01&to=2026-03-02', {
						token: t,
					})
				).status,
			).toBe(422)
		})
	})

	describe('requests', () => {
		it('records time off as the persons own request, waiting for a manager', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			const created = await call('POST', '/me/time-off', {
				token: t,
				body: {
					category: 'sick',
					startDate: '2026-03-10',
					endDate: '2026-03-11',
					note: 'Flu',
					// A hostile body cannot approve itself or name someone else.
					submission: 'manager_entered',
					staffId: 'someone-else',
				},
			})
			expect(created.status).toBe(201)
			expect(created.body).toMatchObject({
				category: 'sick',
				startDate: '2026-03-10',
				status: 'pending',
				note: 'Flu',
			})
			const [row] = await (await db()).select().from(timeOffRequests)
			expect(row).toMatchObject({
				staffId: ana.staffId,
				status: 'pending',
				source: 'staff',
				requestedBy: `staff:${ana.staffId}`,
				decidedBy: null,
			})
			// The manager sees it, as the person's own, in their queue.
			const queue = await s.get('/time-off?status=pending')
			expect(queue.body).toHaveLength(1)
			expect(queue.body[0]).toMatchObject({
				source: 'staff',
				staffId: ana.staffId,
			})
			// It does not yet affect anything: only approved time off is a conflict.
			const listed = await call('GET', '/me/requests', { token: t })
			expect(listed.body.timeOff).toHaveLength(1)
		})

		it('audits the person as the actor', async () => {
			const ana = await person()
			await call('POST', '/me/time-off', {
				token: await token(ana.staffId),
				body: { startDate: '2026-03-10', endDate: '2026-03-10' },
			})
			const rows = await (
				await db()
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'schedule.time_off.created'))
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				actorKind: 'staff_link',
				actorId: `staff:${ana.staffId}`,
				staffId: ana.staffId,
				impersonated: false,
			})
		})

		it('validates what it is given', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			for (const body of [
				{},
				{ startDate: '2026-03-12', endDate: '2026-03-10' },
				{ startDate: '2026-02-30', endDate: '2026-03-01' },
				{ startDate: '2026-03-10', endDate: '2026-03-10', allDay: false },
				{ startDate: '2026-03-10', endDate: '2026-03-10', extra: 1 },
				{
					startDate: '2026-03-10',
					endDate: '2026-03-10',
					note: 'x'.repeat(600),
				},
				'text',
				null,
				[],
			]) {
				expect(
					(await call('POST', '/me/time-off', { token: t, body })).status,
				).toBe(400)
			}
			const noBody = await h.app.request('/schedule-link/me/time-off', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${t}`,
					'content-type': 'application/json',
				},
				body: '{not json',
			})
			expect(noBody.status).toBe(400)
			expect(await (await db()).select().from(timeOffRequests)).toEqual([])
		})

		it('cancels only its own pending time off', async () => {
			const ana = await person()
			const ben = await person()
			const ta = await token(ana.staffId)
			const tb = await token(ben.staffId)
			const mine = await call('POST', '/me/time-off', {
				token: ta,
				body: { startDate: '2026-03-10', endDate: '2026-03-10' },
			})
			// Ben cannot touch Ana's request: it reads as missing.
			expect(
				(
					await call('POST', `/me/time-off/${mine.body.id}/cancel`, {
						token: tb,
					})
				).status,
			).toBe(404)
			expect(
				(
					await call('POST', `/me/time-off/${mine.body.id}/cancel`, {
						token: ta,
					})
				).status,
			).toBe(200)
			expect(
				(
					await call('POST', `/me/time-off/${mine.body.id}/cancel`, {
						token: ta,
					})
				).status,
			).toBe(409)
			// Once a manager decides, taking it back is theirs to do.
			const second = await call('POST', '/me/time-off', {
				token: ta,
				body: { startDate: '2026-03-12', endDate: '2026-03-12' },
			})
			await s.send('POST', `/time-off/${second.body.id}/decision`, {
				decision: 'approve',
			})
			const refused = await call(
				'POST',
				`/me/time-off/${second.body.id}/cancel`,
				{ token: ta },
			)
			expect(refused.status).toBe(409)
			expect(refused.body.error).toBe('already_decided')
			expect(
				(await call('POST', '/me/time-off/nope%20id/cancel', { token: ta }))
					.status,
			).toBe(404)
		})

		it('records availability as a request, never final', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			const created = await call('POST', '/me/availability', {
				token: t,
				body: {
					submission: 'manager_entered',
					replaceWeekly: true,
					rows: [
						{ kind: 'weekly', weekday: 1, availability: 'unavailable' },
						{
							kind: 'weekly',
							weekday: 2,
							availability: 'available',
							allDay: false,
							startTime: '09:00',
							endTime: '15:00',
						},
					],
				},
			})
			expect(created.status).toBe(201)
			expect(created.body).toHaveLength(2)
			expect(created.body.every((r: any) => r.status === 'pending')).toBe(true)
			const rows = await (await db()).select().from(staffAvailability)
			expect(
				rows.every((r) => r.source === 'staff' && r.decidedBy === null),
			).toBe(true)
			const cancelled = await call(
				'POST',
				`/me/availability/${created.body[0].id}/cancel`,
				{
					token: t,
				},
			)
			expect(cancelled.status).toBe(200)
			expect(cancelled.body.status).toBe('cancelled')
			expect(
				(
					await call('POST', '/me/availability', {
						token: t,
						body: { rows: [] },
					})
				).status,
			).toBe(400)
		})

		it('caps open requests so a leaked link cannot flood the queue', async () => {
			const ana = await person()
			const t = await token(ana.staffId)
			for (let i = 0; i < 10; i++) {
				const date = `2026-04-${String(i + 1).padStart(2, '0')}`
				expect(
					(
						await call('POST', '/me/time-off', {
							token: t,
							body: { startDate: date, endDate: date },
						})
					).status,
				).toBe(201)
			}
			const eleventh = await call('POST', '/me/time-off', {
				token: t,
				body: { startDate: '2026-04-20', endDate: '2026-04-20' },
			})
			expect(eleventh.status).toBe(409)
			expect(eleventh.body.error).toBe('too_many_pending')
		})

		it('does not let someone with no scope assignment file a request', async () => {
			const ana = await person({ scopeIds: [LOC_1] })
			await (
				await db()
			)
				.update(staffScopeAssignments)
				.set({ active: false })
				.where(eq(staffScopeAssignments.staffId, ana.staffId))
			const response = await call('POST', '/me/time-off', {
				token: await token(ana.staffId),
				body: { startDate: '2026-03-10', endDate: '2026-03-10' },
			})
			expect(response.status).toBe(422)
		})
	})

	describe('swap, cover and drop', () => {
		async function twoCooks() {
			const ana = await person()
			const ben = await person()
			const mine = await draft(
				ana.staffId,
				ana.positionIds[0],
				'2026-03-04',
				'09:00',
				'17:00',
			)
			const his = await draft(
				ben.staffId,
				ben.positionIds[0],
				'2026-03-05',
				'10:00',
				'18:00',
			)
			await publish()
			return {
				ana,
				ben,
				mine,
				his,
				ta: await token(ana.staffId),
				tb: await token(ben.staffId),
			}
		}

		it('files a drop for its own upcoming shift, and the manager sees it as the persons', async () => {
			const { ana, mine, ta } = await twoCooks()
			const response = await call('POST', '/me/shift-requests', {
				token: ta,
				body: { kind: 'drop', shiftId: mine.id, note: 'Appointment' },
			})
			expect(response.status).toBe(201)
			expect(response.body).toMatchObject({
				kind: 'drop',
				shiftId: mine.id,
				status: 'pending',
				note: 'Appointment',
				targetName: null,
			})
			const queue = await s.get('/requests?status=pending')
			expect(queue.body).toHaveLength(1)
			expect(queue.body[0]).toMatchObject({
				source: 'staff',
				requesterStaffId: ana.staffId,
				kind: 'drop',
			})
			// Nothing about the schedule changed.
			const [row] = await (
				await db()
			)
				.select()
				.from(shifts)
				.where(eq(shifts.id, mine.id))
			expect(row).toMatchObject({
				staffId: ana.staffId,
				status: 'published',
				draftPatch: null,
			})
		})

		it("refuses another person's shift, an unpublished one and one that has started", async () => {
			const { ana, his, ta } = await twoCooks()
			expect(
				(
					await call('POST', '/me/shift-requests', {
						token: ta,
						body: { kind: 'drop', shiftId: his.id },
					})
				).status,
			).toBe(404)
			const later = await draft(
				ana.staffId,
				ana.positionIds[0],
				'2026-03-06',
				'09:00',
				'10:00',
			)
			expect(
				(
					await call('POST', '/me/shift-requests', {
						token: ta,
						body: { kind: 'drop', shiftId: later.id },
					})
				).body.error,
			).toBe('not_published')
			h.setClock(at('2026-03-04', '09:30'))
			const { mine } = {
				mine: (
					await (
						await db()
					)
						.select()
						.from(shifts)
						.where(eq(shifts.localDate, '2026-03-04'))
				)[0]!,
			}
			const started = await call('POST', '/me/shift-requests', {
				token: ta,
				body: { kind: 'drop', shiftId: mine.id },
			})
			expect(started.status).toBe(409)
			expect(started.body.error).toBe('shift_started')
			expect(
				(
					await call('POST', '/me/shift-requests', {
						token: ta,
						body: { kind: 'drop', shiftId: 'nope' },
					})
				).status,
			).toBe(404)
		})

		it('cannot be used to name someone else as the requester or approve itself', async () => {
			const { ben, mine, ta } = await twoCooks()
			const response = await call('POST', '/me/shift-requests', {
				token: ta,
				body: {
					kind: 'drop',
					shiftId: mine.id,
					requesterStaffId: ben.staffId,
					submission: 'manager_entered',
				},
			})
			expect(response.status).toBe(201)
			const [row] = await (await db()).select().from(shiftRequests)
			expect(row).toMatchObject({ status: 'pending', source: 'staff' })
			expect(row!.requesterStaffId).not.toBe(ben.staffId)
		})

		it('lists teammates by first name and last initial only', async () => {
			const { ben, mine, ta } = await twoCooks()
			await (
				await db()
			)
				.update(staffMembers)
				.set({
					firstName: 'Benedict',
					lastName: 'Okafor',
					email: 'ben@example.com',
					phone: '+15555550100',
				})
				.where(eq(staffMembers.id, ben.staffId))
			await person({ scopeIds: [LOC_2] }) // someone elsewhere
			const view = await call('GET', `/me/teammates?shiftId=${mine.id}`, {
				token: ta,
			})
			expect(view.status).toBe(200)
			expect(view.body.teammates).toEqual([
				{ id: ben.staffId, name: 'Benedict O.' },
			])
			expect(view.body.canSwap).toBe(false)
			expect(view.body.swapCandidates).toEqual([])
			for (const leak of [
				'Okafor',
				'ben@example.com',
				'555',
				'email',
				'phone',
			]) {
				expect(view.raw).not.toContain(leak)
			}
			// Someone else's shift reads as missing.
			expect(
				(
					await call('GET', `/me/teammates?shiftId=${mine.id}`, {
						token: await token(ben.staffId),
					})
				).status,
			).toBe(404)
			expect((await call('GET', '/me/teammates', { token: ta })).status).toBe(
				400,
			)
		})

		it('files a cover for a colleague at the same scope only', async () => {
			const { ana, ben, mine, ta } = await twoCooks()
			const elsewhere = await person({ scopeIds: [LOC_2] })
			expect(
				(
					await call('POST', '/me/shift-requests', {
						token: ta,
						body: {
							kind: 'cover',
							shiftId: mine.id,
							targetStaffId: elsewhere.staffId,
						},
					})
				).status,
			).toBe(422)
			expect(
				(
					await call('POST', '/me/shift-requests', {
						token: ta,
						body: {
							kind: 'cover',
							shiftId: mine.id,
							targetStaffId: ana.staffId,
						},
					})
				).status,
			).toBe(422)
			const ok = await call('POST', '/me/shift-requests', {
				token: ta,
				body: { kind: 'cover', shiftId: mine.id, targetStaffId: ben.staffId },
			})
			expect(ok.status).toBe(201)
			expect(ok.body).toMatchObject({ kind: 'cover', status: 'pending' })
			expect(ok.body.targetName).toMatch(/^Staff\d+ P\.$/)
			// A request already pending for the shift blocks a second one.
			expect(
				(
					await call('POST', '/me/shift-requests', {
						token: ta,
						body: { kind: 'drop', shiftId: mine.id },
					})
				).status,
			).toBe(409)
		})

		it('lets a swap through only where the scope lets the team see the schedule', async () => {
			const { ben, mine, his, ta } = await twoCooks()
			const body = {
				kind: 'swap',
				shiftId: mine.id,
				targetStaffId: ben.staffId,
				targetShiftId: his.id,
			}
			const blocked = await call('POST', '/me/shift-requests', {
				token: ta,
				body,
			})
			expect(blocked.status).toBe(403)
			expect(blocked.body.error).toBe('swap_not_allowed')

			await s.setPolicy(LOC_1, { scheduleVisibility: 'team' })
			const view = await call('GET', `/me/teammates?shiftId=${mine.id}`, {
				token: ta,
			})
			expect(view.body.canSwap).toBe(true)
			expect(view.body.swapCandidates).toEqual([
				expect.objectContaining({
					id: his.id,
					staffId: ben.staffId,
					startsAt: at('2026-03-05', '10:00'),
				}),
			])
			const allowed = await call('POST', '/me/shift-requests', {
				token: ta,
				body,
			})
			expect(allowed.status).toBe(201)
			expect(allowed.body.kind).toBe('swap')
			const pending = await s.get('/requests?status=pending')
			expect(pending.body[0]).toMatchObject({
				kind: 'swap',
				targetShiftId: his.id,
			})
		})

		it('cancels only its own pending request', async () => {
			const { mine, ta, tb } = await twoCooks()
			const made = await call('POST', '/me/shift-requests', {
				token: ta,
				body: { kind: 'drop', shiftId: mine.id },
			})
			expect(
				(
					await call('POST', `/me/shift-requests/${made.body.id}/cancel`, {
						token: tb,
					})
				).status,
			).toBe(404)
			const cancelled = await call(
				'POST',
				`/me/shift-requests/${made.body.id}/cancel`,
				{ token: ta },
			)
			expect(cancelled.status).toBe(200)
			expect(cancelled.body.status).toBe('cancelled')
			expect(
				(
					await call('POST', `/me/shift-requests/${made.body.id}/cancel`, {
						token: ta,
					})
				).status,
			).toBe(409)
		})
	})

	describe('from the email to the page', () => {
		it('opens the persons own schedule with the link in the publish email, and not another persons', async () => {
			const sent: Array<{ to: string; text: string }> = []
			const alerts: ManagerAlertEvent[] = []
			const deps: Partial<TickDeps> = {
				now: () => h.clock.now,
				getFeatures: async () => FEATURES_ON,
				getScope: async (_org, scope) => facts.get(scope) ?? null,
				listShifts: async () => [],
				sendEmail: async (input) => {
					sent.push({ to: input.to, text: input.text })
					return { status: 'success' }
				},
				notifyManagers: async (event) => {
					alerts.push(event)
					return { status: 'delivered', result: { inApp: 0, emailed: 0 } }
				},
				emailEnabled: () => true,
			}
			const ana = await person()
			const ben = await person()
			await (
				await db()
			)
				.update(staffMembers)
				.set({ email: 'ana@example.com' })
				.where(eq(staffMembers.id, ana.staffId))
			await (
				await db()
			)
				.update(staffMembers)
				.set({ email: 'ben@example.com' })
				.where(eq(staffMembers.id, ben.staffId))
			await draft(ana.staffId, ana.positionIds[0], WEEK, '09:00', '12:00')
			await draft(ben.staffId, ben.positionIds[0], WEEK, '13:00', '20:00')
			await s.publish(LOC_1, WEEK, { notifyMode: 'everyone' })
			await runStaffTickForOrg(ORG_A, { db: await db(), deps })

			const tokenOf = (to: string) => {
				const mail = sent.find((m) => m.to === to)!
				const url = /(https:\/\/app\.test\/my-schedule#[^\s]+)/.exec(
					mail.text,
				)![1]!
				const fragment = new URLSearchParams(new URL(url).hash.slice(1))
				expect(fragment.get('r')).toBe('us')
				return fragment.get('t')!
			}
			const view = await call('GET', `/me?from=${WEEK}&to=2026-03-08`, {
				token: tokenOf('ana@example.com'),
			})
			expect(view.status).toBe(200)
			expect(view.body.shifts).toHaveLength(1)
			expect(view.body.shifts[0].startsAt).toBe(at(WEEK, '09:00'))
			expect(tokenOf('ana@example.com')).not.toBe(tokenOf('ben@example.com'))
		})
	})

	describe('kiosk next shifts', () => {
		async function identify(secret: string, pin: string) {
			return h.kiosk('POST', '/identify', { secret, body: { pin } })
		}

		it('shows the next published shifts of the person who just entered their PIN, only on a tablet that opted in', async () => {
			const ana = await h.seedStaff(ORG_A, { positions: [{ name: 'Cook' }] })
			const ben = await h.seedStaff(ORG_A, { positions: [{ name: 'Cook' }] })
			const posA = (await (await db()).select().from(staffJobs)).find(
				(j) => j.staffId === ana.staffId,
			)!.positionId
			const posB = (await (await db()).select().from(staffJobs)).find(
				(j) => j.staffId === ben.staffId,
			)!.positionId
			for (const date of [
				'2026-03-03',
				'2026-03-04',
				'2026-03-05',
				'2026-03-06',
			]) {
				await draft(ana.staffId, posA, date, '09:00', '12:00')
			}
			await draft(ben.staffId, posB, '2026-03-03', '14:00', '22:00')
			await publish()

			const off = await h.pair(ORG_A, LOC_1)
			const before = await identify(off.secret, ana.pin)
			expect(before.status).toBe(200)
			expect(before.body.nextShifts).toEqual([])

			const on = await h.pair(ORG_A, LOC_1)
			expect(
				(
					await h.operator('PATCH', `/kiosk/devices/${on.deviceId}`, {
						body: { showNextShifts: true },
					})
				).status,
			).toBe(200)
			const shown = await identify(on.secret, ana.pin)
			expect(shown.body.nextShifts).toEqual([
				{
					startAt: at('2026-03-03', '09:00'),
					endAt: at('2026-03-03', '12:00'),
				},
				{
					startAt: at('2026-03-04', '09:00'),
					endAt: at('2026-03-04', '12:00'),
				},
				{
					startAt: at('2026-03-05', '09:00'),
					endAt: at('2026-03-05', '12:00'),
				},
			])
			// Ben sees his own, never Ana's.
			const his = await identify(on.secret, ben.pin)
			expect(his.body.nextShifts).toEqual([
				{
					startAt: at('2026-03-03', '14:00'),
					endAt: at('2026-03-03', '22:00'),
				},
			])
			// Times only: nothing else about the shifts or the people.
			expect(Object.keys(shown.body.nextShifts[0]).sort()).toEqual([
				'endAt',
				'startAt',
			])
		})

		it('shows nothing while scheduling is off, for unpublished shifts, or from another scope', async () => {
			const ana = await h.seedStaff(ORG_A, {
				positions: [{ name: 'Cook' }],
				scopeIds: [LOC_1, LOC_2],
			})
			const jobs = await (await db()).select().from(staffJobs)
			const pos = jobs.find((j) => j.staffId === ana.staffId)!.positionId
			await draft(ana.staffId, pos, '2026-03-03', '09:00', '12:00', LOC_2)
			await publish(LOC_2)
			await draft(ana.staffId, pos, '2026-03-04', '09:00', '12:00', LOC_1) // draft only
			const on = await h.pair(ORG_A, LOC_1)
			await h.operator('PATCH', `/kiosk/devices/${on.deviceId}`, {
				body: { showNextShifts: true },
			})
			expect((await identify(on.secret, ana.pin)).body.nextShifts).toEqual([])
			await publish(LOC_1)
			expect((await identify(on.secret, ana.pin)).body.nextShifts).toHaveLength(
				1,
			)
			flags.value = {
				...FEATURES_ON,
				features: { ...FEATURES_ON.features, scheduling: false },
			}
			expect((await identify(on.secret, ana.pin)).body.nextShifts).toEqual([])
			flags.value = null
			expect((await identify(on.secret, ana.pin)).body.nextShifts).toEqual([])
		})
	})
})
