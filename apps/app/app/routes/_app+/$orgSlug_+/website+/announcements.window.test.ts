/**
 * #238 through the real announcements route: the window is entered in the
 * site's time zone and stored in UTC, "until" must follow "from", the public
 * payload carries the window for the site to decide per request, and an
 * announcement with no dates behaves as before.
 */
import {
	activeAnnouncements,
	announcementIsInWindow,
} from '@repo/common/announcement-window'
import { db, eq, Organization, OrganizationAnnouncement } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as sitesLoader } from '#app/routes/resources+/sites.ts'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
} from '#tests/test-utils.ts'
import { action, loader } from './announcements.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return {
		...actual,
		purgeOrganizationSiteCache: vi.fn(),
		getSiteCacheVersion: vi.fn().mockResolvedValue(null),
	}
})

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	await db
		.update(Organization)
		.set({ sitePublished: true, staffingTimeZone: 'America/New_York' })
		.where(eq(Organization.id, organization.id))
	const { cookie } = await createTestSession(user.id)
	return { organization, cookie }
}
type Ctx = Awaited<ReturnType<typeof setup>>

async function create(ctx: Ctx, extra: Record<string, string>) {
	const response = (await action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${ctx.organization.slug}/website/announcements`,
			{
				method: 'POST',
				body: new URLSearchParams({
					intent: 'create-announcement',
					organizationId: ctx.organization.id,
					contentJson: JSON.stringify({ en: 'Closed for Eid' }),
					defaultLocale: 'en',
					type: 'info',
					isEnabled: 'true',
					...extra,
				}),
			},
			ctx.cookie,
		),
		params: { orgSlug: ctx.organization.slug },
		context: {},
	} as never)) as Response
	return {
		status: response.status,
		body: (await response.json()) as Record<string, any>,
	}
}

const rows = (ctx: Ctx) =>
	db
		.select()
		.from(OrganizationAnnouncement)
		.where(eq(OrganizationAnnouncement.organizationId, ctx.organization.id))

const publicAnnouncements = async (ctx: Ctx) =>
	(
		(await (
			(await sitesLoader({
				request: new Request(
					`http://localhost/resources/sites?slug=${ctx.organization.slug}`,
				),
				params: {},
				context: {},
			} as never)) as Response
		).json()) as {
			announcements: Array<{
				content: string
				startsAt: string | null
				endsAt: string | null
			}>
		}
	).announcements

