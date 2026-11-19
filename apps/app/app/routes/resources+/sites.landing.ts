import { type LoaderFunctionArgs } from 'react-router'
import { buildPublicLandingPayload } from '#app/utils/seo/landing-pages.server.ts'
import {
	getCachedSiteData,
	getSiteCacheVersion,
	getSiteKvKey,
	setCachedSiteData,
} from '#app/utils/sites/kv-cache.server.ts'
import { requirePublishedSiteOrganization } from '#app/utils/sites/published-org.server.ts'

/**
 * Generated website pages (#137): `GET /resources/sites/landing?slug=acme`
 * (or `?host=`). Location pages, the slugs of locations whose page is gone
 * (410), dish pages switched on and delivery area pages. Public business data
 * only, cached like the menu and dropped on every site cache purge.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const { organization } = await requirePublishedSiteOrganization(request)
	const version = await getSiteCacheVersion(organization.id)
	const key =
		version === null
			? null
			: getSiteKvKey('page', organization.id, 'landing', version)
	let payload = key ? await getCachedSiteData(key) : null
	if (!payload) {
		payload = await buildPublicLandingPayload(organization)
		if (key && version !== null) {
			await setCachedSiteData(key, payload, {
				orgId: organization.id,
				version,
			})
		}
	}
	return Response.json(payload, {
		headers: {
			'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
		},
	})
}
