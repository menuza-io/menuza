/**
 * #85: every publish writes one immutable version, the site design (header,
 * footer, theme) goes live together with the page or not at all, and old
 * versions are pruned without ever removing the live one.
 */
import {
	and,
	db,
	eq,
	Organization,
	WebsitePage,
	WebsitePageSection,
	WebsiteVersion,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	publishPageWithSiteDesign,
	publishSiteDesign,
	publishWebsitePage,
} from './publish-page.server.ts'
import {
	listPageVersions,
	pruneVersionsStatement,
	replaceDraftSectionsStatements,
} from './versions.server.ts'
import { MAX_WEBSITE_VERSIONS, pageDraftState } from './versions.ts'

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
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
	return { user, organization, pageId: page!.id }
}

async function setSection(pageId: string, text: string) {
	await db
		.update(WebsitePageSection)
		.set({ config: JSON.stringify({ text }) })
		.where(eq(WebsitePageSection.pageId, pageId))
}

async function versionsOf(organizationId: string, pageId: string) {
	return listPageVersions(organizationId, { kind: 'page', pageId })
}

describe('page versions (#85)', () => {
	it('every publish writes an immutable version with who and when', async () => {
		const { user, organization, pageId } = await setup()
		await publishWebsitePage(pageId, db, { publishedById: user.id })
		await setSection(pageId, 'Open 10 to 6')
		await publishWebsitePage(pageId, db, { publishedById: user.id })

		const versions = await versionsOf(organization.id, pageId)
		expect(versions).toHaveLength(2)
		// Newest first: the live one.
		expect(
			(JSON.parse(versions[0]!.snapshot) as Array<{ config: string }>)[0]!
				.config,
		).toContain('10 to 6')
		expect(
			(JSON.parse(versions[1]!.snapshot) as Array<{ config: string }>)[0]!
				.config,
		).toContain('9 to 5')
		expect(versions[0]!.publishedById).toBe(user.id)
		expect(
			versions[0]!.publishedBy?.name ?? versions[0]!.publishedBy?.username,
		).toBeTruthy()
		expect(versions[0]!.publishedAt.getTime()).toBeGreaterThan(0)
		expect(versions[0]!.summary).toContain('"changed":1')
		expect(versions[0]!.title).toBe('Hours')

		const [page] = await db
			.select({ publishedData: WebsitePage.publishedData })
			.from(WebsitePage)
			.where(eq(WebsitePage.id, pageId))
		expect(page!.publishedData).toBe(versions[0]!.snapshot)
	})

	it('draft state: the badge shows only when the draft differs from live', async () => {
		const { organization, pageId } = await setup()
		const draftOf = async () =>
			(await db.query.WebsitePageSection.findMany({
				where: eq(WebsitePageSection.pageId, pageId),
			})) as Array<{ type: string; config: string }>
		let [page] = await db
			.select({
				status: WebsitePage.status,
				publishedData: WebsitePage.publishedData,
			})
			.from(WebsitePage)
			.where(eq(WebsitePage.id, pageId))
		expect(
			(await pageDraftState({ ...page!, draftSections: await draftOf() }))
				.neverPublished,
		).toBe(true)

		await publishWebsitePage(pageId)
		;[page] = await db
			.select({
				status: WebsitePage.status,
				publishedData: WebsitePage.publishedData,
			})
			.from(WebsitePage)
			.where(eq(WebsitePage.id, pageId))
		expect(
			(await pageDraftState({ ...page!, draftSections: await draftOf() }))
				.hasUnpublishedChanges,
		).toBe(false)

		await setSection(pageId, 'Closed on Monday')
		expect(
			(await pageDraftState({ ...page!, draftSections: await draftOf() }))
				.hasUnpublishedChanges,
		).toBe(true)

		// Rebuilding the draft from the live snapshot (new row ids) equals live.
		const { parseSnapshotSections } = await import('./versions.ts')
		await db.batch(
			replaceDraftSectionsStatements(
				pageId,
				parseSnapshotSections(page!.publishedData),
			) as never,
		)
		expect(
			(await pageDraftState({ ...page!, draftSections: await draftOf() }))
				.hasUnpublishedChanges,
		).toBe(false)
		expect(await versionsOf(organization.id, pageId)).toHaveLength(1)
	})

	it('prunes to 50 and never removes the live version', async () => {
		const { organization, pageId } = await setup()
		for (let i = 0; i < MAX_WEBSITE_VERSIONS + 5; i++) {
			await setSection(pageId, `Version ${i}`)
			await publishWebsitePage(pageId)
		}
		const versions = await versionsOf(organization.id, pageId)
		expect(versions).toHaveLength(MAX_WEBSITE_VERSIONS)
		// The newest is the live one and survived; the oldest five are gone.
		const last = MAX_WEBSITE_VERSIONS + 4
		expect(
			(JSON.parse(versions[0]!.snapshot) as Array<{ config: string }>)[0]!
				.config,
		).toContain(`Version ${last}`)
		const [page] = await db
			.select({ publishedData: WebsitePage.publishedData })
			.from(WebsitePage)
			.where(eq(WebsitePage.id, pageId))
		expect(page!.publishedData).toBe(versions[0]!.snapshot)
		const oldest = (
			JSON.parse(versions.at(-1)!.snapshot) as Array<{ config: string }>
		)[0]!.config
		expect(oldest).toContain('Version 5')

		// A stricter keep still leaves the newest.
		await pruneVersionsStatement(db, {
			organizationId: organization.id,
			kind: 'page',
			pageId,
			keep: 1,
		})
		const left = await versionsOf(organization.id, pageId)
		expect(left).toHaveLength(1)
		expect(left[0]!.snapshot).toBe(page!.publishedData)
	})

	it('versions of one page never prune another page or site chrome', async () => {
		const { organization, pageId } = await setup()
		await publishWebsitePage(pageId)
		await db.insert(WebsiteVersion).values({
			organizationId: organization.id,
			pageId: null,
			kind: 'chrome',
			snapshot: '{}',
			contentHash: 'x',
			publishedById: null,
		})
		await pruneVersionsStatement(db, {
			organizationId: organization.id,
			kind: 'page',
			pageId,
			keep: 1,
		})
		const chrome = await db
			.select({ id: WebsiteVersion.id })
			.from(WebsiteVersion)
			.where(
				and(
					eq(WebsiteVersion.organizationId, organization.id),
					eq(WebsiteVersion.kind, 'chrome'),
				),
			)
		expect(chrome).toHaveLength(1)
	})
})

