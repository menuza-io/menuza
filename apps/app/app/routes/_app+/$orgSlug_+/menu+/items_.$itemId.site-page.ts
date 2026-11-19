/**
 * "Give this dish its own page" (#137), action only: turns the dish's
 * `/menu/<slug>` page on or off, giving it a slug the first time (never
 * `checkout` or `success`, unique in the organization). Menu write access;
 * 404 while `website.dish_pages` is off. Public business data only.
 */
import { dishSlugFor } from '@repo/common/site-landing-pages'
import { pickLocalized } from '@repo/common/site-locales'
import { and, db, eq, isNotNull, OrganizationMenuItem } from '@repo/database'
import { type ActionFunctionArgs, data } from 'react-router'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { getLandingFeatures } from '#app/utils/seo/landing-pages.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
		siteDefaultLocale: true,
	})
	await requireMenuWrite(request, organization.id)
	if (!(await getLandingFeatures(organization.id)).dishPages) {
		return data({ ok: false, error: 'not_found' }, { status: 404 })
	}
	const enabled = (await request.formData()).get('enabled') === 'true'
	const [item] = await db
		.select({
			id: OrganizationMenuItem.id,
			displayName: OrganizationMenuItem.displayName,
			siteSlug: OrganizationMenuItem.siteSlug,
		})
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.id, params.itemId ?? ''),
				eq(OrganizationMenuItem.organizationId, organization.id),
			),
		)
		.limit(1)
	if (!item)
		return data({ ok: false, error: 'item_not_found' }, { status: 404 })
	let slug = item.siteSlug
	if (enabled && !slug) {
		const taken = await db
			.select({ slug: OrganizationMenuItem.siteSlug })
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organization.id),
					isNotNull(OrganizationMenuItem.siteSlug),
				),
			)
		const locale = organization.siteDefaultLocale || 'en'
		slug = dishSlugFor(
			pickLocalized(item.displayName, 'en', locale) || item.displayName,
			new Set(taken.map((row) => row.slug ?? '')),
		)
	}
	await db
		.update(OrganizationMenuItem)
		.set({ sitePageEnabled: enabled, siteSlug: slug })
		.where(eq(OrganizationMenuItem.id, item.id))
	await purgeOrganizationSiteCache(
		organization.id,
		organization.slug,
		organization.customDomain,
	)
	return data({ ok: true, slug })
}
