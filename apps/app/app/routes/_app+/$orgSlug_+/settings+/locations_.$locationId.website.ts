/**
 * One location's website settings, action only (the location page loader
 * reads them):
 *
 * - `update-location-page` (#137): the `/locations/<slug>` page switch,
 *   intro per site language, title and description. `update:website:any`.
 * - `update-location-cuisine` (#182): cuisine and price range override.
 *   `update:settings:any`, like the rest of the location's settings.
 *
 * Public business data only. The site cache is purged so the page, the
 * sitemap and the structured data follow at once.
 */
import {
	parseSiteLocalesConfig,
	serializeLocalizedString,
} from '@repo/common/site-locales'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { type ActionFunctionArgs, data } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { parseCuisineForm } from '#app/utils/seo/cuisine-form.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	const formData = await request.formData()
	const intent = String(formData.get('intent') ?? '')
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		intent === 'update-location-cuisine'
			? ORG_PERMISSIONS.UPDATE_SETTINGS_ANY
			: ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	const where = and(
		eq(OrganizationLocation.id, params.locationId ?? ''),
		eq(OrganizationLocation.organizationId, organization.id),
	)

	let set: Partial<typeof OrganizationLocation.$inferInsert>
	if (intent === 'update-location-cuisine') {
		const parsed = parseCuisineForm(formData)
		if (!parsed.ok)
			return data({ ok: false, error: parsed.error }, { status: 400 })
		set = { cuisines: parsed.cuisines, priceRange: parsed.priceRange }
	} else if (intent === 'update-location-page') {
		const { locales } = parseSiteLocalesConfig(
			organization.siteLocales,
			organization.siteDefaultLocale,
		)
		const intro: Record<string, string> = {}
		for (const locale of locales) {
			const value = String(formData.get(`intro.${locale}`) ?? '').slice(0, 2000)
			if (value.trim()) intro[locale] = value
		}
		const text = (name: string, max: number) => {
			const value = String(formData.get(name) ?? '')
				.trim()
				.slice(0, max)
			return value || null
		}
		set = {
			sitePageEnabled: formData.get('pageEnabled') !== 'false',
			siteIntro: Object.keys(intro).length
				? serializeLocalizedString(intro)
				: null,
			siteSeoTitle: text('seoTitle', 120),
			siteSeoDescription: text('seoDescription', 300),
		}
	} else {
		return data({ ok: false, error: 'invalid_intent' }, { status: 400 })
	}

	const updated = await db
		.update(OrganizationLocation)
		.set(set)
		.where(where)
		.returning({ id: OrganizationLocation.id })
	if (!updated.length) {
		return data({ ok: false, error: 'location_not_found' }, { status: 404 })
	}
	await purgeOrganizationSiteCache(
		organization.id,
		organization.slug,
		organization.customDomain,
	)
	return data({ ok: true, error: null })
}
