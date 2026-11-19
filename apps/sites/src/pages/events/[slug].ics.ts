import { buildEventIcs } from '@repo/common/site-events'
import { getLocaleHref } from '@repo/common/site-locales'
import { type APIRoute } from 'astro'
import { fetchPublishedEvents } from '~/lib/org'
import { formatAddress } from '~/lib/seo-files'

export const prerender = false

/**
 * Add to calendar (#184): `/events/<slug>.ics`, one VEVENT per upcoming
 * occurrence in UTC. 404 for an unknown or finished event.
 */
export const GET: APIRoute = async (context) => {
	const organization = context.locals.organization
	const slug = (context.params.slug ?? '').toLowerCase()
	if (!organization || !/^[a-z0-9-]{1,80}$/.test(slug)) {
		return new Response('Not Found', { status: 404 })
	}
	const locale =
		context.locals.requestedLocale || organization.defaultLocale || 'en'
	const payload = await fetchPublishedEvents({
		slug: context.locals.orgSlug,
		host: context.locals.customHost,
		lng: locale,
		event: slug,
	})
	const event = payload?.events.find((entry) => entry.slug === slug)
	if (!event || event.phase !== 'upcoming' || !event.occurrences.length) {
		return new Response('Not Found', { status: 404 })
	}
	const defaultLocale = organization.defaultLocale || 'en'
	const body = buildEventIcs({
		uid: `${organization.slug}-${event.slug}`,
		host: context.url.host,
		title: event.title,
		description: event.description,
		location: event.location
			? [event.location.name, formatAddress(event.location.address)]
					.filter(Boolean)
					.join(', ')
			: null,
		url: `${context.url.origin}${getLocaleHref(`/events/${slug}`, locale, locale, defaultLocale)}`,
		occurrences: event.occurrences.map((occurrence) => ({
			...occurrence,
			moved: false,
		})),
		nowMs: Date.now(),
	})
	return new Response(body, {
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Content-Disposition': `attachment; filename="${slug}.ics"`,
			'Cache-Control': 'public, max-age=300',
		},
	})
}
