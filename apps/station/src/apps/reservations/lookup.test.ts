import { describe, expect, it } from 'vitest'
import {
	displayNameOf,
	findRepeat,
	guestFromQuery,
	highlightRanges,
	samePhone,
} from './lookup.ts'
import { entry, rsv } from './testing.ts'

const guest = (first: string, last: string, phone: string | null = null) => ({
	id: `g-${first}`,
	name: `${first} ${last}`,
	firstName: first,
	lastName: last,
	phone,
})

describe('the same phone number', () => {
	it('matches however it is spaced, and with or without the country code', () => {
		expect(samePhone('+1 415 555 0142', '+14155550142')).toBe(true)
		expect(samePhone('4155550142', '+1 (415) 555-0142')).toBe(true)
		expect(samePhone('+14155550142', '+14155550143')).toBe(false)
		// Too short to mean a person.
		expect(samePhone('0142', '0142')).toBe(false)
		expect(samePhone(null, '+14155550142')).toBe(false)
	})
})

describe('a booking that repeats one in the book', () => {
	const rana = rsv({
		start: 13 * 60 + 20,
		partySize: 5,
		status: 'arrived',
		guest: guest('Rana', 'Khalid', '+14155550107'),
	})
	const other = rsv({
		start: 12 * 60,
		guest: guest('Omar', 'Rashid', '+14155550102'),
	})
	it('is found by the same full name, ignoring case and accents', () => {
		const found = findRepeat(
			{ first: 'rana', last: 'KHALID', phone: '' },
			[other, rana],
			[],
		)
		expect(found).toMatchObject({
			kind: 'booking',
			reservation: { id: rana.id },
		})
		const jose = rsv({ start: 600, guest: guest('José', 'Núñez') })
		expect(
			findRepeat({ first: 'jose', last: 'nunez', phone: '' }, [jose], []),
		).not.toBeNull()
	})
	it('is found by the same phone number whatever the name', () => {
		const found = findRepeat(
			{ first: 'Someone', last: '', phone: '+1 415 555 0107' },
			[other, rana],
			[],
		)
		expect(found).toMatchObject({ reservation: { id: rana.id } })
	})
	it('is never a first name alone', () => {
		expect(
			findRepeat({ first: 'Rana', last: '', phone: '' }, [rana], []),
		).toBeNull()
		expect(
			findRepeat({ first: 'Rana', last: 'Khan', phone: '' }, [rana], []),
		).toBeNull()
	})
	it('ignores a booking that no longer stands', () => {
		for (const status of ['cancelled', 'no_show', 'finished']) {
			const gone = rsv({
				start: 600,
				status,
				guest: guest('Rana', 'Khalid', '+14155550107'),
			})
			expect(
				findRepeat({ first: 'Rana', last: 'Khalid', phone: '' }, [gone], []),
			).toBeNull()
		}
	})
	it('is the earliest of two bookings', () => {
		const early = rsv({ start: 600, guest: guest('Rana', 'Khalid') })
		const late = rsv({ start: 1200, guest: guest('Rana', 'Khalid') })
		expect(
			findRepeat(
				{ first: 'Rana', last: 'Khalid', phone: '' },
				[late, early],
				[],
			),
		).toMatchObject({ reservation: { id: early.id } })
	})
	it('is found on the waitlist too, after the bookings', () => {
		const waiting = entry({
			displayName: 'Jamal Hussein',
			phone: '+14155550132',
			status: 'waiting',
		})
		expect(
			findRepeat({ first: 'Jamal', last: 'Hussein', phone: '' }, [], [waiting]),
		).toMatchObject({ kind: 'waitlist' })
		const left = { ...waiting, status: 'left' as const }
		expect(
			findRepeat({ first: 'Jamal', last: 'Hussein', phone: '' }, [], [left]),
		).toBeNull()
		expect(
			findRepeat(
				{ first: 'Jamal', last: 'Hussein', phone: '' },
				[rana],
				[waiting],
			),
		).toMatchObject({ kind: 'waitlist' })
	})
})

describe('a search that found no one', () => {
	it('is a name when it is words', () => {
		expect(guestFromQuery('rana khalid')).toEqual({
			first: 'Rana',
			last: 'Khalid',
			phone: '',
		})
		expect(guestFromQuery('  zzz ')).toEqual({
			first: 'Zzz',
			last: '',
			phone: '',
		})
		expect(displayNameOf(guestFromQuery('mary ann lee'))).toBe('Mary Ann Lee')
	})
	it('is a phone number when it is digits', () => {
		expect(guestFromQuery('4155550142')).toEqual({
			first: '',
			last: '',
			phone: '415 555 0142',
		})
		expect(guestFromQuery('+1 (415) 555-0142').phone).toBe('+1 415 555 0142')
		expect(guestFromQuery('٠٥٥ ١٢٣ ٤٥٦٧').phone).toBe('055 123 4567')
	})
	it('keeps one or two digits as a name (not a number)', () => {
		expect(guestFromQuery('12').phone).toBe('')
		expect(guestFromQuery('').first).toBe('')
	})
})

describe('where the typed words are in a name', () => {
	const marked = (text: string, query: string) =>
		highlightRanges(text, query).map(([a, b]) => text.slice(a, b))
	it('marks each typed word, ignoring case', () => {
		expect(marked('Maya Haddad', 'maya')).toEqual(['Maya'])
		expect(marked('Maya Haddad', 'had may')).toEqual(['May', 'Had'])
		expect(marked('Maya Haddad', 'ADD')).toEqual(['add'])
	})
	it('sees past accents, whole or combining', () => {
		expect(marked('José Núñez', 'jose nun')).toEqual(['José', 'Núñ'])
		expect(marked('José Nu', 'jose')).toEqual(['José'])
	})
	it('merges words that overlap and finds nothing for no match', () => {
		expect(marked('Maya', 'may ya')).toEqual(['Maya'])
		expect(marked('Maya', 'zzz')).toEqual([])
		expect(marked('Maya', '   ')).toEqual([])
	})
})
