/**
 * #85: version history, restore, discard and drafts for the header, footer and
 * theme, driven through the real page editor action and the History loader.
 */
import { AuditAction, auditService } from '@repo/audit'
import {
	and,
	db,
	eq,
	Organization,
	WebsitePage,
	WebsitePageSection,
	WebsiteVersion,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as sitesLoader } from '#app/routes/resources+/sites.ts'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { SITE_HEADER_ID } from '#app/utils/website/block-types.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
} from '#tests/test-utils.ts'
import { loader as activityLoader } from './activity.tsx'
import { action as editorAction } from './pages.$pageId.tsx'
import { loader as historyLoader } from './pages.$pageId_.history.tsx'

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
		.set({
			sitePublished: true,
			siteHeaderConfig: JSON.stringify({ navLinks: [], title: 'Live header' }),
			siteFooterConfig: JSON.stringify({ text: 'Live footer' }),
		})
		.where(eq(Organization.id, organization.id))
	const [page] = await db
		.insert(WebsitePage)
		.values({
			organizationId: organization.id,
			createdById: user.id,
			title: 'Hours',
			slug: 'hours',
		})
		.returning({ id: WebsitePage.id })
	await db.insert(WebsitePageSection).values({
		pageId: page!.id,
		type: 'text',
		position: 0,
		config: JSON.stringify({ text: 'Open 9 to 5' }),
	})
	const { cookie } = await createTestSession(user.id)
	return { organization, cookie, pageId: page!.id, userId: user.id }
}
type Ctx = Awaited<ReturnType<typeof setup>>

async function post(ctx: Ctx, fields: Record<string, string>) {
	const body = new URLSearchParams(fields)
	const response = (await editorAction({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${ctx.organization.slug}/website/pages/${ctx.pageId}`,
			{ method: 'POST', body },
			ctx.cookie,
		),
		params: { orgSlug: ctx.organization.slug, pageId: ctx.pageId },
		context: {},
	} as never)) as Response
	return {
		status: response.status,
		body: (await response.json()) as Record<string, any>,
	}
}

async function history(ctx: Ctx, query = '') {
	const response = (await historyLoader({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${ctx.organization.slug}/website/pages/${ctx.pageId}/history${query}`,
			{},
			ctx.cookie,
		),
		params: { orgSlug: ctx.organization.slug, pageId: ctx.pageId },
		context: {},
	} as never)) as unknown
	// The loader returns a plain object.
	return response as {
		versions: Array<{
			id: string
			publishedBy: string | null
			publishedAt: string
			isLive: boolean
		}>
		draftHash: string
		preview: {
			sections: Array<{ type: string; config: string }>
			missingMedia: string[]
		} | null
	}
}

const setText = (ctx: Ctx, text: string) =>
	db
		.update(WebsitePageSection)
		.set({ config: JSON.stringify({ text }) })
		.where(eq(WebsitePageSection.pageId, ctx.pageId))

const liveOf = async (ctx: Ctx) =>
	(
		await db
			.select({ publishedData: WebsitePage.publishedData })
			.from(WebsitePage)
			.where(eq(WebsitePage.id, ctx.pageId))
	)[0]!.publishedData

const draftText = async (ctx: Ctx) =>
	(
		await db
			.select({ config: WebsitePageSection.config })
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.pageId, ctx.pageId))
	).map((row) => (JSON.parse(row.config) as { text: string }).text)

