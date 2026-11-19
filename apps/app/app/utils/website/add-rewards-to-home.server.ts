import {
	and,
	db,
	desc,
	eq,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { getDefaultConfig } from './block-types.ts'
import { HOME_PAGE_SLUG } from './home-page.ts'

/**
 * Adds a default `rewards` section to the organization's home page when loyalty
 * is activated for the first time, if one is not already present. (#295)
 */
export async function ensureHomeRewardsSection(
	organizationId: string,
): Promise<{ added: boolean; reason?: 'no_home_page' | 'already_present' }> {
	const homePage =
		(await db.query.WebsitePage.findFirst({
			where: and(
				eq(WebsitePage.organizationId, organizationId),
				eq(WebsitePage.isHomePage, true),
			),
			columns: { id: true },
		})) ??
		(await db.query.WebsitePage.findFirst({
			where: and(
				eq(WebsitePage.organizationId, organizationId),
				eq(WebsitePage.slug, HOME_PAGE_SLUG),
			),
			columns: { id: true },
		}))

	if (!homePage) {
		return { added: false, reason: 'no_home_page' }
	}

	const existing = await db
		.select({
			id: WebsitePageSection.id,
			type: WebsitePageSection.type,
			position: WebsitePageSection.position,
		})
		.from(WebsitePageSection)
		.where(eq(WebsitePageSection.pageId, homePage.id))
		.orderBy(desc(WebsitePageSection.position))

	if (existing.some((section) => section.type === 'rewards')) {
		return { added: false, reason: 'already_present' }
	}

	const maxPosition = existing[0]?.position ?? -1
	await db.insert(WebsitePageSection).values({
		pageId: homePage.id,
		type: 'rewards',
		config: JSON.stringify(getDefaultConfig('rewards')),
		position: maxPosition + 1,
	})

	return { added: true }
}
