import { describe, expect, it } from 'vitest'
import { buildEventJsonLd, eventStructuredData } from './event-jsonld'

const base = {
	url: 'https://albait.example/events/trivia',
	name: 'Trivia night',
	description: 'Teams of four',
	imageUrl: 'https://cdn.example/trivia.jpg',
	location: {
		name: 'Olaya',
		address: { city: 'Riyadh', streetName: 'Olaya St' },
	},
	organizer: { name: 'Al Bait', url: 'https://albait.example/' },
}

describe('Event structured data (#184)', () => {
	it('describes one occurrence with offsets, place and organizer', () => {
		expect(
			buildEventJsonLd({
				...base,
				occurrences: [
					{
						date: '2026-11-03',
						start: '2026-11-03T20:00:00+03:00',
						end: '2026-11-03T22:00:00+03:00',
					},
				],
				offerUrl: 'https://albait.example/reserve',
			}),
		).toEqual({
			'@context': 'https://schema.org',
			'@type': 'Event',
			'@id': 'https://albait.example/events/trivia#2026-11-03',
			name: 'Trivia night',
			description: 'Teams of four',
			image: ['https://cdn.example/trivia.jpg'],
			startDate: '2026-11-03T20:00:00+03:00',
			endDate: '2026-11-03T22:00:00+03:00',
			eventStatus: 'https://schema.org/EventScheduled',
			eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
			location: {
				'@type': 'Place',
				name: 'Olaya',
				address: {
					'@type': 'PostalAddress',
					streetAddress: 'Olaya St',
					addressLocality: 'Riyadh',
				},
			},
			organizer: {
				'@type': 'Organization',
				name: 'Al Bait',
				url: 'https://albait.example/',
			},
			url: 'https://albait.example/events/trivia',
			offers: {
				'@type': 'Offer',
				url: 'https://albait.example/reserve',
				availability: 'https://schema.org/InStock',
			},
		})
	})

	it('lists one Event per upcoming occurrence of a repeating event', () => {
		const data = buildEventJsonLd({
			...base,
			occurrences: [
				{
					date: '2026-10-27',
					start: '2026-10-27T20:00:00-04:00',
					end: '2026-10-27T22:00:00-04:00',
				},
				{
					date: '2026-11-03',
					start: '2026-11-03T20:00:00-05:00',
					end: '2026-11-03T22:00:00-05:00',
				},
			],
		})
		const graph = data!['@graph'] as Array<Record<string, unknown>>
		expect(graph.map((event) => event.startDate)).toEqual([
			'2026-10-27T20:00:00-04:00',
			'2026-11-03T20:00:00-05:00',
		])
	})

	it('has nothing to say without an occurrence and escapes for a script tag', () => {
		expect(buildEventJsonLd({ ...base, occurrences: [] })).toBeNull()
		const text = eventStructuredData({
			...base,
			name: '</script><b>',
			occurrences: [{ date: '2026-11-03', start: 'a', end: 'b' }],
		})
		expect(text).not.toContain('</script>')
	})
})
