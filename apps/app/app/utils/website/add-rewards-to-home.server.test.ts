import { db, eq, WebsitePage, WebsitePageSection } from '@repo/database'
import { describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { ensureHomeRewardsSection } from './add-rewards-to-home.server.ts'

describe('ensureHomeRewardsSection (#295)', () => {
	it('adds a rewards section to the home page once without duplicating', async () => {
		const owner = await createTestUser()
		const org = await createTestOrganization(owner.id)
		const [home] = await db
			.insert(WebsitePage)
			.values({
				organizationId: org.id,
				title: 'Home',
				slug: 'home',
				isHomePage: true,
			})
			.returning({ id: WebsitePage.id })

		await db.insert(WebsitePageSection).values({
			pageId: home!.id,
			type: 'hero',
			config: '{}',
			position: 0,
		})

		const first = await ensureHomeRewardsSection(org.id)
		expect(first).toEqual({ added: true })

		const second = await ensureHomeRewardsSection(org.id)
		expect(second).toEqual({ added: false, reason: 'already_present' })

		const sections = await db
			.select()
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.pageId, home!.id))
		expect(sections.filter((s) => s.type === 'rewards')).toHaveLength(1)
	})

	it('returns no_home_page gracefully if the org has no home page yet', async () => {
		const owner = await createTestUser()
		const org = await createTestOrganization(owner.id)
		const result = await ensureHomeRewardsSection(org.id)
		expect(result).toEqual({ added: false, reason: 'no_home_page' })
	})
})
