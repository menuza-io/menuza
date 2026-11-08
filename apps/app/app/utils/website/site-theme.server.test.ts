import { parseSiteThemeConfig } from '@repo/common/site-theme'
import { db, eq, Organization, WebsitePage } from '@repo/database'
import { describe, expect, it } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { buildPublishWebsitePageUpdate } from './publish-page.server.ts'
import { SiteThemeConflictError, updateSiteTheme } from './site-theme.server.ts'

async function readTheme(organizationId: string) {
	const [org] = await db
		.select({ siteTheme: Organization.siteTheme })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
	return parseSiteThemeConfig(org?.siteTheme)
}

/** Another save that lands between this save's read and its write. */
async function concurrentSave(organizationId: string, mode: 'light' | 'dark') {
	const current = await readTheme(organizationId)
	await db
		.update(Organization)
		.set({ siteTheme: JSON.stringify({ ...current, mode }) })
		.where(eq(Organization.id, organizationId))
}

describe('updateSiteTheme', () => {
	it('does not lose a save that lands between the read and the write', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		let raced = false
		await updateSiteTheme(
			organization.id,
			(current) => ({ ...current, radius: 'none' }),
			// Runs after this save read the theme and before it writes.
			async () => {
				if (!raced) {
					raced = true
					await concurrentSave(organization.id, 'dark')
				}
				return []
			},
		)
		const theme = await readTheme(organization.id)
		expect(theme.radius).toBe('none')
		expect(theme.mode).toBe('dark')
	})

	it('publishes the page and the theme together, or neither', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const [page] = await db
			.insert(WebsitePage)
			.values({
				organizationId: organization.id,
				createdById: user.id,
				title: 'Home',
				slug: `home-${Date.now()}`,
				status: 'draft',
			} as never)
			.returning()
		let mode: 'light' | 'dark' = 'light'
		await expect(
			updateSiteTheme(
				organization.id,
				(current) => ({ ...current, radius: 'none' }),
				async (themeUnchanged) => {
					// Every attempt loses the race.
					mode = mode === 'light' ? 'dark' : 'light'
					const { update } = await buildPublishWebsitePageUpdate(
						page!.id,
						db,
						themeUnchanged,
					)
					await concurrentSave(organization.id, mode)
					return [update]
				},
			),
		).rejects.toBeInstanceOf(SiteThemeConflictError)
		const [after] = await db
			.select({ status: WebsitePage.status })
			.from(WebsitePage)
			.where(eq(WebsitePage.id, page!.id))
		expect(after?.status).toBe('draft')
		expect((await readTheme(organization.id)).radius).not.toBe('none')
	})
})