describe('page versions through the editor (#85)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockReset().mockResolvedValue(true)
	})

	it('publishing creates a version shown in History with the publisher and time', async () => {
		const ctx = await setup()
		expect((await post(ctx, { intent: 'publish' })).status).toBe(200)
		const { versions } = await history(ctx)
		expect(versions).toHaveLength(1)
		expect(versions[0]!.publishedBy).toBeTruthy()
		expect(new Date(versions[0]!.publishedAt).getTime()).toBeGreaterThan(
			Date.now() - 60_000,
		)
		expect(versions[0]!.isLive).toBe(true)
	})

	it('restoring replaces the draft only; the live site changes after Publish', async () => {
		const ctx = await setup()
		await post(ctx, { intent: 'publish' })
		const firstLive = await liveOf(ctx)
		await setText(ctx, 'Open 10 to 6')
		await post(ctx, { intent: 'publish' })
		const secondLive = await liveOf(ctx)
		expect(secondLive).not.toBe(firstLive)

		const { versions, draftHash } = await history(ctx)
		const oldest = versions.at(-1)!
		const restored = await post(ctx, {
			intent: 'restore-version',
			versionId: oldest.id,
			expectedDraftHash: draftHash,
		})
		expect(restored.status).toBe(200)
		// The draft is the old content; live is untouched; no new version yet.
		expect(await draftText(ctx)).toEqual(['Open 9 to 5'])
		expect(await liveOf(ctx)).toBe(secondLive)
		expect((await history(ctx)).versions).toHaveLength(2)

		await post(ctx, { intent: 'publish' })
		expect(await liveOf(ctx)).not.toBe(secondLive)
		expect(
			(JSON.parse((await liveOf(ctx))!) as Array<{ config: string }>)[0]!
				.config,
		).toContain('9 to 5')
		expect((await history(ctx)).versions).toHaveLength(3)
	})

	it('a restore after someone else edited the draft is 409 stale_version', async () => {
		const ctx = await setup()
		await post(ctx, { intent: 'publish' })
		const { versions, draftHash } = await history(ctx)
		// Someone else edits the draft after the operator opened History.
		await setText(ctx, 'Edited by a colleague')
		const result = await post(ctx, {
			intent: 'restore-version',
			versionId: versions[0]!.id,
			expectedDraftHash: draftHash,
		})
		expect(result.status).toBe(409)
		expect(result.body.error).toBe('stale_version')
		// Their edit survived.
		expect(await draftText(ctx)).toEqual(['Edited by a colleague'])
	})

	it('cannot restore a version of another page or organization', async () => {
		const ctx = await setup()
		const other = await setup()
		await post(other, { intent: 'publish' })
		const foreign = (await history(other)).versions[0]!.id
		const { draftHash } = await history(ctx)
		const result = await post(ctx, {
			intent: 'restore-version',
			versionId: foreign,
			expectedDraftHash: draftHash,
		})
		expect(result.status).toBe(404)
	})

	it('discard returns the editor to the live content and clears the badge', async () => {
		const ctx = await setup()
		await post(ctx, { intent: 'publish' })
		const live = await liveOf(ctx)
		await setText(ctx, 'Unfinished edit')
		await post(ctx, {
			intent: 'update-section',
			sectionId: SITE_HEADER_ID,
			config: JSON.stringify({ title: 'Draft header' }),
		})
		expect(
			(
				await db
					.select({ d: Organization.draftHeaderConfig })
					.from(Organization)
					.where(eq(Organization.id, ctx.organization.id))
			)[0]!.d,
		).toContain('Draft header')

		const result = await post(ctx, { intent: 'discard-draft' })
		expect(result.status).toBe(200)
		expect(await draftText(ctx)).toEqual(['Open 9 to 5'])
		expect(await liveOf(ctx)).toBe(live)
		const org = (
			await db
				.select()
				.from(Organization)
				.where(eq(Organization.id, ctx.organization.id))
		)[0]!
		expect(org.draftHeaderConfig).toBeNull()
		// Nothing was deleted: still one version.
		expect((await history(ctx)).versions).toHaveLength(1)
	})

	it('discard on a never-published page is refused with never_published', async () => {
		const ctx = await setup()
		await setText(ctx, 'Work in progress')
		const result = await post(ctx, { intent: 'discard-draft' })
		expect(result.status).toBe(409)
		expect(result.body.error).toBe('never_published')
		expect(await draftText(ctx)).toEqual(['Work in progress'])
	})

	it('header, footer and theme edits stay off the public site until published', async () => {
		const ctx = await setup()
		await post(ctx, {
			intent: 'update-section',
			sectionId: SITE_HEADER_ID,
			config: JSON.stringify({ title: 'Draft header' }),
		})
		await post(ctx, {
			intent: 'update-site-theme',
			organizationId: ctx.organization.id,
			baseColor: 'zinc',
			theme: 'zinc',
			radius: 'large',
			mode: 'dark',
			headingFont: 'inter',
			bodyFont: 'inter',
		})
		const org = (
			await db
				.select()
				.from(Organization)
				.where(eq(Organization.id, ctx.organization.id))
		)[0]!
		expect(org.siteHeaderConfig).toContain('Live header')
		expect(org.draftHeaderConfig).toContain('Draft header')
		expect(org.siteTheme).toBeNull()
		expect(org.draftSiteTheme).toContain('"radius":"large"')

		const publicTheme = async () =>
			(
				(await (
					(await sitesLoader({
						request: new Request(
							`http://localhost/resources/sites?slug=${ctx.organization.slug}`,
						),
						params: {},
						context: {},
					} as never)) as Response
				).json()) as { theme: { radius: string; mode: string } }
			).theme
		expect((await publicTheme()).mode).toBe('light')

		// Publishing the page publishes the pending site design with it.
		await post(ctx, { intent: 'publish' })
		const after = (
			await db
				.select()
				.from(Organization)
				.where(eq(Organization.id, ctx.organization.id))
		)[0]!
		expect(after.siteHeaderConfig).toContain('Draft header')
		expect(after.draftHeaderConfig).toBeNull()
		expect((await publicTheme()).mode).toBe('dark')
		const kinds = (
			await db
				.select({ kind: WebsiteVersion.kind })
				.from(WebsiteVersion)
				.where(eq(WebsiteVersion.organizationId, ctx.organization.id))
		)
			.map((row) => row.kind)
			.sort()
		expect(kinds).toEqual(['chrome', 'page', 'theme'])
	})

	it('Branding can publish and restore the site design on its own', async () => {
		const ctx = await setup()
		await post(ctx, {
			intent: 'update-section',
			sectionId: SITE_HEADER_ID,
			config: JSON.stringify({ title: 'Header v2' }),
		})
		const published = await post(ctx, { intent: 'publish-site' })
		expect(published.body.publishedChrome).toBe(true)

		const chromeVersions = (await history(ctx, '?kind=chrome')).versions
		expect(chromeVersions).toHaveLength(1)
		await post(ctx, {
			intent: 'update-section',
			sectionId: SITE_HEADER_ID,
			config: JSON.stringify({ title: 'Header v3' }),
		})
		await post(ctx, { intent: 'publish-site' })
		const all = await history(ctx, '?kind=chrome')
		expect(all.versions).toHaveLength(2)

		const restored = await post(ctx, {
			intent: 'restore-version',
			versionId: all.versions[1]!.id,
			expectedDraftHash: all.draftHash,
		})
		expect(restored.status).toBe(200)
		const org = (
			await db
				.select()
				.from(Organization)
				.where(eq(Organization.id, ctx.organization.id))
		)[0]!
		// Restore filled the draft only; live still shows v3.
		expect(org.siteHeaderConfig).toContain('Header v3')
		expect(org.draftHeaderConfig).toContain('Header v2')
	})

	it('history preview returns the version sections and flags missing media', async () => {
		const ctx = await setup()
		await db
			.update(WebsitePageSection)
			.set({
				config: JSON.stringify({
					text: 'Menu',
					image: '/resources/images?objectKey=org%2Fgone%2Fphoto.png',
				}),
			})
			.where(eq(WebsitePageSection.pageId, ctx.pageId))
		await post(ctx, { intent: 'publish' })
		const { versions } = await history(ctx)
		const detail = await history(ctx, `?version=${versions[0]!.id}`)
		expect(detail.preview!.sections.map((s) => s.type)).toEqual([
			'header',
			'text',
			'footer',
		])
		expect(detail.preview!.missingMedia).toEqual(['org/gone/photo.png'])
	})
})

