import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	isSearchConsoleEnabled,
	organizationsWithSearchConsole,
	syncSearchConsole,
} from '#app/utils/seo/search-console.server.ts'
import { type Route } from './+types/jobs.search-console-sync.ts'

/**
 * Daily (shares the `0 3 * * *` trigger): for every organization connected
 * to Google Search Console with `seo.search_console` on (#138), finishes a
 * setup still waiting for verification, re-adds the property and resubmits
 * the sitemap when the site's primary host changed, and stores 28 days of
 * clicks, impressions and position plus the top queries and pages.
 * Aggregate data only; the response carries counts.
 */
export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	let synced = 0
	let failed = 0
	for (const organization of await organizationsWithSearchConsole()) {
		if (!(await isSearchConsoleEnabled(organization.id))) continue
		const result = await syncSearchConsole(organization)
		if (result.ok) synced++
		else failed++
	}
	return Response.json({ success: true, synced, failed })
}
