import { requireUserId } from '@repo/auth'
import { parseSiteThemeConfig } from '@repo/common/site-theme'
import {
	db,
	eq,
	inArray,
	Organization,
	WebsitePage,
	WebsitePageSection,
	WebsiteRedirect,
} from '@repo/database'
import { type LoaderFunctionArgs } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { buildSiteBackup } from '#app/utils/website/site-import.ts'
import { zipStore } from '#app/utils/website/zip-store.ts'

/**
 * A ZIP of the site. Form submissions are not read. Pages, theme, chrome,
 * redirects and media names only.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	const [org] = await db
		.select({
			siteTheme: Organization.siteTheme,
			siteHeaderConfig: Organization.siteHeaderConfig,
			siteFooterConfig: Organization.siteFooterConfig,
		})
		.from(Organization)
		.where(eq(Organization.id, organization.id))
		.limit(1)
	const pages = await db
		.select({
			id: WebsitePage.id,
			title: WebsitePage.title,
			slug: WebsitePage.slug,
			isHomePage: WebsitePage.isHomePage,
		})
		.from(WebsitePage)
		.where(eq(WebsitePage.organizationId, organization.id))
	const sections = pages.length
		? await db
				.select({
					pageId: WebsitePageSection.pageId,
					type: WebsitePageSection.type,
					config: WebsitePageSection.config,
					position: WebsitePageSection.position,
				})
				.from(WebsitePageSection)
				.where(
					inArray(
						WebsitePageSection.pageId,
						pages.map((page) => page.id),
					),
				)
		: []
	const redirects = await db
		.select({
			fromPath: WebsiteRedirect.fromPath,
			toPath: WebsiteRedirect.toPath,
			statusCode: WebsiteRedirect.statusCode,
		})
		.from(WebsiteRedirect)
		.where(eq(WebsiteRedirect.organizationId, organization.id))
	const backup = buildSiteBackup({
		pages: pages.map((page) => ({
			title: page.title,
			slug: page.slug,
			isHomePage: page.isHomePage,
			sections: sections
				.filter((section) => section.pageId === page.id)
				.sort((a, b) => a.position - b.position)
				.map((section) => ({
					type: section.type,
					config: JSON.parse(section.config || '{}') as Record<string, unknown>,
				})),
		})),
		theme: parseSiteThemeConfig(org?.siteTheme),
		header: org?.siteHeaderConfig ? JSON.parse(org.siteHeaderConfig) : null,
		footer: org?.siteFooterConfig ? JSON.parse(org.siteFooterConfig) : null,
		redirects: redirects.map((row) => ({
			fromPath: row.fromPath,
			toPath: row.toPath,
			statusCode: row.statusCode,
		})),
		forms: [],
		media: [],
	})
	const zip = zipStore([
		{
			name: 'site.json',
			data: new TextEncoder().encode(JSON.stringify(backup)),
		},
	])
	return new Response(Buffer.from(zip), {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="${organization.slug}-site.zip"`,
		},
	})
}