describe('website activity (#85)', () => {
	it('records publish, restore and delete with who, and Activity lists them', async () => {
		const ctx = await setup()
		const logSpy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await post(ctx, { intent: 'publish' })
		const { versions, draftHash } = await history(ctx)
		await post(ctx, {
			intent: 'restore-version',
			versionId: versions[0]!.id,
			expectedDraftHash: draftHash,
		})
		const actions = logSpy.mock.calls.map(([entry]) => entry.action)
		expect(actions).toContain(AuditAction.WEBSITE_PAGE_PUBLISHED)
		expect(actions).toContain(AuditAction.WEBSITE_VERSION_RESTORED)
		for (const [entry] of logSpy.mock.calls) {
			expect(entry.userId).toBe(ctx.userId)
			expect(entry.organizationId).toBe(ctx.organization.id)
		}
		logSpy.mockRestore()

		// The writer is a no-op under test, so seed what it would have stored and
		// read it back through the Activity screen's loader.
		const { AuditLog } = await import('@repo/database')
		for (const action of [
			AuditAction.WEBSITE_PAGE_PUBLISHED,
			AuditAction.WEBSITE_VERSION_RESTORED,
			AuditAction.WEBSITE_PAGE_DELETED,
		]) {
			await db.insert(AuditLog).values({
				action,
				details: `${action} Hours`,
				organizationId: ctx.organization.id,
				userId: ctx.userId,
				metadata: JSON.stringify({ pageId: ctx.pageId, pageTitle: 'Hours' }),
			})
		}
		await db.insert(AuditLog).values({
			action: AuditAction.USER_LOGIN,
			details: 'unrelated',
			organizationId: ctx.organization.id,
			userId: ctx.userId,
		})
		const result = (await activityLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/activity`,
				{},
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug },
			context: {},
		} as never)) as unknown as {
			entries: Array<{ action: string; userName: string | null; at: string }>
		}
		expect(result.entries.map((entry) => entry.action).sort()).toEqual(
			[
				AuditAction.WEBSITE_PAGE_DELETED,
				AuditAction.WEBSITE_PAGE_PUBLISHED,
				AuditAction.WEBSITE_VERSION_RESTORED,
			].sort(),
		)
		expect(result.entries.every((entry) => entry.userName)).toBe(true)
		expect(result.entries.every((entry) => entry.at)).toBe(true)
	})
})

describe('unpublish warns about redirects (#248)', () => {
	it('refuses until the operator confirms, then unpublishes and keeps history', async () => {
		const ctx = await setup()
		await post(ctx, { intent: 'publish' })
		const { WebsiteRedirect } = await import('@repo/database')
		await db.insert(WebsiteRedirect).values([
			{
				organizationId: ctx.organization.id,
				fromPath: '/old-hours',
				toPath: '/hours',
			},
			{
				organizationId: ctx.organization.id,
				fromPath: '/opening',
				toPath: '/hours',
			},
		])
		const warned = await post(ctx, { intent: 'unpublish' })
		expect(warned.status).toBe(409)
		expect(warned.body.error).toBe('redirects_point_here')
		expect(warned.body.redirectCount).toBe(2)
		const stillLive = (
			await db
				.select({ status: WebsitePage.status })
				.from(WebsitePage)
				.where(eq(WebsitePage.id, ctx.pageId))
		)[0]!.status
		expect(stillLive).toBe('published')

		const done = await post(ctx, {
			intent: 'unpublish',
			confirmRedirects: 'true',
		})
		expect(done.status).toBe(200)
		const rows = await db
			.select({ status: WebsitePage.status })
			.from(WebsitePage)
			.where(and(eq(WebsitePage.id, ctx.pageId)))
		expect(rows[0]!.status).toBe('draft')
	})
})