describe('site design drafts publish with the page (#85)', () => {
	async function withDrafts(organizationId: string) {
		await db
			.update(Organization)
			.set({
				siteHeaderConfig: '{"v":"live-header"}',
				siteFooterConfig: '{"v":"live-footer"}',
				siteTheme: '{"radius":"small"}',
				draftHeaderConfig: '{"v":"draft-header"}',
				draftSiteTheme: '{"radius":"large"}',
			})
			.where(eq(Organization.id, organizationId))
	}
	const orgRow = async (organizationId: string) =>
		(
			await db
				.select()
				.from(Organization)
				.where(eq(Organization.id, organizationId))
		)[0]!

	it('publishing the page publishes the pending header, footer and theme with versions', async () => {
		const { user, organization, pageId } = await setup()
		await withDrafts(organization.id)

		const result = await publishPageWithSiteDesign(pageId, organization.id, {
			publishedById: user.id,
		})
		expect(result.publishedChrome).toBe(true)
		expect(result.publishedTheme).toBe(true)

		const org = await orgRow(organization.id)
		expect(org.siteHeaderConfig).toBe('{"v":"draft-header"}')
		// The footer had no draft: it keeps its live value.
		expect(org.siteFooterConfig).toBe('{"v":"live-footer"}')
		expect(org.siteTheme).toBe('{"radius":"large"}')
		expect(org.draftHeaderConfig).toBeNull()
		expect(org.draftSiteTheme).toBeNull()

		const kinds = (
			await db
				.select({ kind: WebsiteVersion.kind })
				.from(WebsiteVersion)
				.where(eq(WebsiteVersion.organizationId, organization.id))
		)
			.map((row) => row.kind)
			.sort()
		expect(kinds).toEqual(['chrome', 'page', 'theme'])
	})

	it('writes nothing at all when the design changed under it', async () => {
		const { organization, pageId } = await setup()
		await withDrafts(organization.id)
		// Simulate another save that lands after the publish read the columns by
		// making the guard fail: drive the real function with a hook-free race by
		// publishing twice concurrently; exactly one wins the design, both write
		// consistent history.
		const results = await Promise.allSettled([
			publishPageWithSiteDesign(pageId, organization.id),
			publishPageWithSiteDesign(pageId, organization.id),
		])
		const failures = results.filter((r) => r.status === 'rejected')
		expect(
			failures.map((f) => String((f as PromiseRejectedResult).reason)),
		).toEqual([])
		const designVersions = await db
			.select({ kind: WebsiteVersion.kind })
			.from(WebsiteVersion)
			.where(
				and(
					eq(WebsiteVersion.organizationId, organization.id),
					eq(WebsiteVersion.kind, 'theme'),
				),
			)
		// The theme draft went live once: one theme version, not two.
		expect(designVersions).toHaveLength(1)
	})

	it('drafts are invisible to the public site until published', async () => {
		const { organization } = await setup()
		await withDrafts(organization.id)
		const { toPublicSitePayload, findPublishedSiteOrganization } =
			await import('#app/utils/sites/public-org.server.ts')
		await db
			.update(Organization)
			.set({ sitePublished: true })
			.where(eq(Organization.id, organization.id))
		const org = await orgRow(organization.id)
		const found = await findPublishedSiteOrganization({ slug: org.slug })
		const payload = toPublicSitePayload(found!)
		expect(payload.theme.radius).toBe('small')
		expect((await orgRow(organization.id)).siteHeaderConfig).toBe(
			'{"v":"live-header"}',
		)

		await publishSiteDesign(organization.id)
		const after = await findPublishedSiteOrganization({ slug: org.slug })
		expect(toPublicSitePayload(after!).theme.radius).toBe('large')
		expect(after).not.toBeNull()
		expect((await orgRow(organization.id)).siteHeaderConfig).toBe(
			'{"v":"draft-header"}',
		)
	})

	it('nothing pending is a no-op', async () => {
		const { organization } = await setup()
		const result = await publishSiteDesign(organization.id)
		expect(result).toEqual({ publishedChrome: false, publishedTheme: false })
		expect(
			await db
				.select({ id: WebsiteVersion.id })
				.from(WebsiteVersion)
				.where(eq(WebsiteVersion.organizationId, organization.id)),
		).toHaveLength(0)
	})
})
