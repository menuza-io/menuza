/**
 * #180: a scheduled page or site design goes live when its time comes, only
 * what was frozen when it was scheduled, once even with concurrent sweeps.
 */
import {
	and,
	db,
	eq,
	Notification,
	Organization,
	WebsitePage,
	WebsitePageSection,
	WebsiteScheduledPublish,
	WebsiteVersion,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	cancelSchedule,
	claimSchedule,
	isScheduleTimeValid,
	MAX_SCHEDULE_ATTEMPTS,
	publishDueSchedules,
	scheduleWebsitePublish,
} from './scheduled-publish.server.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return { ...actual, purgeOrganizationSiteCache: vi.fn() }
})

const MINUTE = 60_000

// The sweep is global, so every test starts with no schedule left by another.
beforeEach(async () => {
	await db.delete(WebsiteScheduledPublish)
})

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	const [page] = await db
		.insert(WebsitePage)
		.values({
			organizationId: organization.id,
			createdById: user.id,
			title: 'Eid hours',
			slug: 'eid-hours',
		})
		.returning({ id: WebsitePage.id })
	await db.insert(WebsitePageSection).values({
		pageId: page!.id,
		type: 'text',
		position: 0,
		config: JSON.stringify({ text: 'Closed 10th to 13th' }),
	})
	return { user, organization, pageId: page!.id }
}
type Ctx = Awaited<ReturnType<typeof setup>>

const pageRow = async (ctx: Ctx) =>
	(
		await db.select().from(WebsitePage).where(eq(WebsitePage.id, ctx.pageId))
	)[0]!

async function schedule(
	ctx: Ctx,
	at: Date,
	now = new Date('2026-12-01T10:00:00Z'),
) {
	const result = await scheduleWebsitePublish({
		organizationId: ctx.organization.id,
		userId: ctx.user.id,
		pageId: ctx.pageId,
		runAt: at,
		now,
	})
	if (!result.ok) throw new Error(result.error)
	return result
}

const NOW = new Date('2026-12-01T10:00:00Z')

describe('schedule time rules (#180)', () => {
	it('needs 5 minutes to 90 days ahead', () => {
		expect(isScheduleTimeValid(new Date(NOW.getTime() + 4 * MINUTE), NOW)).toBe(
			false,
		)
		expect(isScheduleTimeValid(new Date(NOW.getTime() + 5 * MINUTE), NOW)).toBe(
			true,
		)
		expect(
			isScheduleTimeValid(new Date(NOW.getTime() + 90 * 24 * 60 * MINUTE), NOW),
		).toBe(true)
		expect(
			isScheduleTimeValid(
				new Date(NOW.getTime() + 90 * 24 * 60 * MINUTE + 1),
				NOW,
			),
		).toBe(false)
		expect(isScheduleTimeValid(new Date(Number.NaN), NOW)).toBe(false)
	})

	it('refuses an invalid time with invalid_schedule_time and stores nothing', async () => {
		const ctx = await setup()
		const result = await scheduleWebsitePublish({
			organizationId: ctx.organization.id,
			userId: ctx.user.id,
			pageId: ctx.pageId,
			runAt: new Date(NOW.getTime() + MINUTE),
			now: NOW,
		})
		expect(result).toEqual({ ok: false, error: 'invalid_schedule_time' })
		expect(
			await db
				.select({ id: WebsiteScheduledPublish.id })
				.from(WebsiteScheduledPublish)
				.where(eq(WebsiteScheduledPublish.organizationId, ctx.organization.id)),
		).toHaveLength(0)
	})
})

