import { parseLocalTimestamp } from '@repo/zoned-time'
import { describe, expect, it } from 'vitest'
import {
	ICAL_MAX_BYTES,
	ICAL_MAX_EVENTS,
	ICAL_MAX_OCCURRENCES,
	parseCalendar,
	plainText,
	TITLE_MAX,
} from './ical.ts'

const NOW = Date.UTC(2026, 2, 1, 12, 0, 0) // 1 March 2026

function calendar(...events: string[]) {
	return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nX-WR-CALNAME:Pub nights\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`
}
function event(lines: string[]) {
	return `BEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT`
}
function parse(text: string, defaultTimezone = 'Asia/Riyadh') {
	const result = parseCalendar(text, { defaultTimezone, now: NOW })
	if (!result.ok) throw new Error(result.error)
	return result
}

describe('one-off events', () => {
	it('reads a title, description and a time in the event time zone', () => {
		const { occurrences, name } = parse(
			calendar(
				event([
					'UID:quiz-1@google.com',
					'SUMMARY:Quiz night',
					'DESCRIPTION:Bring a team\\, win a prize\\nStarts at 8',
					'LOCATION:Back room',
					'DTSTART;TZID=Europe/London:20260312T200000',
					'DTEND;TZID=Europe/London:20260312T220000',
				]),
			),
		)
		expect(name).toBe('Pub nights')
		expect(occurrences).toEqual([
			{
				key: 'quiz-1@google.com',
				title: 'Quiz night',
				description: 'Bring a team, win a prize\nStarts at 8',
				location: 'Back room',
				startLocal: '2026-03-12T20:00',
				endLocal: '2026-03-12T22:00',
				timezone: 'Europe/London',
			},
		])
	})

	it('puts UTC times and floating times on the calendar zone', () => {
		const { occurrences } = parse(
			calendar(
				event([
					'UID:utc@x',
					'SUMMARY:Utc',
					'DTSTART:20260312T170000Z',
					'DTEND:20260312T190000Z',
				]),
				event([
					'UID:float@x',
					'SUMMARY:Floating',
					'DTSTART:20260313T200000',
					'DURATION:PT90M',
				]),
			),
			'Asia/Riyadh',
		)
		const byTitle = Object.fromEntries(occurrences.map((o) => [o.title, o]))
		// Riyadh is UTC+3 all year.
		expect(byTitle.Utc).toMatchObject({
			startLocal: '2026-03-12T20:00',
			endLocal: '2026-03-12T22:00',
			timezone: 'Asia/Riyadh',
		})
		expect(byTitle.Floating).toMatchObject({
			startLocal: '2026-03-13T20:00',
			endLocal: '2026-03-13T21:30',
		})
	})

	it('treats an unknown TZID as the calendar zone and an all-day event as the whole day', () => {
		const { occurrences } = parse(
			calendar(
				event([
					'UID:win@x',
					'SUMMARY:Windows zone',
					'DTSTART;TZID=Eastern Standard Time:20260312T200000',
					'DTEND;TZID=Eastern Standard Time:20260312T210000',
				]),
				event([
					'UID:day@x',
					'SUMMARY:Open day',
					'DTSTART;VALUE=DATE:20260320',
					'DTEND;VALUE=DATE:20260321',
				]),
			),
		)
		expect(occurrences.find((o) => o.title === 'Windows zone')?.timezone).toBe(
			'Asia/Riyadh',
		)
		expect(occurrences.find((o) => o.title === 'Open day')).toMatchObject({
			startLocal: '2026-03-20T00:00',
			endLocal: '2026-03-20T23:59',
		})
	})

	it('leaves out events that are over or beyond the 90 day window', () => {
		const { occurrences } = parse(
			calendar(
				event([
					'UID:past@x',
					'SUMMARY:Past',
					'DTSTART:20260101T100000Z',
					'DTEND:20260101T110000Z',
				]),
				event([
					'UID:far@x',
					'SUMMARY:Far',
					'DTSTART:20261001T100000Z',
					'DTEND:20261001T110000Z',
				]),
				event([
					'UID:soon@x',
					'SUMMARY:Soon',
					'DTSTART:20260401T100000Z',
					'DTEND:20260401T110000Z',
				]),
			),
		)
		expect(occurrences.map((o) => o.title)).toEqual(['Soon'])
	})
})

describe('stable ids', () => {
	it('a one-off keeps its id when the calendar moves or renames it', () => {
		const a = parse(
			calendar(
				event([
					'UID:one@x',
					'SUMMARY:A',
					'DTSTART:20260312T170000Z',
					'DTEND:20260312T180000Z',
				]),
			),
		)
		const b = parse(
			calendar(
				event([
					'UID:one@x',
					'SUMMARY:B',
					'DTSTART:20260315T150000Z',
					'DTEND:20260315T160000Z',
				]),
			),
		)
		expect(a.occurrences[0]!.key).toBe('one@x')
		expect(b.occurrences[0]!.key).toBe('one@x')
	})
	it('a repeating event is told apart by the date of each instance, not its time', () => {
		const rule = (time: string) =>
			parse(
				calendar(
					event([
						'UID:rep@x',
						'SUMMARY:R',
						`DTSTART:20260303T${time}00Z`,
						`DTEND:20260303T${time}00Z`.replace('T', 'T'),
						'RRULE:FREQ=WEEKLY;COUNT=3',
					]),
				),
			)
		expect(rule('1800').occurrences.map((o) => o.key)).toEqual(
			rule('1900').occurrences.map((o) => o.key),
		)
		expect(rule('1800').occurrences[0]!.key).toBe('rep@x|2026-03-03')
	})
})

describe('recurring events', () => {
	const weekly = (extra: string[] = [], zone = 'America/New_York') =>
		event([
			'UID:trivia@x',
			'SUMMARY:Trivia Thursday',
			`DTSTART;TZID=${zone}:20260226T200000`,
			`DTEND;TZID=${zone}:20260226T220000`,
			'RRULE:FREQ=WEEKLY;BYDAY=TH',
			...extra,
		])

	it('expands a weekly event for the next 90 days', () => {
		const { occurrences } = parse(calendar(weekly()), 'America/New_York')
		expect(occurrences.length).toBeGreaterThanOrEqual(12)
		expect(occurrences.length).toBeLessThanOrEqual(14)
		expect(occurrences.every((o) => o.startLocal.endsWith('T20:00'))).toBe(true)
		// Thursdays only.
		for (const o of occurrences) {
			expect(
				new Date(`${o.startLocal.slice(0, 10)}T00:00:00Z`).getUTCDay(),
			).toBe(4)
		}
		expect(occurrences[0]!.startLocal).toBe('2026-03-05T20:00')
	})

	it('keeps 20:00 local across a daylight-saving change (never adds 7 x 24 hours)', () => {
		const { occurrences } = parse(calendar(weekly()), 'America/New_York')
		const before = occurrences.find((o) => o.startLocal === '2026-03-05T20:00')!
		const after = occurrences.find((o) => o.startLocal === '2026-03-12T20:00')!
		const gap =
			parseLocalTimestamp(after.startLocal, after.timezone) -
			parseLocalTimestamp(before.startLocal, before.timezone)
		// The US changed to summer time on 8 March: that week is one hour shorter.
		expect(gap).toBe(7 * 86_400_000 - 3_600_000)
	})

	it('handles a Riyadh event, which has no daylight saving', () => {
		const { occurrences } = parse(
			calendar(weekly([], 'Asia/Riyadh')),
			'Asia/Riyadh',
		)
		const a = occurrences[0]!
		const b = occurrences[1]!
		expect(
			parseLocalTimestamp(b.startLocal, b.timezone) -
				parseLocalTimestamp(a.startLocal, a.timezone),
		).toBe(7 * 86_400_000)
	})

	it('skips an EXDATE and drops a cancelled instance', () => {
		const { occurrences } = parse(
			calendar(weekly(['EXDATE;TZID=America/New_York:20260312T200000'])),
			'America/New_York',
		)
		const days = occurrences.map((o) => o.startLocal.slice(0, 10))
		expect(days).toContain('2026-03-05')
		expect(days).not.toContain('2026-03-12')
		expect(days).toContain('2026-03-19')
	})

	it('moves one instance with RECURRENCE-ID and keeps the rest', () => {
		const moved = event([
			'UID:trivia@x',
			'RECURRENCE-ID;TZID=America/New_York:20260312T200000',
			'SUMMARY:Trivia Thursday (special)',
			'DTSTART;TZID=America/New_York:20260312T190000',
			'DTEND;TZID=America/New_York:20260312T210000',
		])
		const { occurrences } = parse(calendar(weekly(), moved), 'America/New_York')
		const special = occurrences.find((o) => o.title.includes('special'))!
		expect(special.startLocal).toBe('2026-03-12T19:00')
		expect(
			occurrences.filter((o) => o.startLocal.startsWith('2026-03-12')),
		).toHaveLength(1)
		expect(occurrences.some((o) => o.startLocal === '2026-03-19T20:00')).toBe(
			true,
		)
	})

	it('a cancelled event leaves nothing behind, and a cancelled override removes only its instance', () => {
		const cancelledSeries = event([
			'UID:gone@x',
			'SUMMARY:Gone',
			'STATUS:CANCELLED',
			'DTSTART:20260312T170000Z',
			'DTEND:20260312T180000Z',
		])
		expect(parse(calendar(cancelledSeries)).occurrences).toEqual([])
		const cancelledInstance = event([
			'UID:trivia@x',
			'RECURRENCE-ID;TZID=America/New_York:20260312T200000',
			'STATUS:CANCELLED',
			'DTSTART;TZID=America/New_York:20260312T200000',
			'DTEND;TZID=America/New_York:20260312T220000',
		])
		const { occurrences } = parse(
			calendar(weekly(), cancelledInstance),
			'America/New_York',
		)
		const days = occurrences.map((o) => o.startLocal.slice(0, 10))
		expect(days).not.toContain('2026-03-12')
		expect(days).toContain('2026-03-19')
	})

	it('reads COUNT, UNTIL, interval, monthly weekday and monthly date rules', () => {
		const count = parse(
			calendar(
				event([
					'UID:count@x',
					'SUMMARY:Count',
					'DTSTART:20260303T180000Z',
					'DTEND:20260303T190000Z',
					'RRULE:FREQ=DAILY;COUNT=3',
				]),
			),
		)
		expect(count.occurrences).toHaveLength(3)
		const until = parse(
			calendar(
				event([
					'UID:until@x',
					'SUMMARY:Until',
					'DTSTART:20260303T180000Z',
					'DTEND:20260303T190000Z',
					'RRULE:FREQ=WEEKLY;UNTIL=20260320T000000Z',
				]),
			),
		)
		expect(until.occurrences.map((o) => o.startLocal.slice(0, 10))).toEqual([
			'2026-03-03',
			'2026-03-10',
			'2026-03-17',
		])
		const biweekly = parse(
			calendar(
				event([
					'UID:bi@x',
					'SUMMARY:Bi',
					'DTSTART:20260303T180000Z',
					'DTEND:20260303T190000Z',
					'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3',
				]),
			),
		)
		expect(biweekly.occurrences.map((o) => o.startLocal.slice(0, 10))).toEqual([
			'2026-03-03',
			'2026-03-17',
			'2026-03-31',
		])
		const secondFriday = parse(
			calendar(
				event([
					'UID:ff@x',
					'SUMMARY:Second Friday',
					'DTSTART;TZID=Asia/Riyadh:20260313T200000',
					'DTEND;TZID=Asia/Riyadh:20260313T220000',
					'RRULE:FREQ=MONTHLY;BYDAY=2FR',
				]),
			),
		)
		expect(
			secondFriday.occurrences.map((o) => o.startLocal.slice(0, 10)),
		).toEqual(
			['2026-03-13', '2026-04-10', '2026-05-08', '2026-06-12'].filter(
				(d) => d <= '2026-05-30',
			),
		)
		const lastDay = parse(
			calendar(
				event([
					'UID:ld@x',
					'SUMMARY:Last day',
					'DTSTART;TZID=Asia/Riyadh:20260331T200000',
					'DTEND;TZID=Asia/Riyadh:20260331T210000',
					'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1',
				]),
			),
		)
		expect(lastDay.occurrences.map((o) => o.startLocal.slice(0, 10))).toEqual(
			['2026-03-31', '2026-04-30', '2026-05-31'].filter(
				(d) => d <= '2026-05-30',
			),
		)
	})

	it('caps the occurrences of a feed', () => {
		const text = calendar(
			event([
				'UID:daily@x',
				'SUMMARY:Daily',
				'DTSTART:20260302T180000Z',
				'DTEND:20260302T190000Z',
				'RRULE:FREQ=DAILY',
			]),
			...Array.from({ length: 150 }, (_, i) =>
				event([
					`UID:e${i}@x`,
					`SUMMARY:E${i}`,
					`DTSTART:2026031${(i % 9) + 1}T100000Z`,
					`DTEND:2026031${(i % 9) + 1}T110000Z`,
				]),
			),
		)
		expect(parse(text).occurrences.length).toBeLessThanOrEqual(
			ICAL_MAX_OCCURRENCES,
		)
	})
})

describe('untrusted content stays inert', () => {
	it('keeps markup as plain text and strips control and direction characters', () => {
		const { occurrences } = parse(
			calendar(
				event([
					'UID:xss@x',
					'SUMMARY:<script>alert(1)</script> Trivia‮',
					'DESCRIPTION:<img src=x onerror=alert(1)>\\nline\u0000two',
					'LOCATION:<b>Bar</b>',
					'DTSTART:20260312T170000Z',
					'DTEND:20260312T180000Z',
				]),
			),
		)
		const [o] = occurrences
		// Text, not markup: it is a string that every renderer escapes.
		expect(typeof o!.title).toBe('string')
		expect(o!.title).toBe('<script>alert(1)</script> Trivia')
		expect(o!.title).not.toMatch(/[‮\u0000]/u)
		expect(o!.description).toBe('<img src=x onerror=alert(1)>\nlinetwo')
		expect(o!.description).not.toContain('\u0000')
	})

	it('cuts long text and ignores a nested alarm and unknown properties', () => {
		const { occurrences } = parse(
			calendar(
				event([
					'UID:long@x',
					`SUMMARY:${'A'.repeat(TITLE_MAX + 100)}`,
					'X-EVIL:javascript:alert(1)',
					'BEGIN:VALARM',
					'ACTION:EMAIL',
					'SUMMARY:alarm title must not leak',
					'END:VALARM',
					'DTSTART:20260312T170000Z',
					'DTEND:20260312T180000Z',
				]),
			),
		)
		expect(occurrences[0]!.title).toHaveLength(TITLE_MAX)
		expect(JSON.stringify(occurrences)).not.toContain('alarm title')
		expect(JSON.stringify(occurrences)).not.toContain('javascript')
	})

	it('keeps a title and a place on one line, so no line break can reach a file', () => {
		const { occurrences } = parse(
			calendar(
				event([
					'UID:nl@x',
					'SUMMARY:Quiz\\nBEGIN:VEVENT\\nSUMMARY:Injected',
					'LOCATION:Bar\\nFloor 2',
					'DTSTART:20260312T170000Z',
					'DTEND:20260312T180000Z',
				]),
			),
		)
		expect(occurrences[0]!.title).toBe('Quiz BEGIN:VEVENT SUMMARY:Injected')
		expect(occurrences[0]!.title).not.toContain('\n')
		expect(occurrences[0]!.location).toBe('Bar Floor 2')
	})

	it('plainText unescapes iCalendar and trims', () => {
		expect(plainText('a\\, b\; c\\\\ d\\nE', 50)).toBe('a, b; c\\ d\nE')
		expect(plainText('  spaced   out  ', 50)).toBe('spaced out')
	})
})

describe('what is not a calendar', () => {
	it('refuses HTML, JSON, empty, truncated and oversized input', () => {
		for (const text of [
			'',
			'<html><script>alert(1)</script></html>',
			'{"a":1}',
			'BEGIN:VEVENT\nEND:VEVENT',
			'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:cut@x',
		]) {
			expect(parseCalendar(text, { defaultTimezone: 'UTC', now: NOW })).toEqual(
				{
					ok: false,
					error: 'invalid_calendar',
				},
			)
		}
		expect(
			parseCalendar(
				`BEGIN:VCALENDAR\n${'X'.repeat(ICAL_MAX_BYTES)}\nEND:VCALENDAR`,
				{
					defaultTimezone: 'UTC',
					now: NOW,
				},
			),
		).toEqual({ ok: false, error: 'too_large' })
	})

	it('survives a feed of garbage events and counts what it could not read', () => {
		const result = parse(
			calendar(
				event(['UID:nodate@x', 'SUMMARY:No date']),
				event(['SUMMARY:No uid', 'DTSTART:20260312T170000Z']),
				event(['UID:baddate@x', 'SUMMARY:Bad', 'DTSTART:20261399T170000Z']),
				event([
					'UID:ok@x',
					'SUMMARY:Fine',
					'DTSTART:20260312T170000Z',
					'DTEND:20260312T180000Z',
				]),
			),
		)
		expect(result.occurrences.map((o) => o.title)).toEqual(['Fine'])
		expect(result.skipped).toBeGreaterThanOrEqual(3)
	})

	it('reads at most the maximum number of events', () => {
		const many = Array.from({ length: ICAL_MAX_EVENTS + 50 }, (_, i) =>
			event([
				`UID:m${i}@x`,
				`SUMMARY:M${i}`,
				'DTSTART:20260312T170000Z',
				'DTEND:20260312T180000Z',
			]),
		)
		const result = parse(calendar(...many))
		expect(result.occurrences.length).toBeLessThanOrEqual(ICAL_MAX_OCCURRENCES)
		expect(result.skipped).toBeGreaterThan(0)
	})
})
