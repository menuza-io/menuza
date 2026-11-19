import { serializeJsonLd } from '@repo/common/job-posting'
import { postalAddress } from '~/lib/restaurant-jsonld'

/**
 * schema.org `Event` for a website event page (#184,
 * https://developers.google.com/search/docs/appearance/structured-data/event).
 * One `Event` per upcoming occurrence (at most 12), each with its own start
 * and end in the location's offset. Pure; public event text only.
 */
export type EventJsonLdInput = {
	url: string
	name: string
	description?: string | null
	imageUrl?: string | null
	occurrences: ReadonlyArray<{ date: string; start: string; end: string }>
	location: { name: string; address: unknown } | null
	organizer: { name: string; url: string }
	/** Where to book or buy, when the event links somewhere. */
	offerUrl?: string | null
}

type JsonObject = Record<string, unknown>

export function buildEventJsonLd(input: EventJsonLdInput): JsonObject | null {
	if (!input.occurrences.length) return null
	const place: JsonObject = input.location
		? {
				'@type': 'Place',
				name: input.location.name,
				...(() => {
					const address = postalAddress(input.location.address)
					return address ? { address } : {}
				})(),
			}
		: { '@type': 'Place', name: input.organizer.name }
	const events = input.occurrences.map((occurrence) => {
		const node: JsonObject = {
			'@type': 'Event',
			'@id': `${input.url}#${occurrence.date}`,
			name: input.name,
			startDate: occurrence.start,
			endDate: occurrence.end,
			eventStatus: 'https://schema.org/EventScheduled',
			eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
			location: place,
			organizer: { '@type': 'Organization', ...input.organizer },
			url: input.url,
		}
		if (input.description?.trim()) node.description = input.description.trim()
		if (input.imageUrl) node.image = [input.imageUrl]
		if (input.offerUrl) {
			node.offers = {
				'@type': 'Offer',
				url: input.offerUrl,
				availability: 'https://schema.org/InStock',
			}
		}
		return node
	})
	return events.length === 1
		? { '@context': 'https://schema.org', ...events[0] }
		: { '@context': 'https://schema.org', '@graph': events }
}

export function eventStructuredData(input: EventJsonLdInput): string | null {
	const data = buildEventJsonLd(input)
	return data ? serializeJsonLd(data) : null
}
