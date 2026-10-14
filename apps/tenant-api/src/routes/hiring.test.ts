import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	hiringApplications,
	hiringEvents,
	hiringInterviews,
	hiringNotes,
	onboardingTasks,
	staffAuditLog,
	staffingSettings,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	staffPositions,
} from '@repo/tenant-db'
import {
	createHiringHarness,
	HIRING_GRANTS,
	HIRING_PAY_GRANTS,
	HIRING_READ_GRANTS,
	LOC_1,
	LOC_2,
	makeOrg,
	ORG_A,
	ORG_B,
	seedApplication,
	type HiringHarness,
	type TestOrg,
} from '../../tests/hiring-harness.ts'
import { hiringDeps } from '../services/hiring-service.ts'

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)
const original = { ...hiringDeps }
type Sent = { to: string; subject: string; html: string; text: string }

describe('/operator/hiring', () => {
	let h: HiringHarness
	let sent: Sent[]

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		h = await createHiringHarness()
		sent = []
		hiringDeps.now = () => NOW
		hiringDeps.emailEnabled = () => true
		hiringDeps.getOrganizationName = async () => 'Acme Kitchen'
		hiringDeps.getScope = async () => ({
			name: 'Downtown',
			timeZone: 'America/Chicago',
		})
		hiringDeps.sendEmail = async (input) => {
			sent.push(input)
			return { status: 'success' }
		}
	})

	afterEach(async () => {
		Object.assign(hiringDeps, original)
		await h.cleanup()
		vi.unstubAllEnvs()
	})

	async function db() {
		return h.db(ORG_A)
	}

	describe('authentication and grants', () => {
		it('needs a token, the hiring scope and a hiring grant', async () => {
			expect(
				(await h.operator('GET', '/applications', { token: null })).status,
			).toBe(401)
			expect(
				(await h.operator('GET', '/applications', { scope: 'staff' })).status,
			).toBe(403)
			expect(
				(
					await h.operator('GET', '/applications', {
						grants: ['read:staff:any'],
					})
				).status,
			).toBe(403)
		})

		it('refuses every change from a read-only token or an impersonated session', async () => {
			const app = await seedApplication(await db())
			const writes: Array<[string, string, unknown?]> = [
				['POST', `/applications/${app.id}/stage`, { stage: 'screening' }],
				['POST', `/applications/${app.id}/notes`, { body: 'hi' }],
				['POST', `/applications/${app.id}/decline`, { reason: 'not_a_fit' }],
				['DELETE', `/applications/${app.id}`],
			]
			for (const [method, path, body] of writes) {
				const readOnly = await h.operator(method, path, {
					grants: HIRING_READ_GRANTS,
					body,
				})
				expect(readOnly.status, `${method} ${path}`).toBe(403)
				const impersonated = await h.operator(method, path, {
					impersonated: true,
					body,
				})
				expect(impersonated.status, `${method} ${path}`).toBe(403)
			}
			const [row] = await (await db()).select().from(hiringApplications)
			expect(row?.stage).toBe('new')
		})

		it('answers cache-control no-store', async () => {
			const reply = await h.operator('GET', '/applications')
			expect(reply.headers.get('cache-control')).toBe('private, no-store')
		})
	})

	describe('positions for a hire', () => {
		it('lists active positions by name, without rates, for a hiring-only token', async () => {
			const d = await db()
			await d
				.insert(staffPositions)
				.values([
					{ name: 'Server', defaultRateMinor: 1500, currency: 'USD' },
					{ name: 'Cook' },
					{ name: 'Retired', archivedAt: 5 },
				])
			const reply = await h.operator('GET', '/positions', {
				grants: HIRING_READ_GRANTS,
			})
			expect(reply.status).toBe(200)
			expect(reply.body.positions.map((p: any) => p.name)).toEqual([
				'Cook',
				'Server',
			])
			expect(reply.raw).not.toMatch(/1500|rate|currency/i)
		})
	})

	describe('list', () => {
		it('returns pipeline rows without contact details or answers', async () => {
			await seedApplication(await db(), { screenerFlags: ['weekends'] })
			const reply = await h.operator('GET', '/applications')
			expect(reply.status).toBe(200)
			const [item] = reply.body.applications
			expect(item).toMatchObject({
				firstName: expect.any(String),
				stage: 'new',
				postingTitle: 'Line cook',
				flagCount: 1,
				hasEmail: true,
				hasPhone: false,
				noteCount: 0,
			})
			expect(reply.raw).not.toContain('@example.com')
			expect(reply.raw).not.toContain('grill')
			expect(item).not.toHaveProperty('email')
			expect(item).not.toHaveProperty('answers')
		})

		it('filters by stage, job, flag and search, and counts per stage', async () => {
			const d = await db()
			await seedApplication(d, { firstName: 'Amira', stage: 'new' })
			await seedApplication(d, {
				firstName: 'Bilal',
				stage: 'interview',
				postingId: 'posting-2',
				postingTitle: 'Server',
				screenerFlags: ['weekends'],
				screenerScore: 40,
			})
			await seedApplication(d, { firstName: 'Carla', stage: 'declined' })

			const all = await h.operator('GET', '/applications')
			expect(all.body.total).toBe(3)
			expect(all.body.counts).toEqual({
				new: 1,
				screening: 0,
				interview: 1,
				offer: 0,
				hired: 0,
				declined: 1,
			})
			expect(all.body.postings).toEqual([
				{ postingId: 'posting-1', title: 'Line cook', count: 2 },
				{ postingId: 'posting-2', title: 'Server', count: 1 },
			])

			const open = await h.operator('GET', '/applications?stage=open')
			expect(
				open.body.applications.map((a: any) => a.firstName).sort(),
			).toEqual(['Amira', 'Bilal'])
			const interview = await h.operator('GET', '/applications?stage=interview')
			expect(interview.body.applications.map((a: any) => a.firstName)).toEqual([
				'Bilal',
			])
			// Counts ignore the stage filter so column headers stay right.
			expect(interview.body.counts.new).toBe(1)

			const byJob = await h.operator('GET', '/applications?postingId=posting-2')
			expect(byJob.body.total).toBe(1)
			const flagged = await h.operator('GET', '/applications?flagged=1')
			expect(flagged.body.applications.map((a: any) => a.firstName)).toEqual([
				'Bilal',
			])
			const search = await h.operator('GET', '/applications?q=amir')
			expect(search.body.applications.map((a: any) => a.firstName)).toEqual([
				'Amira',
			])
			const byTitle = await h.operator('GET', '/applications?q=server')
			expect(byTitle.body.total).toBe(1)
		})

		it('treats search text as text, not as a pattern', async () => {
			await seedApplication(await db(), { firstName: 'Amira' })
			for (const q of [
				'%',
				'_',
				'\\',
				"'; drop table hiring_applications; --",
			]) {
				const reply = await h.operator(
					'GET',
					`/applications?q=${encodeURIComponent(q)}`,
				)
				expect(reply.status).toBe(200)
				expect(reply.body.total).toBe(0)
			}
			expect(
				(await (await db()).select().from(hiringApplications)).length,
			).toBe(1)
		})

		it('sorts, pages and rejects bad queries', async () => {
			const d = await db()
			await seedApplication(d, { firstName: 'Low', screenerScore: 20 })
			await seedApplication(d, { firstName: 'High', screenerScore: 90 })
			await seedApplication(d, { firstName: 'None', screenerScore: null })
			const byScore = await h.operator('GET', '/applications?sort=score')
			expect(byScore.body.applications.map((a: any) => a.firstName)).toEqual([
				'High',
				'Low',
				'None',
			])
			const page = await h.operator(
				'GET',
				'/applications?sort=score&limit=1&offset=1',
			)
			expect(page.body.applications.map((a: any) => a.firstName)).toEqual([
				'Low',
			])
			expect(page.body.total).toBe(3)
			for (const bad of [
				'stage=maybe',
				'limit=0',
				'limit=1000',
				'offset=-1',
				'sort=x',
				'extra=1',
			]) {
				const reply = await h.operator('GET', `/applications?${bad}`)
				expect(reply.status, bad).toBe(400)
			}
		})

		it('reports the next interview and note count on the card', async () => {
			const d = await db()
			const app = await seedApplication(d)
			await d.insert(hiringNotes).values({
				applicationId: app.id,
				authorId: 'op1',
				body: 'Called',
			})
			await d.insert(hiringNotes).values({
				applicationId: app.id,
				authorId: 'op1',
				body: 'Removed',
				deletedAt: 5,
			})
			await d.insert(hiringInterviews).values({
				applicationId: app.id,
				scheduledAt: NOW + 86_400_000,
				createdBy: 'op1',
			})
			const reply = await h.operator('GET', '/applications')
			expect(reply.body.applications[0]).toMatchObject({
				noteCount: 1,
				interviewAt: NOW + 86_400_000,
			})
		})
	})

	describe('scope limit', () => {
		it('shows a scoped manager only their scopes, never organization-wide applicants', async () => {
			const d = await db()
			await seedApplication(d, { firstName: 'Here', scopeId: LOC_1 })
			await seedApplication(d, { firstName: 'There', scopeId: LOC_2 })
			await seedApplication(d, { firstName: 'Anywhere', scopeId: null })
			const scoped = await h.operator('GET', '/applications', {
				scopeIds: [LOC_1],
			})
			expect(scoped.body.applications.map((a: any) => a.firstName)).toEqual([
				'Here',
			])
			expect(scoped.body.counts.new).toBe(1)
			expect(scoped.body.postings).toHaveLength(1)

			const none = await h.operator('GET', '/applications', { scopeIds: [] })
			expect(none.body.applications).toEqual([])

			const unrestricted = await h.operator('GET', '/applications')
			expect(unrestricted.body.total).toBe(3)
		})

		it('treats an application outside the scope as unknown for every route', async () => {
			const d = await db()
			const other = await seedApplication(d, { scopeId: LOC_2 })
			const orgWide = await seedApplication(d, { scopeId: null })
			const options = { scopeIds: [LOC_1] }
			for (const target of [other, orgWide]) {
				const base = `/applications/${target.id}`
				const calls: Array<[string, string, unknown?]> = [
					['GET', base],
					['POST', `${base}/stage`, { stage: 'screening' }],
					['POST', `${base}/notes`, { body: 'x' }],
					['POST', `${base}/decline`, { reason: 'not_a_fit' }],
					[
						'POST',
						`${base}/hire`,
						{
							scopeId: LOC_1,
							positionId: 'p',
							hiredDate: '2026-10-20',
							currency: 'USD',
						},
					],
					['DELETE', base],
				]
				for (const [method, path, body] of calls) {
					const reply = await h.operator(method, path, { ...options, body })
					expect(reply.status, `${method} ${path}`).toBe(404)
				}
			}
			const unchanged = await d.select().from(hiringApplications)
			expect(unchanged.every((row) => row.stage === 'new')).toBe(true)
		})

		it('shows an applicant to every scope they are interested in, and filters by it', async () => {
			const d = await db()
			const both = await seedApplication(d, {
				firstName: 'Both',
				scopeId: LOC_1,
				interestedScopeIds: [LOC_1, LOC_2],
			})
			await seedApplication(d, { firstName: 'Only1', scopeId: LOC_1 })
			await seedApplication(d, { firstName: 'Only2', scopeId: LOC_2 })

			const second = await h.operator('GET', '/applications', {
				scopeIds: [LOC_2],
			})
			expect(
				second.body.applications.map((a: any) => a.firstName).sort(),
			).toEqual(['Both', 'Only2'])
			const detail = await h.operator('GET', `/applications/${both.id}`, {
				scopeIds: [LOC_2],
			})
			expect(detail.status).toBe(200)

			const filtered = await h.operator(
				'GET',
				`/applications?scopeId=${LOC_2}`,
				{ scopeIds: [LOC_1, LOC_2] },
			)
			expect(
				filtered.body.applications.map((a: any) => a.firstName).sort(),
			).toEqual(['Both', 'Only2'])

			const other = await h.operator('GET', `/applications/${both.id}`, {
				scopeIds: ['elsewhere'],
			})
			expect(other.status).toBe(404)
		})

		it('refuses a scope filter outside the scope', async () => {
			const reply = await h.operator('GET', `/applications?scopeId=${LOC_2}`, {
				scopeIds: [LOC_1],
			})
			expect(reply.status).toBe(403)
		})
	})

	describe('one candidate', () => {
		it('returns contact, answers, notes, interviews and timeline, and audits the read first', async () => {
			const d = await db()
			const app = await seedApplication(d, {
				email: 'sara@example.com',
				phone: '+14155550123',
			})
			await d.insert(hiringEvents).values({
				applicationId: app.id,
				kind: 'applied',
				toStage: 'new',
				at: 10,
			})
			const reply = await h.operator('GET', `/applications/${app.id}`)
			expect(reply.status).toBe(200)
			expect(reply.body).toMatchObject({
				id: app.id,
				email: 'sara@example.com',
				phone: '+14155550123',
				consentVersion: '2026-10',
				declineRetentionDays: 365,
				answers: [
					expect.objectContaining({ id: 'weekends', answer: 'yes' }),
					expect.objectContaining({ id: 'about' }),
				],
				timeline: [expect.objectContaining({ kind: 'applied' })],
			})
			const audit = await d
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'hiring.application.viewed'))
			expect(audit).toHaveLength(1)
			expect(audit[0]).toMatchObject({
				entityId: app.id,
				entityType: 'application',
				sensitivity: 'private',
				actorId: 'operator-1',
			})
			expect(JSON.stringify(audit[0])).not.toContain('sara@example.com')
		})

		it('answers 404 for an unknown or malformed id', async () => {
			expect((await h.operator('GET', '/applications/nope')).status).toBe(404)
			expect((await h.operator('GET', '/applications/..%2Fetc')).status).toBe(
				404,
			)
			expect(
				(await h.operator('GET', `/applications/${'a'.repeat(65)}`)).status,
			).toBe(404)
		})

		it("never reaches another organization's applicants", async () => {
			const other = await seedApplication(await h.db(ORG_B))
			const reply = await h.operator('GET', `/applications/${other.id}`)
			expect(reply.status).toBe(404)
			const own = await h.operator('GET', '/applications')
			expect(own.body.total).toBe(0)
		})
	})

	describe('stage moves', () => {
		it('moves between open stages with a timeline entry and an audit row', async () => {
			const d = await db()
			const app = await seedApplication(d)
			const reply = await h.operator('POST', `/applications/${app.id}/stage`, {
				body: { stage: 'screening' },
			})
			expect(reply.status).toBe(200)
			expect(reply.body.application).toMatchObject({
				stage: 'screening',
				stageChangedAt: NOW,
			})
			const [event] = await d.select().from(hiringEvents)
			expect(event).toMatchObject({
				kind: 'stage_changed',
				fromStage: 'new',
				toStage: 'screening',
				actorId: 'operator-1',
			})
			const [audit] = await d
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'hiring.application.stage_changed'))
			expect(audit?.changes).toEqual({ from: 'new', to: 'screening' })
		})

		it('cannot move into hired or declined, or out of hired', async () => {
			const d = await db()
			const app = await seedApplication(d)
			for (const stage of ['hired', 'declined', 'bogus']) {
				const reply = await h.operator(
					'POST',
					`/applications/${app.id}/stage`,
					{
						body: { stage },
					},
				)
				expect(reply.status, stage).toBe(400)
			}
			const hired = await seedApplication(d, { stage: 'hired' })
			const reply = await h.operator(
				'POST',
				`/applications/${hired.id}/stage`,
				{
					body: { stage: 'new' },
				},
			)
			expect(reply.status).toBe(409)
			expect(reply.body.error).toBe('already_hired')
		})

		it('reopens a declined candidate and stops the retention clock', async () => {
			const d = await db()
			const app = await seedApplication(d, {
				stage: 'declined',
				declinedAt: 5,
				declinedReason: 'not_a_fit',
				retentionExpiresAt: 99,
			})
			const reply = await h.operator('POST', `/applications/${app.id}/stage`, {
				body: { stage: 'screening' },
			})
			expect(reply.status).toBe(200)
			const [row] = await d.select().from(hiringApplications)
			expect(row).toMatchObject({
				stage: 'screening',
				declinedAt: null,
				declinedReason: null,
				retentionExpiresAt: null,
			})
			const [event] = await d.select().from(hiringEvents)
			expect(event?.kind).toBe('reopened')
		})

		it('refuses to reopen a declined candidate who has since applied again', async () => {
			const d = await db()
			const declined = await seedApplication(d, {
				stage: 'declined',
				emailHash: 'same-person',
				declinedAt: 5,
				retentionExpiresAt: 99,
			})
			await seedApplication(d, { stage: 'new', emailHash: 'same-person' })
			const reply = await h.operator(
				'POST',
				`/applications/${declined.id}/stage`,
				{ body: { stage: 'screening' } },
			)
			expect(reply.status).toBe(409)
			expect(reply.body.error).toBe('duplicate_application')
			// Nothing changed: still declined, clock still running, no timeline entry.
			const [row] = await d
				.select()
				.from(hiringApplications)
				.where(eq(hiringApplications.id, declined.id))
			expect(row).toMatchObject({ stage: 'declined', retentionExpiresAt: 99 })
			expect(await d.select().from(hiringEvents)).toHaveLength(0)
		})

		it('rejects extra keys', async () => {
			const app = await seedApplication(await db())
			const reply = await h.operator('POST', `/applications/${app.id}/stage`, {
				body: { stage: 'offer', hiredStaffId: 'x' },
			})
			expect(reply.status).toBe(400)
		})
	})

	describe('notes', () => {
		it('adds and removes notes without copying their text into the audit log', async () => {
			const d = await db()
			const app = await seedApplication(d)
			const added = await h.operator('POST', `/applications/${app.id}/notes`, {
				body: { body: 'Spoke on the phone, very keen' },
			})
			expect(added.status).toBe(201)
			expect(added.body.note).toMatchObject({
				authorId: 'operator-1',
				body: 'Spoke on the phone, very keen',
			})
			const audit = await d
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'hiring.note.added'))
			expect(JSON.stringify(audit)).not.toContain('very keen')

			const detail = await h.operator('GET', `/applications/${app.id}`)
			expect(detail.body.notes).toHaveLength(1)
			const removed = await h.operator(
				'DELETE',
				`/applications/${app.id}/notes/${added.body.note.id}`,
			)
			expect(removed.status).toBe(200)
			const after = await h.operator('GET', `/applications/${app.id}`)
			expect(after.body.notes).toHaveLength(0)
			expect(
				(
					await h.operator(
						'DELETE',
						`/applications/${app.id}/notes/${added.body.note.id}`,
					)
				).status,
			).toBe(404)
		})

		it('validates note text', async () => {
			const app = await seedApplication(await db())
			for (const body of [
				{ body: '' },
				{ body: '   ' },
				{ body: 'x'.repeat(2001) },
				{},
			]) {
				const reply = await h.operator(
					'POST',
					`/applications/${app.id}/notes`,
					{ body },
				)
				expect(reply.status).toBe(400)
			}
		})

		it('cannot remove a note through another application', async () => {
			const d = await db()
			const a = await seedApplication(d)
			const b = await seedApplication(d)
			const note = await h.operator('POST', `/applications/${a.id}/notes`, {
				body: { body: 'private' },
			})
			const reply = await h.operator(
				'DELETE',
				`/applications/${b.id}/notes/${note.body.note.id}`,
			)
			expect(reply.status).toBe(404)
		})
	})

	describe('interviews', () => {
		const inTwoDays = NOW + 2 * 86_400_000

		it('records the interview, moves the card, and emails the invitation in the scope zone', async () => {
			const d = await db()
			const app = await seedApplication(d, { email: 'sara@example.com' })
			const reply = await h.operator(
				'POST',
				`/applications/${app.id}/interviews`,
				{
					body: {
						scheduledAt: inTwoDays,
						durationMinutes: 45,
						mode: 'in_person',
						details: 'Ask for Hana at the bar',
					},
				},
			)
			expect(reply.status).toBe(201)
			expect(reply.body.interview).toMatchObject({
				status: 'scheduled',
				inviteStatus: 'sent',
				inviteSentAt: NOW,
				durationMinutes: 45,
				scopeId: LOC_1,
			})
			expect(sent).toHaveLength(1)
			expect(sent[0]!.to).toBe('sara@example.com')
			expect(sent[0]!.subject).toContain('Line cook')
			expect(sent[0]!.text).toContain('Ask for Hana at the bar')
			expect(sent[0]!.text).toContain('Downtown')
			// 2026-10-16 12:00 UTC is 7:00 AM in Chicago (CDT).
			expect(sent[0]!.text).toMatch(/7:00\s?AM/)
			const [row] = await d.select().from(hiringApplications)
			expect(row?.stage).toBe('interview')
			const kinds = (await d.select().from(hiringEvents))
				.map((e) => e.kind)
				.sort()
			expect(kinds).toEqual([
				'interview_scheduled',
				'invite_sent',
				'stage_changed',
			])
		})

		it('does not leak notes, score or answers into the email', async () => {
			const d = await db()
			const app = await seedApplication(d, {
				email: 'sara@example.com',
				screenerScore: 12,
				screenerFlags: ['weekends'],
			})
			await d.insert(hiringNotes).values({
				applicationId: app.id,
				authorId: 'op',
				body: 'SECRET-NOTE',
			})
			await h.operator('POST', `/applications/${app.id}/interviews`, {
				body: { scheduledAt: inTwoDays },
			})
			const mail = JSON.stringify(sent)
			expect(mail).not.toContain('SECRET-NOTE')
			expect(mail).not.toContain('grill')
			expect(mail).not.toContain('dealbreaker')
		})

		it('escapes manager-typed details in the HTML', async () => {
			const app = await seedApplication(await db(), {
				email: 'sara@example.com',
			})
			await h.operator('POST', `/applications/${app.id}/interviews`, {
				body: { scheduledAt: inTwoDays, details: '<script>alert(1)</script>' },
			})
			expect(sent[0]!.html).not.toContain('<script>')
			expect(sent[0]!.html).toContain('&lt;script&gt;')
		})

		it('says why no invitation was sent', async () => {
			const d = await db()
			const noEmail = await seedApplication(d, {
				email: null,
				phone: '+14155550123',
			})
			const first = await h.operator(
				'POST',
				`/applications/${noEmail.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays },
				},
			)
			expect(first.body.interview.inviteStatus).toBe('no_email')

			hiringDeps.emailEnabled = () => false
			const withEmail = await seedApplication(d)
			const second = await h.operator(
				'POST',
				`/applications/${withEmail.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays },
				},
			)
			expect(second.body.interview.inviteStatus).toBe('email_disabled')

			hiringDeps.emailEnabled = () => true
			hiringDeps.getScope = async () => null
			const third = await seedApplication(d)
			const lost = await h.operator(
				'POST',
				`/applications/${third.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays },
				},
			)
			expect(lost.body.interview.inviteStatus).toBe('failed')
			expect(sent).toHaveLength(0)

			hiringDeps.getScope = async () => ({ name: 'D', timeZone: 'UTC' })
			hiringDeps.sendEmail = async () => ({
				status: 'error',
				error: { message: 'to: sara@example.com bounced', statusCode: 500 },
			})
			const fourth = await seedApplication(d)
			const failed = await h.operator(
				'POST',
				`/applications/${fourth.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays },
				},
			)
			expect(failed.status).toBe(201)
			expect(failed.body.interview.inviteStatus).toBe('failed')
			// The provider's message (which can quote the address) is not recorded.
			const events = JSON.stringify(await d.select().from(hiringEvents))
			expect(events).not.toContain('bounced')
		})

		it('can skip the invitation, and needs a scope for an organization-wide job', async () => {
			const d = await db()
			const app = await seedApplication(d)
			const skipped = await h.operator(
				'POST',
				`/applications/${app.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays, sendInvite: false },
				},
			)
			expect(skipped.body.interview.inviteStatus).toBe('not_sent')
			expect(sent).toHaveLength(0)

			const orgWide = await seedApplication(d, { scopeId: null })
			const noPlace = await h.operator(
				'POST',
				`/applications/${orgWide.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays },
				},
			)
			expect(noPlace.status).toBe(422)
			expect(noPlace.body.error).toBe('scope_required')
			const placed = await h.operator(
				'POST',
				`/applications/${orgWide.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays, scopeId: LOC_2 },
				},
			)
			expect(placed.status).toBe(201)
			expect(placed.body.interview.scopeId).toBe(LOC_2)
		})

		it('refuses a time in the past or far away, and closed candidates', async () => {
			const d = await db()
			const app = await seedApplication(d)
			const past = await h.operator(
				'POST',
				`/applications/${app.id}/interviews`,
				{
					body: { scheduledAt: NOW - 3_600_000 },
				},
			)
			expect(past.status).toBe(422)
			expect(past.body.error).toBe('interview_in_past')
			const far = await h.operator(
				'POST',
				`/applications/${app.id}/interviews`,
				{
					body: { scheduledAt: NOW + 400 * 86_400_000 },
				},
			)
			expect(far.body.error).toBe('interview_too_far')
			const declined = await seedApplication(d, { stage: 'declined' })
			const closed = await h.operator(
				'POST',
				`/applications/${declined.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays },
				},
			)
			expect(closed.status).toBe(409)
			expect(closed.body.error).toBe('application_closed')
		})

		it('a scoped manager cannot book an interview at a scope outside their scope', async () => {
			const app = await seedApplication(await db(), { scopeId: LOC_1 })
			const reply = await h.operator(
				'POST',
				`/applications/${app.id}/interviews`,
				{
					scopeIds: [LOC_1],
					body: { scheduledAt: inTwoDays, scopeId: LOC_2 },
				},
			)
			expect(reply.status).toBe(403)
		})

		it('updates, completes with a private outcome, and resends the invitation as a change', async () => {
			const d = await db()
			const app = await seedApplication(d, { email: 'sara@example.com' })
			const created = await h.operator(
				'POST',
				`/applications/${app.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays },
				},
			)
			const id = created.body.interview.id
			const moved = await h.operator(
				'PATCH',
				`/applications/${app.id}/interviews/${id}`,
				{
					body: { scheduledAt: inTwoDays + 3_600_000, resendInvite: true },
				},
			)
			expect(moved.status).toBe(200)
			expect(sent).toHaveLength(2)
			expect(sent[1]!.subject).toContain('has moved')

			const done = await h.operator(
				'PATCH',
				`/applications/${app.id}/interviews/${id}`,
				{
					body: { status: 'completed', outcome: 'Strong on knife skills' },
				},
			)
			expect(done.body.interview).toMatchObject({
				status: 'completed',
				outcome: 'Strong on knife skills',
			})
			// Completing does not email the applicant, and the outcome is not in mail.
			expect(sent).toHaveLength(2)
			expect(JSON.stringify(sent)).not.toContain('knife')
		})

		it('lets a past interview be closed with its own time, but not moved to another past time', async () => {
			const d = await db()
			const app = await seedApplication(d, { stage: 'interview' })
			const [past] = await d
				.insert(hiringInterviews)
				.values({
					applicationId: app.id,
					scopeId: LOC_1,
					scheduledAt: NOW - 3_600_000,
					createdBy: 'operator-1',
					createdAt: NOW - 86_400_000,
					updatedAt: NOW - 86_400_000,
				})
				.returning()
			const done = await h.operator(
				'PATCH',
				`/applications/${app.id}/interviews/${past!.id}`,
				{ body: { scheduledAt: past!.scheduledAt, status: 'no_show' } },
			)
			expect(done.status).toBe(200)
			expect(done.body.interview.status).toBe('no_show')
			const moved = await h.operator(
				'PATCH',
				`/applications/${app.id}/interviews/${past!.id}`,
				{ body: { scheduledAt: NOW - 7_200_000 } },
			)
			expect(moved.status).toBe(422)
			expect(moved.body.error).toBe('interview_in_past')
		})

		it('tells the applicant when an interview they were invited to is cancelled', async () => {
			const d = await db()
			const app = await seedApplication(d, { email: 'sara@example.com' })
			const created = await h.operator(
				'POST',
				`/applications/${app.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays },
				},
			)
			const cancelled = await h.operator(
				'PATCH',
				`/applications/${app.id}/interviews/${created.body.interview.id}`,
				{ body: { status: 'cancelled' } },
			)
			expect(cancelled.status).toBe(200)
			expect(sent).toHaveLength(2)
			expect(sent[1]!.subject).toContain('cancelled')
		})

		it('cannot touch an interview through another application', async () => {
			const d = await db()
			const a = await seedApplication(d)
			const b = await seedApplication(d)
			const created = await h.operator(
				'POST',
				`/applications/${a.id}/interviews`,
				{
					body: { scheduledAt: inTwoDays, sendInvite: false },
				},
			)
			const reply = await h.operator(
				'PATCH',
				`/applications/${b.id}/interviews/${created.body.interview.id}`,
				{ body: { status: 'completed' } },
			)
			expect(reply.status).toBe(404)
		})

		it('validates the body', async () => {
			const app = await seedApplication(await db())
			for (const body of [
				{},
				{ scheduledAt: 'tomorrow' },
				{ scheduledAt: inTwoDays, durationMinutes: 1 },
				{ scheduledAt: inTwoDays, mode: 'carrier_pigeon' },
				{ scheduledAt: inTwoDays, details: 'x'.repeat(501) },
				{ scheduledAt: inTwoDays, extra: true },
			]) {
				const reply = await h.operator(
					'POST',
					`/applications/${app.id}/interviews`,
					{ body },
				)
				expect(reply.status).toBe(400)
			}
		})
	})

	describe('decline', () => {
		it('declines with a reason, starts retention from the configured period, and emails', async () => {
			const d = await db()
			await d.insert(staffingSettings).values({
				id: 'org',
				retentionDaysDeclinedApplicants: 30,
			})
			const app = await seedApplication(d, {
				email: 'sara@example.com',
				locale: 'ar',
			})
			const reply = await h.operator(
				'POST',
				`/applications/${app.id}/decline`,
				{
					body: { reason: 'position_filled', template: 'position_filled' },
				},
			)
			expect(reply.status).toBe(200)
			expect(reply.body).toMatchObject({
				email: 'sent',
				application: { stage: 'declined' },
			})
			const [row] = await d.select().from(hiringApplications)
			expect(row).toMatchObject({
				stage: 'declined',
				declinedReason: 'position_filled',
				declinedAt: NOW,
				retentionExpiresAt: NOW + 30 * 86_400_000,
			})
			expect(sent).toHaveLength(1)
			// The applicant's language.
			expect(sent[0]!.html).toContain('dir="rtl"')
			expect(sent[0]!.text).not.toContain('position_filled')
		})

		it('uses the default period when the organization has not chosen', async () => {
			const d = await db()
			const app = await seedApplication(d)
			await h.operator('POST', `/applications/${app.id}/decline`, {
				body: { reason: 'not_a_fit', template: 'none' },
			})
			const [row] = await d.select().from(hiringApplications)
			expect(row?.retentionExpiresAt).toBe(NOW + 365 * 86_400_000)
			expect(sent).toHaveLength(0)
		})

		it('sends no message when none is chosen, and reports when it cannot', async () => {
			const d = await db()
			const silent = await seedApplication(d)
			const none = await h.operator(
				'POST',
				`/applications/${silent.id}/decline`,
				{
					body: { reason: 'not_a_fit', template: 'none' },
				},
			)
			expect(none.body.email).toBe('none')

			const noEmail = await seedApplication(d, {
				email: null,
				phone: '+14155550123',
			})
			const reply = await h.operator(
				'POST',
				`/applications/${noEmail.id}/decline`,
				{
					body: { reason: 'not_a_fit' },
				},
			)
			expect(reply.status).toBe(200)
			expect(reply.body.email).toBe('no_email')

			hiringDeps.emailEnabled = () => false
			const off = await seedApplication(d)
			const disabled = await h.operator(
				'POST',
				`/applications/${off.id}/decline`,
				{
					body: { reason: 'not_a_fit' },
				},
			)
			expect(disabled.body.email).toBe('email_disabled')
			expect(sent).toHaveLength(0)
		})

		it('keeps the decision when the email fails', async () => {
			hiringDeps.sendEmail = async () => {
				throw new Error('smtp down')
			}
			const d = await db()
			const app = await seedApplication(d)
			const reply = await h.operator(
				'POST',
				`/applications/${app.id}/decline`,
				{
					body: { reason: 'not_a_fit' },
				},
			)
			expect(reply.status).toBe(200)
			expect(reply.body.email).toBe('failed')
			const [row] = await d.select().from(hiringApplications)
			expect(row?.stage).toBe('declined')
		})

		it('cancels interviews that are still ahead', async () => {
			const d = await db()
			const app = await seedApplication(d)
			await d.insert(hiringInterviews).values([
				{ applicationId: app.id, scheduledAt: NOW + 1, createdBy: 'op' },
				{
					applicationId: app.id,
					scheduledAt: NOW - 1,
					createdBy: 'op',
					status: 'completed',
				},
			])
			await h.operator('POST', `/applications/${app.id}/decline`, {
				body: { reason: 'not_a_fit', template: 'none' },
			})
			const rows = await d.select().from(hiringInterviews)
			expect(rows.map((r) => r.status).sort()).toEqual([
				'cancelled',
				'completed',
			])
		})

		it('refuses a second decline and a hired candidate', async () => {
			const d = await db()
			const app = await seedApplication(d)
			const body = { reason: 'not_a_fit', template: 'none' }
			expect(
				(await h.operator('POST', `/applications/${app.id}/decline`, { body }))
					.status,
			).toBe(200)
			const again = await h.operator(
				'POST',
				`/applications/${app.id}/decline`,
				{ body },
			)
			expect(again.status).toBe(409)
			expect(again.body.error).toBe('already_declined')
			const hired = await seedApplication(d, { stage: 'hired' })
			expect(
				(
					await h.operator('POST', `/applications/${hired.id}/decline`, {
						body,
					})
				).status,
			).toBe(409)
		})

		it('validates reason and template', async () => {
			const app = await seedApplication(await db())
			for (const body of [
				{},
				{ reason: 'because' },
				{ reason: 'not_a_fit', template: 'rude' },
				{ reason: 'not_a_fit', free: 'text' },
			]) {
				const reply = await h.operator(
					'POST',
					`/applications/${app.id}/decline`,
					{ body },
				)
				expect(reply.status).toBe(400)
			}
		})
	})

	describe('hire', () => {
		async function addPosition(name = 'Line cook', archived = false) {
			const d = await db()
			const [position] = await d
				.insert(staffPositions)
				.values({ name, archivedAt: archived ? 1 : null })
				.returning()
			return position!
		}

		const hireBody = (
			positionId: string,
			extra: Record<string, unknown> = {},
		) => ({
			scopeId: LOC_1,
			positionId,
			hiredDate: '2026-10-20',
			currency: 'USD',
			...extra,
		})

		it('creates the person, assignment, position, checklist and Hired state together', async () => {
			const d = await db()
			const position = await addPosition()
			const app = await seedApplication(d, {
				firstName: 'Sara',
				lastName: 'Ali',
				email: 'sara@example.com',
				phone: '+14155550123',
				locale: 'ar',
				stage: 'offer',
			})
			const reply = await h.operator('POST', `/applications/${app.id}/hire`, {
				body: hireBody(position.id),
			})
			expect(reply.status).toBe(201)
			expect(reply.body).toMatchObject({
				applicationId: app.id,
				onboardingTasks: 5,
				inviteEmail: 'sara@example.com',
			})

			const [staff] = await d.select().from(staffMembers)
			expect(staff).toMatchObject({
				id: reply.body.staffId,
				firstName: 'Sara',
				lastName: 'Ali',
				email: 'sara@example.com',
				phone: '+14155550123',
				locale: 'ar',
				status: 'active',
				hiredDate: '2026-10-20',
				primaryScopeId: LOC_1,
				userId: null,
				createdBy: 'operator-1',
			})
			const [assignment] = await d.select().from(staffScopeAssignments)
			expect(assignment).toMatchObject({
				staffId: staff!.id,
				scopeId: LOC_1,
				isPrimary: true,
				active: true,
			})
			const [job] = await d.select().from(staffJobs)
			expect(job).toMatchObject({
				staffId: staff!.id,
				positionId: position.id,
				isPrimary: true,
				effectiveFrom: '2026-10-20',
				rateMinor: null,
			})
			const tasks = await d.select().from(onboardingTasks)
			expect(tasks.map((t) => t.taskKey)).toEqual([
				'confirm_contact',
				'emergency_contact',
				'share_house_rules',
				'set_up_clock_pin',
				'add_to_schedule',
			])
			expect(
				tasks.every((t) => t.status === 'todo' && t.staffId === staff!.id),
			).toBe(true)
			expect(tasks[0]!.dueDate).toBe('2026-10-20')
			expect(tasks[4]!.dueDate).toBe('2026-10-27')
			const [after] = await d.select().from(hiringApplications)
			expect(after).toMatchObject({
				stage: 'hired',
				hiredStaffId: staff!.id,
				hiredAt: NOW,
				retentionExpiresAt: null,
			})
			const actions = (await d.select().from(staffAuditLog)).map(
				(r) => r.action,
			)
			expect(actions).toEqual(
				expect.arrayContaining([
					'staff.created',
					'staff.job.added',
					'hiring.application.hired',
				]),
			)
			expect(actions).not.toContain('staff.pay.set')
			const hiredEvent = (await d.select().from(hiringEvents)).find(
				(e) => e.kind === 'hired',
			)
			expect(hiredEvent).toMatchObject({ fromStage: 'offer', toStage: 'hired' })
		})

		it('is one transaction: a failure part way leaves nothing behind', async () => {
			const d = await db()
			const position = await addPosition()
			const app = await seedApplication(d)
			await d.run(
				`CREATE TRIGGER fail_hire BEFORE UPDATE ON hiring_applications BEGIN SELECT RAISE(ABORT, 'boom'); END` as never,
			)
			const reply = await h.operator('POST', `/applications/${app.id}/hire`, {
				body: hireBody(position.id),
			})
			expect(reply.status).toBe(500)
			expect(reply.raw).not.toContain('boom')
			expect(await d.select().from(staffMembers)).toHaveLength(0)
			expect(await d.select().from(staffScopeAssignments)).toHaveLength(0)
			expect(await d.select().from(staffJobs)).toHaveLength(0)
			expect(await d.select().from(onboardingTasks)).toHaveLength(0)
			expect(
				(await d.select().from(staffAuditLog)).filter(
					(r) =>
						r.action.startsWith('staff.') ||
						r.action === 'hiring.application.hired',
				),
			).toHaveLength(0)
			const [row] = await d.select().from(hiringApplications)
			expect(row?.stage).toBe('new')
		})

		it('sets pay only with the pay grant, and audits it as pay', async () => {
			const d = await db()
			const position = await addPosition()
			const app = await seedApplication(d)
			const denied = await h.operator('POST', `/applications/${app.id}/hire`, {
				body: hireBody(position.id, { rateMinor: 1800 }),
			})
			expect(denied.status).toBe(403)
			expect(await d.select().from(staffMembers)).toHaveLength(0)

			const allowed = await h.operator('POST', `/applications/${app.id}/hire`, {
				grants: HIRING_PAY_GRANTS,
				body: hireBody(position.id, { rateMinor: 1800, tipEligible: true }),
			})
			expect(allowed.status).toBe(201)
			const [job] = await d.select().from(staffJobs)
			expect(job).toMatchObject({
				rateMinor: 1800,
				tipEligible: true,
				currency: 'USD',
			})
			const [pay] = (await d.select().from(staffAuditLog)).filter(
				(r) => r.action === 'staff.pay.set',
			)
			expect(pay?.sensitivity).toBe('pay')
		})

		it('can skip the checklist', async () => {
			const d = await db()
			const position = await addPosition()
			const app = await seedApplication(d)
			const reply = await h.operator('POST', `/applications/${app.id}/hire`, {
				body: hireBody(position.id, { startOnboarding: false }),
			})
			expect(reply.body.onboardingTasks).toBe(0)
			expect(await d.select().from(onboardingTasks)).toHaveLength(0)
		})

		it('is refused for a hired, declined or unknown candidate and a bad position', async () => {
			const d = await db()
			const position = await addPosition()
			const archived = await addPosition('Old', true)
			const hired = await seedApplication(d, { stage: 'hired' })
			expect(
				(
					await h.operator('POST', `/applications/${hired.id}/hire`, {
						body: hireBody(position.id),
					})
				).body.error,
			).toBe('already_hired')
			const declined = await seedApplication(d, { stage: 'declined' })
			expect(
				(
					await h.operator('POST', `/applications/${declined.id}/hire`, {
						body: hireBody(position.id),
					})
				).body.error,
			).toBe('application_declined')
			const app = await seedApplication(d)
			expect(
				(
					await h.operator('POST', `/applications/${app.id}/hire`, {
						body: hireBody('missing'),
					})
				).status,
			).toBe(404)
			expect(
				(
					await h.operator('POST', `/applications/${app.id}/hire`, {
						body: hireBody(archived.id),
					})
				).body.error,
			).toBe('position_archived')
			expect(await d.select().from(staffMembers)).toHaveLength(0)
		})

		it('hiring twice never creates two people', async () => {
			const d = await db()
			const position = await addPosition()
			const app = await seedApplication(d)
			const [first, second] = await Promise.all([
				h.operator('POST', `/applications/${app.id}/hire`, {
					body: hireBody(position.id),
				}),
				h.operator('POST', `/applications/${app.id}/hire`, {
					body: hireBody(position.id),
				}),
			])
			expect([first.status, second.status].sort()).toEqual([201, 409])
			expect(await d.select().from(staffMembers)).toHaveLength(1)
		})

		it('does not create a second roster entry for someone already on it', async () => {
			const d = await db()
			const position = await addPosition()
			await d.insert(staffMembers).values({
				firstName: 'Sara',
				lastName: 'Ali',
				email: 'sara@example.com',
			})
			const app = await seedApplication(d, { email: 'sara@example.com' })
			const reply = await h.operator('POST', `/applications/${app.id}/hire`, {
				body: hireBody(position.id),
			})
			expect(reply.status).toBe(409)
			expect(reply.body.error).toBe('staff_exists')
			expect(reply.raw).not.toMatch(/staffId/)
			const [row] = await d.select().from(hiringApplications)
			expect(row?.stage).toBe('new')
		})

		it('points to a rehire when the match is a former employee', async () => {
			const d = await db()
			const position = await addPosition()
			await d.insert(staffMembers).values({
				firstName: 'Sara',
				lastName: 'Ali',
				phone: '+14155550123',
				status: 'terminated',
			})
			const app = await seedApplication(d, {
				email: null,
				phone: '+14155550123',
			})
			const reply = await h.operator('POST', `/applications/${app.id}/hire`, {
				body: hireBody(position.id),
			})
			expect(reply.body.error).toBe('staff_terminated_match')
		})

		it('reports a taken employee number and rolls back', async () => {
			const d = await db()
			const position = await addPosition()
			await d.insert(staffMembers).values({
				firstName: 'Other',
				lastName: 'Person',
				employeeNumber: 'E-1',
			})
			const app = await seedApplication(d)
			const reply = await h.operator('POST', `/applications/${app.id}/hire`, {
				body: hireBody(position.id, { employeeNumber: 'E-1' }),
			})
			expect(reply.status).toBe(409)
			expect(reply.body.error).toBe('employee_number_taken')
			expect(await d.select().from(staffMembers)).toHaveLength(1)
		})

		it('keeps a scoped manager to their own scopes', async () => {
			const d = await db()
			const position = await addPosition()
			const app = await seedApplication(d, { scopeId: LOC_1 })
			const elsewhere = await h.operator(
				'POST',
				`/applications/${app.id}/hire`,
				{
					scopeIds: [LOC_1],
					body: hireBody(position.id, { scopeId: LOC_2 }),
				},
			)
			expect(elsewhere.status).toBe(403)
			const ok = await h.operator('POST', `/applications/${app.id}/hire`, {
				scopeIds: [LOC_1],
				body: hireBody(position.id),
			})
			expect(ok.status).toBe(201)
		})

		it('validates the body strictly', async () => {
			const app = await seedApplication(await db())
			for (const body of [
				{},
				{
					scopeId: LOC_1,
					positionId: 'p',
					hiredDate: 'soon',
					currency: 'USD',
				},
				{ scopeId: LOC_1, positionId: 'p', hiredDate: '2026-10-20' },
				{
					scopeId: LOC_1,
					positionId: 'p',
					hiredDate: '2026-10-20',
					currency: 'USD',
					userId: 'u1',
				},
				{
					scopeId: LOC_1,
					positionId: 'p',
					hiredDate: '2026-10-20',
					currency: 'USD',
					payType: 'salary',
				},
				{
					scopeId: LOC_1,
					positionId: 'p',
					hiredDate: '2026-10-20',
					currency: 'USD',
					rateMinor: -5,
				},
			]) {
				const reply = await h.operator('POST', `/applications/${app.id}/hire`, {
					body,
				})
				expect(reply.status).toBe(400)
			}
		})
	})

	describe('erasure', () => {
		it('removes the application and everything under it, and keeps the audit trail without PII', async () => {
			const d = await db()
			const app = await seedApplication(d, { email: 'sara@example.com' })
			await h.operator('POST', `/applications/${app.id}/notes`, {
				body: { body: 'n' },
			})
			await h.operator('POST', `/applications/${app.id}/interviews`, {
				body: { scheduledAt: NOW + 86_400_000, sendInvite: false },
			})
			expect(await d.select().from(hiringNotes)).toHaveLength(1)
			const reply = await h.operator('DELETE', `/applications/${app.id}`)
			expect(reply.status).toBe(200)
			expect(reply.body).toEqual({ erased: true, wasHired: false })
			expect(await d.select().from(hiringApplications)).toHaveLength(0)
			expect(await d.select().from(hiringNotes)).toHaveLength(0)
			expect(await d.select().from(hiringInterviews)).toHaveLength(0)
			expect(await d.select().from(hiringEvents)).toHaveLength(0)
			const audit = await d.select().from(staffAuditLog)
			expect(
				audit.some(
					(r) =>
						r.action === 'hiring.application.erased' && r.entityId === app.id,
				),
			).toBe(true)
			expect(JSON.stringify(audit)).not.toContain('sara@example.com')
			expect((await h.operator('GET', `/applications/${app.id}`)).status).toBe(
				404,
			)
		})

		it('erasing a hired applicant removes only the application, not the person', async () => {
			const d = await db()
			const [staff] = await d
				.insert(staffMembers)
				.values({ firstName: 'Sara', lastName: 'Ali' })
				.returning()
			const app = await seedApplication(d, {
				stage: 'hired',
				hiredStaffId: staff!.id,
			})
			const reply = await h.operator('DELETE', `/applications/${app.id}`)
			expect(reply.body.wasHired).toBe(true)
			expect(await d.select().from(staffMembers)).toHaveLength(1)
		})
	})
})
