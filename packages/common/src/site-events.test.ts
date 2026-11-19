import { describe, expect, it } from 'vitest'
import {
	buildEventIcs,
	eventPhase,
	expandOccurrences,
	lastOccurrenceEndMs,
	nextOccurrence,
	slugifyTitle,
	validateEventTimes,
	type SiteEventSchedule,
} from './site-events.ts'

const trivia: SiteEventSchedule = {
	// Tuesday 20 October 2026, 20:00 in New York (EDT, -04:00).
	startLocal: '2026-10-20T20:00',
	endLocal: '2026-10-20T22:30',
	timezone: 'America/New_York',
	recurrence: { frequency: 'weekly', weekdays: [2], interval: 1 },
}

describe('expandOccurrences', () => {
	it('keeps a weekly event at 20:00 local across the DST change', () => {
		const occurrences = expandOccurrences(trivia, {
			fromMs: Date.parse('2026-10-01T00:00:00Z'),
			limit: 4,
		})
		expect(occurrences.map((o) => o.start)).toEqual([
			'2026-10-20T20:00:00-04:00',
			'2026-10-27T20:00:00-04:00',
			// US clocks go back on 1 November 2026.
			'2026-11-03T20:00:00-05:00',
			'2026-11-10T20:00:00-05:00',
		])
		expect(occurrences.map((o) => o.end)).toEqual([
			'2026-10-20T22:30:00-04:00',
			'2026-10-27T22:30:00-04:00',
			'2026-11-03T22:30:00-05:00',
			'2026-11-10T22:30:00-05:00',
		])
	})

	it('also holds across the spring change in Europe', () => {
		const occurrences = expandOccurrences(
			{
				startLocal: '2027-03-19T19:00',
				endLocal: '2027-03-19T21:00',
				timezone: 'Europe/London',
				recurrence: { frequency: 'weekly', weekdays: [5], interval: 1 },
			},
			{ fromMs: 0, limit: 3 },
		)
		expect(occurrences.map((o) => o.start)).toEqual([
			'2027-03-19T19:00:00+00:00',
			'2027-03-26T19:00:00+00:00',
			'2027-04-02T19:00:00+01:00',
		])
	})

	it('hides only a skipped date and moves one occurrence', () => {
		const occurrences = expandOccurrences(
			{
				...trivia,
				exceptions: {
					skipped: ['2026-10-27'],
					moved: [{ date: '2026-11-03', start: '18:00', end: '19:00' }],
				},
			},
			{ fromMs: 0, limit: 3 },
		)
		expect(occurrences.map((o) => o.date)).toEqual([
			'2026-10-20',
			'2026-11-03',
			'2026-11-10',
		])
		expect(occurrences[1]).toMatchObject({
			start: '2026-11-03T18:00:00-05:00',
			moved: true,
		})
	})

	it('keeps an every-other-week rule aligned years later', () => {
		const [next] = expandOccurrences(
			{
				...trivia,
				recurrence: { frequency: 'weekly', weekdays: [2], interval: 2 },
			},
			{ fromMs: Date.parse('2030-01-01T00:00:00Z'), limit: 1 },
		)
		const days =
			(Date.parse(`${next!.date}T00:00:00Z`) -
				Date.parse('2026-10-20T00:00:00Z')) /
			86_400_000
		expect(days % 14).toBe(0)
		expect(next!.start.slice(11, 16)).toBe('20:00')
	})

	it('shows at most 12 occurrences of an endless event', () => {
		expect(expandOccurrences(trivia, { fromMs: 0 })).toHaveLength(12)
	})

	it('drops occurrences that ended and keeps one in progress', () => {
		const during = Date.parse('2026-10-21T01:00:00Z') // 21:00 EDT on the 20th
		const [first] = expandOccurrences(trivia, { fromMs: during, limit: 1 })
		expect(first?.date).toBe('2026-10-20')
	})

	it('supports "second Friday" and a date each month', () => {
		const second = expandOccurrences(
			{
				startLocal: '2026-11-13T19:00',
				endLocal: '2026-11-13T21:00',
				timezone: 'Asia/Riyadh',
				recurrence: { frequency: 'monthly', mode: 'weekday', interval: 1 },
			},
			{ fromMs: 0, limit: 3 },
		)
		expect(second.map((o) => o.date)).toEqual([
			'2026-11-13',
			'2026-12-11',
			'2027-01-08',
		])
		const dated = expandOccurrences(
			{
				startLocal: '2026-01-31T12:00',
				endLocal: '2026-01-31T14:00',
				timezone: 'Asia/Riyadh',
				recurrence: { frequency: 'monthly', mode: 'date', interval: 1 },
			},
			{ fromMs: 0, limit: 3 },
		)
		// February has no 31st.
		expect(dated.map((o) => o.date)).toEqual([
			'2026-01-31',
			'2026-03-31',
			'2026-05-31',
		])
	})

	it('custom dates and count limits', () => {
		const custom = expandOccurrences(
			{
				startLocal: '2026-12-24T18:00',
				endLocal: '2026-12-24T23:00',
				timezone: 'Asia/Riyadh',
				recurrence: { frequency: 'dates', dates: ['2026-12-31', '2026-12-10'] },
			},
			{ fromMs: 0 },
		)
		expect(custom.map((o) => o.date)).toEqual(['2026-12-24', '2026-12-31'])
		const counted: SiteEventSchedule = {
			...trivia,
			recurrence: { frequency: 'weekly', weekdays: [2], interval: 1, count: 2 },
		}
		expect(expandOccurrences(counted, { fromMs: 0 })).toHaveLength(2)
		expect(lastOccurrenceEndMs(counted)).toBe(
			Date.parse('2026-10-28T02:30:00Z'),
		)
		expect(lastOccurrenceEndMs(trivia)).toBeNull()
	})
})

