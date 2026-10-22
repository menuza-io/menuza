import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	managerOutboxKind,
	scheduleNoticePrefix,
	type ManagerAlertEvent,
} from '@repo/staffing'
import {
	notificationOutbox,
	scheduleLinks,
	schedulePublications,
	staffAuditLog,
	staffMembers,
	staffingSettings,
} from '@repo/tenant-db'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	SCH_EDIT,
	SCH_VIEW,
	scheduleFixture,
	type ClockHarness,
	type ScheduleFixture,
} from '../../tests/schedule-harness.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
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
const MIN = 60_000

type Sent = { to: string; subject: string; html: string; text: string }

describe('publishing tells people', () => {
	let h: ClockHarness
	let s: ScheduleFixture
	const sent: Sent[] = []
	const alerts: ManagerAlertEvent[] = []
	let emailOn = true
	let deps: Partial<TickDeps>

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		sent.length = 0
		alerts.length = 0
		emailOn = true
		resetTickLocks()
		resetStaffTickTasks()
		h = await createClockHarness([ORG_A])
		s = scheduleFixture(h)
		h.setClock(at('2026-03-02', '12:00'))
		vi.stubEnv('STAFFING_EMAIL_ENABLED', '')
		deps = {
			now: () => h.clock.now,
			getFeatures: async () => ({
				features: {
					enabled: true,
					timeclock: true,
					scheduling: true,
					hiring: false,
				},
				dataRegion: 'us',
			}),
			getScope: async (_org, scope) => facts.get(scope) ?? null,
			listShifts: async () => [],
			sendEmail: async (input) => {
				sent.push(input)
				return { status: 'success' }
			},
			notifyManagers: async (event) => {
				alerts.push(event)
				return { status: 'delivered', result: { inApp: 1, emailed: 0 } }
			},
			emailEnabled: () => emailOn,
		}
	})
	afterEach(async () => {
		await h.cleanup()
	})

	async function db() {
		return h.db(ORG_A)
	}

	async function person(
		email: string | null,
		overrides: Partial<typeof staffMembers.$inferInsert> = {},
		seed: Parameters<ScheduleFixture['staff']>[0] = {},
	) {
		const made = await s.staff(seed)
		await (
			await db()
		)
			.update(staffMembers)
			.set({ email, ...overrides })
			.where(eq(staffMembers.id, made.staffId))
		return made
	}

	async function outbox() {
		return (await db()).select().from(notificationOutbox)
	}

	async function tick() {
		return runStaffTickForOrg(ORG_A, { db: await db(), deps })
	}

	async function schedule(
		staffId: string,
		positionId: string | undefined,
		date = WEEK,
		start = '09:00',
		end = '17:00',
	) {
		return s.shift({ staffId, positionId, date, start, end })
	}

	it('queues a message for each person whose shifts changed, and only them', async () => {
		const ana = await person('ana@example.com')
		const ben = await person('ben@example.com')
		await schedule(ana.staffId, ana.positionIds[0])
		await schedule(ben.staffId, ben.positionIds[0], '2026-03-03')
		expect(
			(await s.publish(LOC_1, WEEK, { notifyMode: 'everyone' })).status,
		).toBe(200)
		await db().then((d) => d.delete(notificationOutbox))

		// Only Ana's shift changes.
		const shift = await schedule(ana.staffId, ana.positionIds[0], '2026-03-04')
		expect(shift.id).toBeTruthy()
		const published = await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
		expect(published.status).toBe(200)
		expect(published.body.publication.notification).toMatchObject({
			mode: 'changed',
			recipients: 1,
			queued: 1,
			notReached: [],
		})
		const rows = (await outbox()).filter((r) => r.kind === 'schedule_published')
		expect(rows.map((r) => r.staffId)).toEqual([ana.staffId])
	})

	it('queues everyone who works that week in everyone mode', async () => {
		const ana = await person('ana@example.com')
		const ben = await person('ben@example.com')
		await person('cy@example.com') // not scheduled: nobody tells them
		await schedule(ana.staffId, ana.positionIds[0])
		await schedule(ben.staffId, ben.positionIds[0], '2026-03-03')
		const published = await s.publish(LOC_1, WEEK, { notifyMode: 'everyone' })
		expect(published.body.publication.notification).toMatchObject({
			mode: 'everyone',
			recipients: 2,
			queued: 2,
		})
		const rows = (await outbox()).filter((r) => r.kind === 'schedule_published')
		expect(rows.map((r) => r.staffId).sort()).toEqual(
			[ana.staffId, ben.staffId].sort(),
		)
	})

	it('queues nothing in nobody mode, and tells managers nothing either', async () => {
		const ana = await person('ana@example.com')
		await schedule(ana.staffId, ana.positionIds[0])
		const published = await s.publish(LOC_1, WEEK, { notifyMode: 'nobody' })
		expect(published.status).toBe(200)
		expect(published.body.publication.notification).toEqual({
			mode: 'nobody',
			recipients: 0,
			queued: 0,
			notReached: [],
		})
		expect(await outbox()).toEqual([])
	})

	it('carries ids and counts only in the queued message and the manager event', async () => {
		const ana = await person('ana@example.com', {
			firstName: 'Anastasia',
			lastName: 'Zhivago',
		})
		await schedule(ana.staffId, ana.positionIds[0])
		await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
		const rows = await outbox()
		const blob = JSON.stringify(rows.map((r) => r.payload))
		for (const leak of [
			'Anastasia',
			'Zhivago',
			'ana@example.com',
			'09:00',
			'Cook',
		]) {
			expect(blob).not.toContain(leak)
		}
		expect(blob).not.toMatch(/\d{13}/) // no epoch times either
		const manager = rows.find(
			(r) => r.kind === managerOutboxKind('schedule_published'),
		)
		expect(manager).toMatchObject({
			scopeId: LOC_1,
			staffId: 'system',
			payload: { publishedBy: expect.any(String) },
		})
	})

	it('records who cannot be reached and why, with the publication', async () => {
		const ana = await person('ana@example.com')
		const noMail = await person(null)
		await schedule(ana.staffId, ana.positionIds[0])
		await schedule(noMail.staffId, noMail.positionIds[0], '2026-03-03')
		const published = await s.publish(LOC_1, WEEK, { notifyMode: 'everyone' })
		expect(published.body.publication.notification).toEqual({
			mode: 'everyone',
			recipients: 2,
			queued: 1,
			notReached: [{ staffId: noMail.staffId, reason: 'no_email' }],
		})
		const [row] = await (await db()).select().from(schedulePublications)
		expect(row!.notification).toEqual(published.body.publication.notification)
	})

	it('notes email as off when the switch is off and queues nothing for staff', async () => {
		vi.stubEnv('STAFFING_EMAIL_ENABLED', 'false')
		const ana = await person('ana@example.com')
		await schedule(ana.staffId, ana.positionIds[0])
		const published = await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
		expect(published.body.publication.notification).toMatchObject({
			queued: 0,
			notReached: [{ staffId: ana.staffId, reason: 'email_disabled' }],
		})
		expect(
			(await outbox()).filter((r) => r.kind === 'schedule_published'),
		).toEqual([])
	})

	it('tells a person who lost a shift to someone else, and names the new holder to nobody', async () => {
		const ana = await person('ana@example.com')
		const ben = await person('ben@example.com')
		const shift = await schedule(ana.staffId, ana.positionIds[0])
		await s.publish(LOC_1, WEEK, { notifyMode: 'nobody' })
		const reassign = await s.send('POST', `/shifts/${shift.id}/assign`, {
			staffId: ben.staffId,
		})
		expect(reassign.status).toBe(200)
		await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
		const rows = (await outbox()).filter((r) => r.kind === 'schedule_published')
		expect(rows.map((r) => r.staffId).sort()).toEqual(
			[ana.staffId, ben.staffId].sort(),
		)
		const anaRow = rows.find((r) => r.staffId === ana.staffId)!
		expect(anaRow.payload).toMatchObject({
			changedShiftIds: [],
			removedShiftIds: [shift.id],
		})
	})

	describe('delivery', () => {
		it('emails the person their own shifts and a link, built from the live schedule', async () => {
			const ana = await person('ana@example.com', { firstName: 'Ana' })
			const ben = await person('ben@example.com', { firstName: 'Benedict' })
			await schedule(ana.staffId, ana.positionIds[0], WEEK, '09:00', '17:00')
			await schedule(
				ben.staffId,
				ben.positionIds[0],
				'2026-03-03',
				'18:30',
				'22:15',
			)
			await s.publish(LOC_1, WEEK, { notifyMode: 'everyone' })
			const result = await tick()
			expect(result.staffEmail.sent).toBe(2)
			const toAna = sent.find((m) => m.to === 'ana@example.com')!
			const toBen = sent.find((m) => m.to === 'ben@example.com')!
			expect(toAna.subject).toBe('Your schedule is ready')
			expect(toAna.text).toContain('Hi Ana,')
			expect(toAna.text).toContain('Downtown')
			expect(toAna.text).toMatch(/9:00\sAM - 5:00\sPM/)
			expect(toAna.text).toContain('https://app.test/my-schedule#r=us&t=slk1.')

			// Own shifts only: nothing of the other person.
			const anaAll = `${toAna.subject}\n${toAna.text}\n${toAna.html}`
			expect(anaAll).not.toContain('Benedict')
			expect(anaAll).not.toMatch(/6:30\sPM|10:15\sPM/)
			expect(anaAll).not.toContain('ben@example.com')
			const benAll = `${toBen.subject}\n${toBen.text}\n${toBen.html}`
			expect(benAll).not.toContain('Ana,')
			expect(benAll).not.toMatch(/9:00\sAM/)
			expect(toBen.text).toMatch(/6:30\sPM - 10:15\sPM/)
		})

		it('never carries pay', async () => {
			const ana = await person(
				'ana@example.com',
				{},
				{
					positions: [{ name: 'Cook', rateMinor: 98765 }],
				},
			)
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await tick()
			const mail = sent[0]!
			// The schedule link's random token can hold any digits: leave it out.
			const all = `${mail.subject}${mail.text}${mail.html}`.replace(
				/slk1\.[^\s"&<]*/g,
				'',
			)
			expect(all).not.toMatch(/987|\$|USD|SAR|rate|wage/i)
		})

		it('is generic at the minimal contact level: no place, time or position', async () => {
			await (
				await db()
			)
				.insert(staffingSettings)
				.values({ contactLevel: 'minimal' })
			const ana = await person('ana@example.com', { firstName: 'Ana' })
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await tick()
			const mail = sent[0]!
			const all = `${mail.subject}\n${mail.text}\n${mail.html}`
			for (const leak of [
				'Ana',
				'Downtown',
				'Cook',
				'AM',
				'PM',
				'2026',
				'9:00',
			]) {
				expect(all).not.toContain(leak)
			}
			// It still opens their own schedule.
			expect(mail.text).toContain('/my-schedule#r=us&t=slk1.')
		})

		it('marks changed shifts and lists a shift that moved away', async () => {
			const ana = await person('ana@example.com')
			const ben = await person('ben@example.com')
			const shift = await schedule(
				ana.staffId,
				ana.positionIds[0],
				WEEK,
				'09:00',
				'17:00',
			)
			await schedule(
				ana.staffId,
				ana.positionIds[0],
				'2026-03-03',
				'10:00',
				'14:00',
			)
			await s.publish(LOC_1, WEEK, { notifyMode: 'nobody' })
			await s.send('POST', `/shifts/${shift.id}/assign`, {
				staffId: ben.staffId,
			})
			const extra = await schedule(
				ana.staffId,
				ana.positionIds[0],
				'2026-03-05',
				'12:00',
				'16:00',
			)
			expect(extra.id).toBeTruthy()
			h.advance(MIN)
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await tick()
			const toAna = sent.find((m) => m.to === 'ana@example.com')!
			expect(toAna.subject).toBe('Your schedule was updated')
			expect(toAna.text).toContain('No longer on your schedule:')
			expect(toAna.text).toMatch(/9:00\sAM - 5:00\sPM/)
			expect(toAna.text).toMatch(
				/12:00\sPM - 4:00\sPM \(Cook-\d+-\d+\) \[changed\]/,
			)
			// Ben gets the shift but never learns who had it.
			const toBen = sent.find((m) => m.to === 'ben@example.com')!
			expect(`${toBen.text}${toBen.html}`).not.toContain('Ana')
		})

		it('sends in Arabic, right to left, with Arabic position names', async () => {
			const ana = await person(
				'ana@example.com',
				{
					locale: 'ar',
					firstNameAr: 'رنا',
				},
				{ positions: [{ name: 'Cook', nameAr: 'طباخ', rateMinor: 100 }] },
			)
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await tick()
			const mail = sent[0]!
			expect(mail.html).toContain('dir="rtl"')
			expect(mail.text).toContain('مرحبًا رنا')
			expect(mail.text).toContain('طباخ')
			expect(mail.subject).toBe('تم تحديث جدولك')
		})

		it('reuses one link per person across publications and never stores the token', async () => {
			const ana = await person('ana@example.com')
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await tick()
			h.advance(10 * MIN)
			await schedule(ana.staffId, ana.positionIds[0], '2026-03-04')
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await tick()
			expect(sent).toHaveLength(2)
			const tokens = sent.map((m) => /t=(slk1\.[^\s"&<]+)/.exec(m.text)![1])
			expect(tokens[0]).toBe(tokens[1])
			const links = await (await db()).select().from(scheduleLinks)
			expect(links).toHaveLength(1)
			expect(links[0]!.tokenHash).not.toContain('slk1')
			expect(JSON.stringify(links)).not.toContain(tokens[0]!.split('.')[3]!)
		})

		it('sends one email for a week when two publications are queued for a person', async () => {
			const ana = await person('ana@example.com')
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			h.advance(MIN)
			await schedule(ana.staffId, ana.positionIds[0], '2026-03-04')
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await tick()
			expect(sent).toHaveLength(1)
			const skipped = (await outbox()).filter((r) => r.status === 'skipped')
			expect(skipped.map((r) => r.lastError)).toEqual(['superseded'])
		})

		it('does not send when the kill switch is off, and does not hold it for later', async () => {
			const ana = await person('ana@example.com')
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			emailOn = false
			await tick()
			expect(sent).toEqual([])
			emailOn = true
			await tick()
			expect(sent).toEqual([])
		})

		it('skips someone who left before the email went out', async () => {
			const ana = await person('ana@example.com')
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await (
				await db()
			)
				.update(staffMembers)
				.set({ status: 'terminated' })
				.where(eq(staffMembers.id, ana.staffId))
			await tick()
			expect(sent).toEqual([])
		})

		it('tells managers with a generic event and leaves the publisher out', async () => {
			const ana = await person('ana@example.com')
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await tick()
			expect(alerts).toHaveLength(1)
			expect(alerts[0]).toMatchObject({
				orgId: ORG_A,
				kind: 'schedule_published',
				scopeId: LOC_1,
				count: 1,
				actorUserId: expect.any(String),
			})
			expect(Object.keys(alerts[0]!).sort()).toEqual(
				['actorUserId', 'count', 'eventId', 'kind', 'scopeId', 'orgId'].sort(),
			)
		})

		it('does not deliver schedule messages while scheduling is off', async () => {
			const ana = await person('ana@example.com')
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			deps.getFeatures = async () => ({
				features: {
					enabled: true,
					timeclock: true,
					scheduling: false,
					hiring: false,
				},
				dataRegion: 'us',
			})
			await tick()
			expect(sent).toEqual([])
			expect(alerts).toEqual([])
		})
	})

	describe('seeing who was told, and resending', () => {
		async function published(
			mode: 'changed' | 'everyone' | 'nobody' = 'everyone',
		) {
			const ana = await person('ana@example.com')
			const noMail = await person(null)
			await schedule(ana.staffId, ana.positionIds[0])
			await schedule(noMail.staffId, noMail.positionIds[0], '2026-03-03')
			const response = await s.publish(LOC_1, WEEK, { notifyMode: mode })
			return { ana, noMail, publication: response.body.publication }
		}

		it('lists the delivery state of every recipient', async () => {
			const { ana, noMail, publication } = await published()
			let view = await s.get(`/publications/${publication.id}/notices`)
			expect(view.status).toBe(200)
			expect(view.body).toMatchObject({
				publicationId: publication.id,
				current: true,
				emailEnabled: true,
				notices: [{ staffId: ana.staffId, state: 'pending', round: 0 }],
				notReached: [{ staffId: noMail.staffId, reason: 'no_email' }],
			})
			await tick()
			view = await s.get(`/publications/${publication.id}/notices`)
			expect(view.body.notices[0]).toMatchObject({ state: 'sent' })
			expect(view.body.notices[0].sentAt).toBe(h.clock.now)
		})

		it('resends to people not yet reached once they have an address', async () => {
			const { ana, noMail, publication } = await published()
			await tick()
			expect(sent).toHaveLength(1)
			await (
				await db()
			)
				.update(staffMembers)
				.set({ email: 'late@example.com' })
				.where(eq(staffMembers.id, noMail.staffId))
			h.advance(6 * MIN)
			const resent = await s.send(
				'POST',
				`/publications/${publication.id}/resend`,
				{},
			)
			expect(resent.status).toBe(200)
			expect(resent.body).toEqual({ queued: 1, notReached: [] })
			await tick()
			expect(sent.map((m) => m.to).sort()).toEqual(
				['ana@example.com', 'late@example.com'].sort(),
			)
			// Ana already had hers: the default resend left her alone.
			expect(sent.filter((m) => m.to === 'ana@example.com')).toHaveLength(1)
			const view = await s.get(`/publications/${publication.id}/notices`)
			expect(view.body.notReached).toEqual([])
			expect(
				view.body.notices.find((n: any) => n.staffId === noMail.staffId),
			).toMatchObject({ state: 'sent', round: 1 })
			expect(ana.staffId).toBeTruthy()
		})

		it('resends to everyone on request, as a new round', async () => {
			const { publication } = await published()
			await tick()
			h.advance(6 * MIN)
			const resent = await s.send(
				'POST',
				`/publications/${publication.id}/resend`,
				{
					scope: 'all',
				},
			)
			expect(resent.body.queued).toBe(1)
			const keys = (await outbox())
				.filter((r) => r.kind === 'schedule_published')
				.map((r) => r.dedupeKey)
			expect(keys.some((k) => k.endsWith(':1'))).toBe(true)
			expect(
				keys.every((k) => k.startsWith(scheduleNoticePrefix(publication.id))),
			).toBe(true)
		})

		it('announces a quiet publication afterwards to the people it changed', async () => {
			const { ana, publication } = await published('nobody')
			expect(await outbox()).toEqual([])
			const resent = await s.send(
				'POST',
				`/publications/${publication.id}/resend`,
				{},
			)
			expect(resent.status).toBe(200)
			expect(resent.body.queued).toBe(1)
			const rows = await outbox()
			expect(rows.map((r) => r.staffId)).toEqual([ana.staffId])
		})

		it('refuses a second resend within the cooldown', async () => {
			const { publication } = await published()
			const first = await s.send(
				'POST',
				`/publications/${publication.id}/resend`,
				{
					scope: 'all',
				},
			)
			expect(first.status).toBe(409)
			expect(first.body.error).toBe('resend_too_soon')
			expect(first.body.retryAfterSeconds).toBeGreaterThan(0)
		})

		it('refuses to resend a publication a newer one replaced', async () => {
			const { ana, publication } = await published()
			h.advance(10 * MIN)
			await schedule(ana.staffId, ana.positionIds[0], '2026-03-05')
			expect((await s.publish(LOC_1, WEEK)).status).toBe(200)
			h.advance(10 * MIN)
			const response = await s.send(
				'POST',
				`/publications/${publication.id}/resend`,
				{},
			)
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('superseded')
			const view = await s.get(`/publications/${publication.id}/notices`)
			expect(view.body.current).toBe(false)
		})

		it('refuses to resend while email is switched off', async () => {
			const { publication } = await published()
			h.advance(10 * MIN)
			vi.stubEnv('STAFFING_EMAIL_ENABLED', 'off')
			const response = await s.send(
				'POST',
				`/publications/${publication.id}/resend`,
				{},
			)
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('email_disabled')
		})

		it('needs the edit grant, refuses impersonation, and hides what is out of scope', async () => {
			const { publication } = await published()
			h.advance(10 * MIN)
			const path = `/publications/${publication.id}`
			expect(
				(await s.send('POST', `${path}/resend`, {}, { grants: SCH_VIEW }))
					.status,
			).toBe(403)
			expect(
				(
					await s.send(
						'POST',
						`${path}/resend`,
						{},
						{
							grants: SCH_EDIT,
							impersonated: true,
						},
					)
				).status,
			).toBe(403)
			// A manager of another scope cannot see or resend it.
			expect(
				(await s.get(`${path}/notices`, { scopeIds: [LOC_2] })).status,
			).toBe(404)
			expect(
				(
					await s.send(
						'POST',
						`${path}/resend`,
						{},
						{
							grants: SCH_EDIT,
							scopeIds: [LOC_2],
						},
					)
				).status,
			).toBe(404)
			expect((await s.get(`${path}/notices`, { token: null })).status).toBe(401)
			expect((await s.get('/publications/not%20an%20id/notices')).status).toBe(
				404,
			)
			expect((await s.get('/publications/nope/notices')).status).toBe(404)
			expect(
				(await s.send('POST', `${path}/resend`, { scope: 'x' })).status,
			).toBe(400)
		})

		it('audits a resend with counts only', async () => {
			const { publication } = await published()
			h.advance(10 * MIN)
			await s.send('POST', `/publications/${publication.id}/resend`, {
				scope: 'all',
			})
			const rows = await (
				await db()
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'schedule.publication.resent'))
			expect(rows).toHaveLength(1)
			expect(rows[0]!.changes).toEqual({
				scope: 'all',
				round: 1,
				queued: 1,
				notReached: 1,
			})
		})
	})

	describe("a person's link", () => {
		it('reports whether a link is live and ends it on request', async () => {
			const ana = await person('ana@example.com')
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			expect((await s.get(`/links/${ana.staffId}`)).body).toMatchObject({
				active: false,
			})
			await tick()
			const live = await s.get(`/links/${ana.staffId}`)
			expect(live.body).toMatchObject({ staffId: ana.staffId, active: true })
			expect(live.body.expiresAt).toBeGreaterThan(h.clock.now)

			const revoked = await s.send('POST', `/links/${ana.staffId}/revoke`, {})
			expect(revoked.status).toBe(200)
			expect(revoked.body.active).toBe(false)
			const rows = await (await db()).select().from(scheduleLinks)
			expect(rows[0]).toMatchObject({ revokedAt: h.clock.now })
			// Idempotent, and audited once.
			expect(
				(await s.send('POST', `/links/${ana.staffId}/revoke`, {})).status,
			).toBe(200)
			const audit = await (
				await db()
			)
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'schedule.link.revoked'))
			expect(audit).toHaveLength(1)

			// The next email starts a fresh link.
			h.advance(MIN)
			await schedule(ana.staffId, ana.positionIds[0], '2026-03-04')
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await tick()
			expect(await (await db()).select().from(scheduleLinks)).toHaveLength(2)
			expect((await s.get(`/links/${ana.staffId}`)).body.active).toBe(true)
		})

		it('does not reveal people outside the token scope limit', async () => {
			const other = await person('o@example.com', {}, { scopeIds: [LOC_2] })
			expect(
				(await s.get(`/links/${other.staffId}`, { scopeIds: [LOC_1] })).status,
			).toBe(404)
			expect(
				(
					await s.send(
						'POST',
						`/links/${other.staffId}/revoke`,
						{},
						{
							scopeIds: [LOC_1],
						},
					)
				).status,
			).toBe(404)
			expect((await s.get('/links/%00')).status).toBe(404)
		})

		it('is ended when the person is terminated', async () => {
			const ana = await person('ana@example.com')
			await schedule(ana.staffId, ana.positionIds[0])
			await s.publish(LOC_1, WEEK, { notifyMode: 'changed' })
			await tick()
			const terminated = await h.app.request(
				`/operator/staff/${ana.staffId}/terminate`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						Authorization: `Bearer ${await (
							await import('../../tests/staff-harness.ts')
						).mintStaffToken({
							orgId: ORG_A,
							scope: 'staff',
							grants: ['update:staff:any', 'read:staff:any'],
						})}`,
					},
					body: JSON.stringify({
						reason: 'left',
						eligibleForRehire: true,
					}),
				},
			)
			expect(terminated.status).toBe(200)
			const [link] = await (await db()).select().from(scheduleLinks)
			expect(link).toMatchObject({ revokedBy: 'system' })
			expect(link!.revokedAt).not.toBeNull()
		})
	})

	it('keeps the audit trail free of names and times', async () => {
		const ana = await person('ana@example.com', { firstName: 'Anastasia' })
		await schedule(ana.staffId, ana.positionIds[0])
		await s.publish(LOC_1, WEEK, { notifyMode: 'everyone' })
		const rows = await (
			await db()
		)
			.select()
			.from(staffAuditLog)
			.where(eq(staffAuditLog.action, 'schedule.week.published'))
		expect(rows).toHaveLength(1)
		expect(JSON.stringify(rows[0]!.changes)).not.toContain('Anastasia')
		expect(rows[0]!.changes).toMatchObject({ notified: 1, notReached: 0 })
	})
})
