import { type APIRoute } from 'astro'
import { loadSiteSeoData } from '~/lib/seo-data'
import { buildLlmsTxt } from '~/lib/seo-files'
import {
	isRootSeoRequest,
	notFound,
	seoOrigin,
	textResponse,
} from '~/lib/seo-response'

export const prerender = false

/**
 * `llms.txt` (llmstxt.org): what AI assistants should know about the
 * restaurant, in Markdown: locations, hours, pages and the menu. Public
 * content only.
 */
export const GET: APIRoute = async (context) => {
	const organization = context.locals.organization
	if (!organization || !isRootSeoRequest(context)) return notFound()
	const data = await loadSiteSeoData(organization, {
		slug: context.locals.orgSlug,
		host: context.locals.customHost,
	})
	return textResponse(
		buildLlmsTxt({ origin: seoOrigin(context), ...data.llms }),
		'text/markdown; charset=utf-8',
	)
}
