import { type APIRoute } from 'astro'
import { buildRobotsTxt } from '~/lib/seo-files'
import {
	isRootSeoRequest,
	notFound,
	seoOrigin,
	textResponse,
} from '~/lib/seo-response'

export const prerender = false

/**
 * Per-site `robots.txt`: points crawlers at this site's sitemap, keeps account
 * and checkout pages out of search, and closes hosts with no published site.
 */
export const GET: APIRoute = (context) => {
	if (!isRootSeoRequest(context)) return notFound()
	return textResponse(
		buildRobotsTxt({
			origin: seoOrigin(context),
			indexable: context.locals.organization !== null,
		}),
		'text/plain; charset=utf-8',
	)
}
