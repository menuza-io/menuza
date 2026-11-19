import { type APIRoute } from 'astro'
import { indexNowKeyFile } from '~/lib/indexnow'
import { isRootSeoRequest, notFound, textResponse } from '~/lib/seo-response'

export const prerender = false

/**
 * The IndexNow key file (#138): `/<key>.txt` answers the site's own key, so
 * search engines can check that pings for this host come from its owner.
 * Every other `*.txt` path is a 404 (`robots.txt` and `llms.txt` are their
 * own routes).
 */
export const GET: APIRoute = (context) => {
	if (!isRootSeoRequest(context)) return notFound()
	const body = indexNowKeyFile(
		context.locals.organization?.indexNowKey,
		context.params.key,
	)
	return body === null
		? notFound()
		: textResponse(body, 'text/plain; charset=utf-8')
}
