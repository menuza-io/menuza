import { describe, expect, it } from 'vitest'
import { buildReservationIcs } from './rsv-ics.ts'

const base = {
	reservationId: 'rsv_1',
	confirmationCode: 'ABC123',
	restaurantName: 'Acme',
	locationName: null,
	address: null,
	startAt: Date.parse('2031-03-10T19:00:00Z'),
	endAt: Date.parse('2031-03-10T20:30:00Z'),
	partySize: 2,
	now: Date.parse('2031-03-01T00:00:00Z'),
}

describe('reservation calendar file', () => {
	it('never lets a restaurant or place name start a new calendar line', () => {
		const ics = buildReservationIcs({
			...base,
			restaurantName: 'Acme\rATTENDEE:mailto:x@evil.test',
			address: 'Main St\r\nURL:https://evil.test\nEND:VEVENT',
		})
		const lines = ics.split('\r\n')
		// Only the lines this file writes: no injected property or early END.
		expect(lines.filter((line) => line.startsWith('ATTENDEE'))).toEqual([])
		expect(lines.filter((line) => line.startsWith('URL'))).toEqual([])
		expect(lines.filter((line) => line === 'END:VEVENT')).toHaveLength(1)
		expect(ics).toContain('Acme\\nATTENDEE:mailto:x@evil.test')
	})

	it('escapes the characters RFC 5545 reserves', () => {
		const ics = buildReservationIcs({ ...base, restaurantName: 'A;B,C\\D' })
		expect(ics.split('\r\n')).toContain('SUMMARY:Reservation at A\\;B\\,C\\\\D')
	})
})