describe('scheduled publish of a page (#180)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockReset().mockResolvedValue(true)
	})

	it('goes live at its time, with a version, and notifies the scheduler', async () => {
		const ctx = await setup()
		const runAt = new Date(NOW.getTime() + 10 * MINUTE)
		await schedule(ctx, runAt)
		// Not yet due.
		expect(await publishDueSchedules(new Date(runAt.getTime() - 1))).toEqual({
			published: 0,
			retried: 0,
			failed: 0,
		})
		expect((await pageRow(ctx)).status).toBe('draft')

		const ran = await publishDueSchedules(new Date(runAt.getTime() + 30_000))
		expect(ran.published).toBe(1)
		const page = await pageRow(ctx)
		expect(page.status).toBe('published')
		expect(page.publishedData).toContain('Closed 10th to 13th')
		expect(
			await db
				.select({ id: WebsiteVersion.id })
				.from(WebsiteVersion)
				.where(
					and(
						eq(WebsiteVersion.pageId, ctx.pageId),
						eq(WebsiteVersion.publishedById, ctx.user.id),
					),
				),
		).toHaveLength(1)
		expect(purgeOrganizationSiteCache).toHaveBeenCalledTimes(1)
		const notices = await db
			.select({ type: Notification.type, payload: Notification.payload })
			.from(Notification)
			.where(eq(Notification.userId, ctx.user.id))
		expect(notices).toHaveLength(1)
		expect(notices[0]!.type).toBe('website-publish-live')
		expect(notices[0]!.payload).toContain('Eid hours')
		const [row] = await db
			.select()
			.from(WebsiteScheduledPublish)
			.where(eq(WebsiteScheduledPublish.pageId, ctx.pageId))
		expect(row!.status).toBe('done')
	})

	it('edits made after scheduling are not published by the schedule', async () => {
		const ctx = await setup()
		const runAt = new Date(NOW.getTime() + 10 * MINUTE)
		await schedule(ctx, runAt)
		await db
			.update(WebsitePageSection)
			.set({ config: JSON.stringify({ text: 'Changed my mind' }) })
			.where(eq(WebsitePageSection.pageId, ctx.pageId))
		await publishDueSchedules(new Date(runAt.getTime() + MINUTE))
		const page = await pageRow(ctx)
		expect(page.publishedData).toContain('Closed 10th to 13th')
		expect(page.publishedData).not.toContain('Changed my mind')
		// The later edit is still in the draft.
		const [section] = await db
			.select({ config: WebsitePageSection.config })
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.pageId, ctx.pageId))
		expect(section!.config).toContain('Changed my mind')
	})

	it('Cancel schedule stops it and removes it from the active list', async () => {
		const ctx = await setup()
		const runAt = new Date(NOW.getTime() + 10 * MINUTE)
		await schedule(ctx, runAt)
		expect(await cancelSchedule(ctx.organization.id, ctx.pageId)).toBe(true)
		const { listActiveSchedules } =
			await import('./scheduled-publish.server.ts')
		expect(await listActiveSchedules(ctx.organization.id)).toEqual([])
		const ran = await publishDueSchedules(new Date(runAt.getTime() + MINUTE))
		expect(ran.published).toBe(0)
		expect((await pageRow(ctx)).status).toBe('draft')
		// Cancelling again is a no-op.
		expect(await cancelSchedule(ctx.organization.id, ctx.pageId)).toBe(false)
	})

	it('scheduling again replaces the earlier schedule (one per page)', async () => {
		const ctx = await setup()
		const first = await schedule(ctx, new Date(NOW.getTime() + 10 * MINUTE))
		const second = await schedule(ctx, new Date(NOW.getTime() + 60 * MINUTE))
		const rows = await db
			.select({
				id: WebsiteScheduledPublish.id,
				status: WebsiteScheduledPublish.status,
			})
			.from(WebsiteScheduledPublish)
			.where(eq(WebsiteScheduledPublish.pageId, ctx.pageId))
		expect(rows.find((row) => row.id === first.id)!.status).toBe('cancelled')
		expect(rows.find((row) => row.id === second.id)!.status).toBe('scheduled')
	})

	it('two concurrent sweeps publish once', async () => {
		const ctx = await setup()
		const runAt = new Date(NOW.getTime() + 10 * MINUTE)
		const { id } = await schedule(ctx, runAt)
		const at = new Date(runAt.getTime() + MINUTE)
		const [a, b] = await Promise.all([
			publishDueSchedules(at),
			publishDueSchedules(at),
		])
		expect(a.published + b.published).toBe(1)
		expect(
			await db
				.select({ id: WebsiteVersion.id })
				.from(WebsiteVersion)
				.where(eq(WebsiteVersion.pageId, ctx.pageId)),
		).toHaveLength(1)
		// Claiming by hand after the fact gives nothing either.
		expect(await claimSchedule(id, at)).toBeNull()
	})

	it('two callers claiming the same schedule: exactly one wins', async () => {
		const ctx = await setup()
		const runAt = new Date(NOW.getTime() + 10 * MINUTE)
		const { id } = await schedule(ctx, runAt)
		const at = new Date(runAt.getTime() + MINUTE)
		const claims = await Promise.all([
			claimSchedule(id, at),
			claimSchedule(id, at),
		])
		expect(claims.filter(Boolean)).toHaveLength(1)
	})

	it('a page deleted before the time cancels the schedule (nothing runs)', async () => {
		const ctx = await setup()
		const runAt = new Date(NOW.getTime() + 10 * MINUTE)
		await schedule(ctx, runAt)
		await db.delete(WebsitePage).where(eq(WebsitePage.id, ctx.pageId))
		const ran = await publishDueSchedules(new Date(runAt.getTime() + MINUTE))
		expect(ran).toEqual({ published: 0, retried: 0, failed: 0 })
		expect(
			await db
				.select({ id: WebsiteScheduledPublish.id })
				.from(WebsiteScheduledPublish)
				.where(eq(WebsiteScheduledPublish.organizationId, ctx.organization.id)),
		).toHaveLength(0)
	})

	it('a failing publish retries on the sweep and stops after 3 with a notice', async () => {
		const ctx = await setup()
		const runAt = new Date(NOW.getTime() + 10 * MINUTE)
		const { id } = await schedule(ctx, runAt)
		// Damage the frozen snapshot so applying it keeps failing... for a page
		// the snapshot is lenient, so break the page link instead: point the
		// schedule at an organization-mismatched page lookup.
		await db
			.update(WebsiteScheduledPublish)
			.set({ organizationId: (await setup()).organization.id })
			.where(eq(WebsiteScheduledPublish.id, id))
		const sweepAt = (n: number) => new Date(runAt.getTime() + n * 60 * MINUTE)
		const first = await publishDueSchedules(sweepAt(1))
		expect(first).toEqual({ published: 0, retried: 1, failed: 0 })
		expect((await pageRow(ctx)).status).toBe('draft')
		const second = await publishDueSchedules(sweepAt(2))
		expect(second.retried).toBe(1)
		const third = await publishDueSchedules(sweepAt(3))
		expect(third.failed).toBe(1)
		const [row] = await db
			.select()
			.from(WebsiteScheduledPublish)
			.where(eq(WebsiteScheduledPublish.id, id))
		expect(row!.status).toBe('failed')
		expect(row!.attempts).toBe(MAX_SCHEDULE_ATTEMPTS)
		expect(row!.lastError).toBeTruthy()
		// Stopped: a later sweep does not try again.
		expect((await publishDueSchedules(sweepAt(4))).failed).toBe(0)
		const notices = await db
			.select({ type: Notification.type })
			.from(Notification)
			.where(eq(Notification.userId, ctx.user.id))
		expect(notices.map((n) => n.type)).toEqual(['website-publish-failed'])
	})

	it('a claim abandoned by a dead worker is handed back to the sweep', async () => {
		const ctx = await setup()
		const runAt = new Date(NOW.getTime() + 10 * MINUTE)
		const { id } = await schedule(ctx, runAt)
		await claimSchedule(id, new Date(runAt.getTime() + MINUTE))
		// Fifteen minutes later nobody finished it.
		const ran = await publishDueSchedules(
			new Date(runAt.getTime() + 16 * MINUTE),
		)
		expect(ran.published).toBe(1)
		expect((await pageRow(ctx)).status).toBe('published')
	})
})