describe('event times and phases', () => {
	it('refuses an end before the start or longer than 24 hours', () => {
		expect(
			validateEventTimes({
				startLocal: '2026-10-20T20:00',
				endLocal: '2026-10-20T19:00',
				timezone: 'UTC',
			}),
		).toEqual({ ok: false, error: 'invalid_event_time' })
		expect(
			validateEventTimes({
				startLocal: '2026-10-20T20:00',
				endLocal: '2026-10-21T20:01',
				timezone: 'UTC',
			}),
		).toEqual({ ok: false, error: 'invalid_event_time' })
		expect(
			validateEventTimes({
				startLocal: '2026-10-20T20:00',
				endLocal: '2026-10-21T02:00',
				timezone: 'UTC',
			}),
		).toEqual({ ok: true, minutes: 360 })
	})

	it('is upcoming, ended, then gone 30 days after the last occurrence', () => {
		const once: SiteEventSchedule = {
			startLocal: '2026-10-20T20:00',
			endLocal: '2026-10-20T22:00',
			timezone: 'UTC',
			recurrence: { frequency: 'none' },
		}
		expect(eventPhase(once, Date.parse('2026-10-19T00:00:00Z'))).toBe(
			'upcoming',
		)
		expect(eventPhase(once, Date.parse('2026-11-10T00:00:00Z'))).toBe('ended')
		expect(eventPhase(once, Date.parse('2026-11-20T00:00:00Z'))).toBe('gone')
		expect(nextOccurrence(once, Date.parse('2026-11-10T00:00:00Z'))).toEqual({
			ok: false,
			error: 'event_ended',
		})
		expect(eventPhase(trivia, Date.parse('2030-01-01T00:00:00Z'))).toBe(
			'upcoming',
		)
	})
})

describe('buildEventIcs', () => {
	it('writes one VEVENT per occurrence in UTC, escaped', () => {
		const occurrences = expandOccurrences(trivia, { fromMs: 0, limit: 2 })
		const ics = buildEventIcs({
			uid: 'evt1',
			host: 'acme.example.com',
			title: 'Trivia; night, live',
			description: 'Line one\nLine two',
			location: 'Main St',
			url: 'https://acme.example.com/events/trivia',
			occurrences,
			nowMs: Date.parse('2026-10-01T00:00:00Z'),
		})
		expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0')).toBe(true)
		expect(ics).toContain('DTSTART:20261021T000000Z')
		expect(ics).toContain('DTEND:20261021T023000Z')
		expect(ics).toContain('UID:evt1-2026-10-27@acme.example.com')
		expect(ics).toContain('SUMMARY:Trivia\\; night\\, live')
		expect(ics).toContain('DESCRIPTION:Line one\\nLine two')
		expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2)
		expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
	})

	it('slugifies titles', () => {
		expect(slugifyTitle('Trivia Tuesday!')).toBe('trivia-tuesday')
		expect(slugifyTitle('إفطار رمضان')).toBe('event')
	})
})
