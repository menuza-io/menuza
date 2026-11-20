import { CUSTOMER_APP_SLUG } from '@repo/common/customer-app'
import { type LoaderFunctionArgs } from 'react-router'
import { loadBuildConfig } from '#app/utils/customer-apps/service.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * The build pipeline's read of one app's config (#156): the same fields
 * `apps/customer/tenants/<slug>.json` holds, taken from the registry. Internal
 * token only. The answer is public branding, bundle ids and endpoints: no
 * credentials, no guest data.
 *
 * `GET /resources/customer-app/config?slug=acme`
 */
export async function loader({ request }: LoaderFunctionArgs) {
	await requireInternalCommandAuth(request)
	const slug = new URL(request.url).searchParams.get('slug')?.trim() ?? ''
	if (!CUSTOMER_APP_SLUG.test(slug)) {
		return Response.json({ error: 'not_found' }, { status: 404 })
	}
	const config = await loadBuildConfig(slug)
	if (!config) return Response.json({ error: 'not_found' }, { status: 404 })
	return Response.json(config, { headers: { 'Cache-Control': 'no-store' } })
}