describe('scheduled publish of the site design (#180)', () => {
	it('freezes the pending header and theme; later edits stay drafts', async () => {
		const ctx = await setup()
		await db
			.update(Organization)
			.set({
				siteHeaderConfig: '{"v":"live"}',
				siteFooterConfig: '{"v":"live-footer"}',
				draftHeaderConfig: '{"v":"scheduled"}',
				draftSiteTheme: '{"radius":"large"}',
			})
			.where(eq(Organization.id, ctx.organization.id))
		const runAt = new Date(NOW.getTime() + 10 * MINUTE)
		const scheduled = await scheduleWebsitePublish({
			organizationId: ctx.organization.id,
			userId: ctx.user.id,
			pageId: null,
			runAt,
			now: NOW,
		})
		expect(scheduled.ok).toBe(true)
		// An edit after scheduling.
		await db
			.update(Organization)
			.set({ draftHeaderConfig: '{"v":"later edit"}' })
			.where(eq(Organization.id, ctx.organization.id))

		await publishDueSchedules(new Date(runAt.getTime() + MINUTE))
		const org = (
			await db
				.select()
				.from(Organization)
				.where(eq(Organization.id, ctx.organization.id))
		)[0]!
		expect(org.siteHeaderConfig).toBe('{"v":"scheduled"}')
		expect(org.siteFooterConfig).toBe('{"v":"live-footer"}')
		expect(org.siteTheme).toBe('{"radius":"large"}')
		// The later edit was not published and is still the draft; the theme
		// draft equal to what went live is cleared.
		expect(org.draftHeaderConfig).toBe('{"v":"later edit"}')
		expect(org.draftSiteTheme).toBeNull()
		const kinds = (
			await db
				.select({ kind: WebsiteVersion.kind })
				.from(WebsiteVersion)
				.where(eq(WebsiteVersion.organizationId, ctx.organization.id))
		)
			.map((row) => row.kind)
			.sort()
		expect(kinds).toEqual(['chrome', 'theme'])
	})

	it('has nothing to schedule without draft changes', async () => {
		const ctx = await setup()
		const result = await scheduleWebsitePublish({
			organizationId: ctx.organization.id,
			userId: ctx.user.id,
			pageId: null,
			runAt: new Date(NOW.getTime() + 10 * MINUTE),
			now: NOW,
		})
		expect(result).toEqual({ ok: false, error: 'nothing_to_publish' })
	})
})
