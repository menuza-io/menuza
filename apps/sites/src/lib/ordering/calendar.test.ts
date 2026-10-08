import { describe, expect, it } from 'vitest'
import {
	buildIcs,
	buildIcsDataUrl,
	escapeIcsText,
	formatIcsUtc,
} from './calendar.ts'

const start = new Date('2026-10-09T14:30:00Z')
const end = new Date('2026-10-09T15:00:00Z')
const now = new Date('2026-10-07T12:00:00Z')

describe('calendar', () => {
	it('formats UTC timestamps', () => {
		expect(formatIcsUtc(start)).toBe('20261009T143000Z')
	})

	it('escapes reserved characters and newlines', () => {
		expect(escapeIcsText('Pies; cakes, and more\nline two')).toBe(
			'Pies\\; cakes\\, and more\\nline two',
		)
		expect(escapeIcsText('back\\slash')).toBe('back\\\\slash')
	})

	it('builds a VEVENT with CRLF line endings and UTC times', () => {
		const ics = buildIcs({
			title: 'Weekend Bake Box: orders open',
			start,
			end,
			location: 'Baxter Village, 12 Main St',
			description: 'Order before they sell out.',
			url: 'https://cafe.example/drop/weekend-bake-box',
			uid: 'test-uid@menuza',
			now,
		})
		const lines = ics.split('\r\n')
		expect(ics.endsWith('\r\n')).toBe(true)
		expect(ics).not.toMatch(/[^\r]\n/)
		expect(lines).toEqual([
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//Menuza//Sites//EN',
			'CALSCALE:GREGORIAN',
			'METHOD:PUBLISH',
			'BEGIN:VEVENT',
			'UID:test-uid@menuza',
			'DTSTAMP:20261007T120000Z',
			'DTSTART:20261009T143000Z',
			'DTEND:20261009T150000Z',
			'SUMMARY:Weekend Bake Box: orders open',
			'LOCATION:Baxter Village\\, 12 Main St',
			'DESCRIPTION:Order before they sell out.',
			'URL:https://cafe.example/drop/weekend-bake-box',
			'END:VEVENT',
			'END:VCALENDAR',
			'',
		])
	})

	it('derives a stable UID and never ends before it starts', () => {
		const a = buildIcs({ title: 'Drop', start, end: start, now })
		const b = buildIcs({ title: 'Drop', start, end: start, now })
		expect(a).toBe(b)
		expect(a).toContain('DTEND:20261009T143000Z')
		expect(a).toMatch(/UID:[a-z0-9]+@menuza/)
	})

	it('folds long lines', () => {
		const ics = buildIcs({
			title: 'A'.repeat(100),
			start,
			end,
			now,
			uid: 'x@menuza',
		})
		for (const line of ics.split('\r\n')) {
			expect(line.length).toBeLessThanOrEqual(75)
		}
		expect(ics).toContain(`${'A'.repeat(67)}\r\n ${'A'.repeat(33)}`)
	})

	it('returns a data URL with the calendar MIME type', () => {
		const url = buildIcsDataUrl({
			title: 'Drop',
			start,
			end,
			now,
			uid: 'x@menuza',
		})
		expect(url.startsWith('data:text/calendar;charset=utf-8,')).toBe(true)
		const decoded = decodeURIComponent(
			url.slice('data:text/calendar;charset=utf-8,'.length),
		)
		expect(decoded).toContain('BEGIN:VCALENDAR\r\n')
		expect(decoded).toContain('SUMMARY:Drop')
	})
})