describe('announcement window through the editor (#238)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockReset().mockResolvedValue(true)
	})

	it('stores the window entered in the site time zone as UTC', async () => {
		const ctx = await setup()
		// 10 March 2026, after the US spring-forward: New York is UTC-4 (EDT).
		const result = await create(ctx, {
			startsAtLocal: '2026-03-10T09:00',
			endsAtLocal: '2026-03-13T23:00',
		})
		expect(result.status).toBe(200)
		const [row] = await rows(ctx)
		expect(row!.startsAt!.toISOString()).toBe('2026-03-10T13:00:00.000Z')
		expect(row!.endsAt!.toISOString()).toBe('2026-03-14T03:00:00.000Z')
		expect(purgeOrganizationSiteCache).toHaveBeenCalled()
	})

	it('uses the offset in force on that date (winter and summer)', async () => {
		const ctx = await setup()
		await create(ctx, {
			startsAtLocal: '2026-01-15T09:00',
			endsAtLocal: '2026-07-15T09:00',
		})
		const [row] = await rows(ctx)
		expect(row!.startsAt!.toISOString()).toBe('2026-01-15T14:00:00.000Z')
		expect(row!.endsAt!.toISOString()).toBe('2026-07-15T13:00:00.000Z')
	})

	it('refuses "until" at or before "from"', async () => {
		const ctx = await setup()
		for (const endsAtLocal of ['2026-03-10T09:00', '2026-03-09T09:00']) {
			const result = await create(ctx, {
				startsAtLocal: '2026-03-10T09:00',
				endsAtLocal,
			})
			// The form's own validation answers with an error body.
			expect(result.body.status).toBe('error')
		}
		expect(await rows(ctx)).toHaveLength(0)
	})

	it('refuses a wall-clock time that does not exist (skipped hour)', async () => {
		const ctx = await setup()
		// 02:30 on 8 March 2026 does not exist in New York.
		const result = await create(ctx, { startsAtLocal: '2026-03-08T02:30' })
		expect(result.status).toBe(400)
		expect(await rows(ctx)).toHaveLength(0)
	})

	it('an announcement with no dates behaves as before', async () => {
		const ctx = await setup()
		expect((await create(ctx, {})).status).toBe(200)
		const [row] = await rows(ctx)
		expect(row!.startsAt).toBeNull()
		expect(row!.endsAt).toBeNull()
		const published = await publicAnnouncements(ctx)
		expect(published).toHaveLength(1)
		expect(published[0]).toMatchObject({ startsAt: null, endsAt: null })
		expect(activeAnnouncements(published, Date.now())).toHaveLength(1)
		expect(activeAnnouncements(published, Date.now() + 10 ** 12)).toHaveLength(
			1,
		)
		// The list says it is showing.
		const data = (await loader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/announcements`,
				{},
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug },
			context: {},
		} as never)) as unknown as {
			timeZone: string
			announcements: Array<{ status: string }>
		}
		expect(data.timeZone).toBe('America/New_York')
		expect(data.announcements.map((a) => a.status)).toEqual(['showing'])
	})

	it('appears at its start and disappears at its end with no republish', async () => {
		const ctx = await setup()
		await create(ctx, {
			startsAtLocal: '2026-03-10T09:00',
			endsAtLocal: '2026-03-13T23:00',
		})
		// The public payload is built once; only the clock changes below.
		const published = await publicAnnouncements(ctx)
		expect(published[0]!.startsAt).toBe('2026-03-10T13:00:00.000Z')
		expect(published[0]!.endsAt).toBe('2026-03-14T03:00:00.000Z')
		const at = (iso: string) => Date.parse(iso)
		expect(
			announcementIsInWindow(published[0]!, at('2026-03-10T12:59:59Z')),
		).toBe(false)
		expect(
			announcementIsInWindow(published[0]!, at('2026-03-10T13:00:00Z')),
		).toBe(true)
		expect(
			announcementIsInWindow(published[0]!, at('2026-03-14T02:59:59Z')),
		).toBe(true)
		expect(
			announcementIsInWindow(published[0]!, at('2026-03-14T03:00:00Z')),
		).toBe(false)
	})

	it('lists Scheduled, Showing and Ended, and an ended one can be reused', async () => {
		const ctx = await setup()
		const now = Date.now()
		const day = 86_400_000
		await db.insert(OrganizationAnnouncement).values([
			{
				organizationId: ctx.organization.id,
				content: JSON.stringify({ en: 'Soon' }),
				startsAt: new Date(now + day),
				position: 1,
			},
			{
				organizationId: ctx.organization.id,
				content: JSON.stringify({ en: 'Now' }),
				startsAt: new Date(now - day),
				endsAt: new Date(now + day),
				position: 2,
			},
			{
				organizationId: ctx.organization.id,
				content: JSON.stringify({ en: 'Was' }),
				endsAt: new Date(now - day),
				position: 3,
			},
		])
		const data = (await loader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/announcements`,
				{},
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug },
			context: {},
		} as never)) as unknown as {
			announcements: Array<{ content: { en: string }; status: string }>
		}
		expect(
			Object.fromEntries(
				data.announcements.map((a) => [a.content.en, a.status]),
			),
		).toEqual({ Soon: 'scheduled', Now: 'showing', Was: 'ended' })
		// Ended announcements are kept: still there, still editable.
		expect(await rows(ctx)).toHaveLength(3)
		// An ended one is not on the public site.
		const published = await publicAnnouncements(ctx)
		expect(activeAnnouncements(published, now).map((a) => a.content)).toEqual([
			'Now',
		])
	})
})
