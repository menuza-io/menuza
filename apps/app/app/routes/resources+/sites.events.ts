import { type LoaderFunctionArgs } from 'react-router'
import { getLandingFeatures } from '#app/utils/seo/landing-pages.server.ts'
import { buildPublicEventsPayload } from '#app/utils/seo/site-events.server.ts'
import { requirePublishedSiteOrganization } from '#app/utils/sites/published-org.server.ts'

/**
 * Website events (#184): `GET /resources/sites/events?slug=acme&lng=ar`
 * lists published events that have an occurrence in the next 90 days, each
 * with its next occurrences (DST-safe, at most 12). `&event=<slug>` returns
 * one event, ended ones included, so its page can say it ended and answer
 * 410 after 30 days. 404 unless the site is published and `website.events`
 * is on. Short cache: occurrences move with the clock.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const { organization, url } = await requirePublishedSiteOrganization(request)
	if (!(await getLandingFeatures(organization.id)).events) {
		throw new Response('Not Found', { status: 404 })
	}
	const eventSlug = url.searchParams.get('event')?.trim().toLowerCase() || null
	if (eventSlug && !/^[a-z0-9-]{1,80}$/.test(eventSlug)) {
		throw new Response('Not Found', { status: 404 })
	}
	const payload = await buildPublicEventsPayload(organization, {
		locale: url.searchParams.get('lng'),
		eventSlug,
	})
	if (eventSlug && !payload.events.length) {
		throw new Response('Not Found', { status: 404 })
	}
	return Response.json(payload, {
		headers: { 'Cache-Control': 'public, max-age=60' },
	})
}
