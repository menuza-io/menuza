import { type APIRoute } from 'astro'
import { loadSiteSeoData } from '~/lib/seo-data'
import { buildSitemapXml } from '~/lib/seo-files'
import {
	isRootSeoRequest,
	notFound,
	seoOrigin,
	textResponse,
} from '~/lib/seo-response'

export const prerender = false

/** Every public page of the site, in every language it is published in. */
export const GET: APIRoute = async (context) => {
	const organization = context.locals.organization
	if (!organization || !isRootSeoRequest(context)) return notFound()
	const data = await loadSiteSeoData(organization, {
		slug: context.locals.orgSlug,
		host: context.locals.customHost,
	})
	return textResponse(
		buildSitemapXml(seoOrigin(context), data.sitemap, data.locales),
		'application/xml; charset=utf-8',
	)
}
