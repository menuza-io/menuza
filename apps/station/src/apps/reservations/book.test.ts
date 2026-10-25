import { describe, expect, it } from 'vitest'
import {
	bookList,
	dayTotals,
	inService,
	liveServices,
	matchesReservation,
	foldDigits,
	matchesWaitlistEntry,
	newArrivals,
	normalize,
	partyStatus,
	serviceOf,
	dayNotices,
	daySnapshot,
} from './book.ts'
import { at, day, entry, MIN, rsv, SERVICES } from './testing.ts'

const guest = (first: string, last: string, phone: string | null = null) => ({
	id: `g-${first}`,
	name: `${first} ${last}`,
	firstName: first,
	lastName: last,
	phone,
})

describe('search', () => {
	const maya = rsv({
		start: 12 * 60,
		guest: guest('Maya', 'Haddad', '+14155550142'),
		tableLabels: ['T4'],
		confirmationCode: 'AB7K2Q',
	})
	it('finds a name by any typed word, ignoring case and accents', () => {
		expect(matchesReservation(maya, 'maya')).toBe(true)
		expect(matchesReservation(maya, 'HAD')).toBe(true)
		expect(matchesReservation(maya, 'maya had')).toBe(true)
		expect(matchesReservation(maya, 'zed')).toBe(false)
		const jose = rsv({ start: 600, guest: guest('José', 'Núñez') })
		expect(matchesReservation(jose, 'jose nunez')).toBe(true)
		expect(normalize('  Ünï  ')).toBe('uni')
	})
	it('finds the end of the phone number, last four digits', () => {
		expect(matchesReservation(maya, '0142')).toBe(true)
		expect(matchesReservation(maya, '42')).toBe(true)
		expect(matchesReservation(maya, '0143')).toBe(false)
		// One digit is too little to mean a phone.
		expect(matchesReservation(maya, '9')).toBe(false)
		expect(matchesReservation(maya, '+1 415 555 0142')).toBe(true)
	})
	it('finds a table or a confirmation code', () => {
		expect(matchesReservation(maya, 't4')).toBe(true)
		expect(matchesReservation(maya, 'ab7k')).toBe(true)
		expect(matchesReservation(maya, 'T9')).toBe(false)
	})
	it('matches everything when empty, and waitlist names and numbers', () => {
		expect(matchesReservation(maya, '   ')).toBe(true)
		const w = entry({ displayName: 'Tariq Saleh', phone: '+14155550177' })
		expect(matchesWaitlistEntry(w, 'tar')).toBe(true)
		expect(matchesWaitlistEntry(w, '0177')).toBe(true)
		expect(matchesWaitlistEntry(w, 'maya')).toBe(false)
	})
})

describe('services', () => {
	const feed = day([], { services: SERVICES })
	it('lists them in the order they seat and places a booking in one', () => {
		expect(liveServices(feed).map((s) => s.name)).toEqual(['Lunch', 'Dinner'])
		expect(
			serviceOf(feed, { serviceId: null, localStartMin: 13 * 60 })?.id,
		).toBe('lunch')
		expect(
			serviceOf(feed, { serviceId: 'dinner', localStartMin: 600 })?.id,
		).toBe('dinner')
		expect(
			serviceOf(feed, { serviceId: null, localStartMin: 16 * 60 }),
		).toBeNull()
	})
	it('narrows to a service, or none at all', () => {
		const r = { serviceId: null, localStartMin: 18 * 60 }
		expect(inService(feed, r, null)).toBe(true)
		expect(inService(feed, r, 'dinner')).toBe(true)
		expect(inService(feed, r, 'lunch')).toBe(false)
	})
})

describe('the party status', () => {
	const now = at(12 * 60 + 40)
	const base = { startAt: at(12 * 60), runningLateMin: null as number | null }
	it('says seated, here, finished and no-show first', () => {
		expect(partyStatus({ ...base, status: 'seated' }, now).kind).toBe('seated')
		expect(partyStatus({ ...base, status: 'arrived' }, now).kind).toBe('here')
		expect(partyStatus({ ...base, status: 'finished' }, now).kind).toBe(
			'finished',
		)
		expect(partyStatus({ ...base, status: 'no_show' }, now).kind).toBe(
			'no_show',
		)
	})
	it('is late by the clock, or running late by their word', () => {
		expect(partyStatus({ ...base, status: 'booked' }, now)).toMatchObject({
			kind: 'late',
			late: 40,
		})
		const said = { ...base, status: 'confirmed', runningLateMin: 60 }
		expect(partyStatus(said, now).kind).toBe('running')
		// Later than they said: the clock leads.
		expect(partyStatus({ ...said, runningLateMin: 15 }, now)).toMatchObject({
			kind: 'late',
			late: 40,
			said: 15,
		})
		expect(
			partyStatus({ ...base, status: 'confirmed' }, at(11 * 60)).kind,
		).toBe('confirmed')
		expect(partyStatus({ ...base, status: 'booked' }, at(11 * 60)).kind).toBe(
			'booked',
		)
	})
})

describe('the list', () => {
	const now = at(13 * 60)
	const feed = day(
		[
			rsv({
				id: 'early',
				start: 11 * 60,
				status: 'finished',
				finishedAt: now - 20 * MIN,
				guest: guest('Fin', 'Ished'),
			}),
			rsv({
				id: 'sat',
				start: 12 * 60,
				status: 'seated',
				seatedAt: at(12 * 60 + 5),
				guest: guest('Sat', 'Down'),
			}),
			rsv({
				id: 'sat2',
				start: 12 * 60 + 30,
				status: 'seated',
				seatedAt: at(12 * 60 + 35),
				guest: guest('Sat', 'Later'),
			}),
			rsv({
				id: 'here',
				start: 12 * 60 + 45,
				status: 'arrived',
				partySize: 5,
				guest: guest('Here', 'Now'),
			}),
			rsv({
				id: 'soon',
				start: 13 * 60 + 30,
				status: 'confirmed',
				partySize: 4,
				guest: guest('Soon', 'Due'),
			}),
			rsv({
				id: 'dinner',
				start: 18 * 60,
				status: 'booked',
				guest: guest('Din', 'Ner'),
			}),
			rsv({
				id: 'gone',
				start: 11 * 60 + 30,
				status: 'booked',
				guest: guest('Never', 'Came'),
			}),
			rsv({
				id: 'ns',
				start: 11 * 60,
				status: 'no_show',
				noShowAt: now - 10 * MIN,
				guest: guest('Just', 'Marked'),
			}),
			rsv({ id: 'x', start: 14 * 60, status: 'cancelled' }),
		],
		{ services: SERVICES },
	)
	const ids = (list: Array<{ id: string }>) => list.map((r) => r.id)

	it('today: due in time order, seated longest first, missed and recent no-shows apart', () => {
		const list = bookList({ feed, waitlist: [], now, isToday: true })
		expect(ids(list.toSeat)).toEqual(['here', 'soon', 'dinner'])
		expect(ids(list.seated)).toEqual(['sat', 'sat2'])
		expect(ids(list.missed)).toEqual(['gone', 'ns'])
		expect(ids(list.finished)).toEqual(['early'])
	})
	it('narrows to a service but keeps whoever is at the stand or on the floor', () => {
		const dinner = bookList({
			feed,
			waitlist: [],
			now,
			isToday: true,
			serviceId: 'dinner',
		})
		// A lunch party already at the stand is still there at dinner time.
		expect(ids(dinner.toSeat)).toEqual(['here', 'dinner'])
		expect(ids(dinner.seated)).toEqual(['sat', 'sat2'])
		expect(ids(dinner.finished)).toEqual([])
	})
	it('filters every section by the search, live', () => {
		const list = bookList({
			feed,
			waitlist: [entry({ displayName: 'Sat Nav' })],
			now,
			isToday: true,
			query: 'sat',
		})
		expect(ids(list.seated)).toEqual(['sat', 'sat2'])
		expect(ids(list.toSeat)).toEqual([])
		expect(list.waitlist).toHaveLength(1)
		expect(
			bookList({ feed, waitlist: [], now, isToday: true, query: 'never' })
				.missed,
		).toHaveLength(1)
	})
	it('another day is a book to read: all that is booked, no waitlist', () => {
		const list = bookList({
			feed,
			waitlist: [entry()],
			now,
			isToday: false,
		})
		// Even a time that has passed is listed (it is not "missed" on a day we are not working).
		expect(ids(list.toSeat)).toEqual(['gone', 'here', 'soon', 'dinner'])
		expect(list.waitlist).toEqual([])
		expect(ids(list.missed)).toEqual(['ns'])
	})
	it('orders the waitlist by its position', () => {
		const a = entry({ position: 2, displayName: 'B' })
		const b = entry({ position: 1, displayName: 'A' })
		const list = bookList({ feed, waitlist: [a, b], now, isToday: true })
		expect(list.waitlist.map((e) => e.displayName)).toEqual(['A', 'B'])
	})
})

describe('the totals', () => {
	it('counts parties and covers that count, and what is left to do', () => {
		const now = at(13 * 60)
		const feed = day(
			[
				rsv({ start: 12 * 60, status: 'seated', partySize: 4 }),
				rsv({ start: 12 * 60 + 15, status: 'finished', partySize: 2 }),
				rsv({ start: 14 * 60, status: 'booked', partySize: 3 }),
				rsv({ start: 18 * 60, status: 'confirmed', partySize: 6 }),
				rsv({ start: 15 * 60, status: 'cancelled', partySize: 9 }),
				rsv({ start: 11 * 60, status: 'no_show', partySize: 5 }),
			],
			{ services: SERVICES },
		)
		expect(dayTotals({ feed, now, isToday: true })).toEqual({
			parties: 4,
			covers: 15,
			toSeat: 2,
			seated: 1,
		})
		expect(
			dayTotals({ feed, now, isToday: true, serviceId: 'dinner' }),
		).toEqual({
			// The dinner booking and the party seated at lunch who is still on the floor.
			parties: 2,
			covers: 10,
			toSeat: 1,
			seated: 1,
		})
	})
	it('counts a party at the stand whatever service is chosen', () => {
		const now = at(13 * 60)
		const feed = day(
			[
				rsv({ start: 12 * 60, status: 'arrived', partySize: 3 }),
				rsv({ start: 12 * 60 + 30, status: 'booked', partySize: 2 }),
				rsv({ start: 19 * 60, status: 'booked', partySize: 5 }),
			],
			{ services: SERVICES },
		)
		const totals = dayTotals({
			feed,
			now,
			isToday: true,
			serviceId: 'dinner',
		})
		expect(totals).toMatchObject({ parties: 2, covers: 8, toSeat: 2 })
	})
})

describe('search in other digits', () => {
	const maya = rsv({
		start: 12 * 60,
		guest: guest('Maya', 'Haddad', '+14155550142'),
		confirmationCode: 'AB7K2Q',
	})
	it('reads Arabic-Indic and Persian digits as 0 to 9', () => {
		expect(foldDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789')
		expect(foldDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789')
		expect(normalize('٠١٤٢')).toBe('0142')
	})
	it('finds a phone by its last digits typed on an Arabic keyboard', () => {
		expect(matchesReservation(maya, '٠١٤٢')).toBe(true)
		expect(matchesReservation(maya, '۰۱۴۲')).toBe(true)
		expect(matchesReservation(maya, '٠١٤٣')).toBe(false)
		// And a phone stored with Arabic digits is found by Western ones.
		const arabic = rsv({
			start: 600,
			guest: guest('Lina', 'S', '+٩٦٦٥٥٥٠١٤٢٧'),
		})
		expect(matchesReservation(arabic, '4276')).toBe(false)
		expect(matchesReservation(arabic, '1427')).toBe(true)
	})
	it('finds a table or code typed with Arabic digits', () => {
		const t = rsv({ start: 600, tableLabels: ['12'] })
		expect(matchesReservation(t, '١٢')).toBe(true)
	})
})

describe('bookings awaiting payment', () => {
	const now = at(13 * 60)
	const feed = day(
		[
			rsv({
				id: 'pay',
				start: 19 * 60,
				status: 'pending_payment',
				guest: guest('Pay', 'Later'),
			}),
			rsv({
				id: 'ok',
				start: 18 * 60,
				status: 'booked',
				guest: guest('Fine', 'Guest'),
			}),
		],
		{ services: SERVICES },
	)
	it('appear in their own group, in time order, and are never to seat', () => {
		const list = bookList({ feed, waitlist: [], now, isToday: true })
		expect(list.awaiting.map((r) => r.id)).toEqual(['pay'])
		expect(list.toSeat.map((r) => r.id)).toEqual(['ok'])
	})
	it('show on another day too, and are found by search', () => {
		expect(
			bookList({ feed, waitlist: [], now, isToday: false }).awaiting,
		).toHaveLength(1)
		expect(
			bookList({ feed, waitlist: [], now, isToday: true, query: 'pay' })
				.awaiting,
		).toHaveLength(1)
		expect(
			bookList({ feed, waitlist: [], now, isToday: true, query: 'fine' })
				.awaiting,
		).toHaveLength(0)
	})
	it('follow the service filter and count in the day', () => {
		expect(
			bookList({ feed, waitlist: [], now, isToday: true, serviceId: 'lunch' })
				.awaiting,
		).toHaveLength(0)
		expect(dayTotals({ feed, now, isToday: true }).parties).toBe(2)
	})
	it('are neither late nor due: they wait for the deposit', () => {
		const held = rsv({ start: 12 * 60, status: 'pending_payment' })
		expect(partyStatus(held, at(15 * 60)).kind).toBe('awaiting')
	})
})

describe('arrivals', () => {
	const before = day([
		rsv({ id: 'a', start: 720, status: 'confirmed' }),
		rsv({ id: 'b', start: 730, status: 'booked' }),
		rsv({ id: 'c', start: 740, status: 'arrived' }),
	])
	const later = day([
		rsv({ id: 'a', start: 720, status: 'arrived' }),
		rsv({ id: 'b', start: 730, status: 'arrived' }),
		rsv({ id: 'c', start: 740, status: 'arrived' }),
		rsv({ id: 'd', start: 750, status: 'arrived' }),
	])
	it('are the parties that came to the stand since the last look', () => {
		const ids = (list: Array<{ id: string }>) => list.map((r) => r.id)
		expect(ids(newArrivals(daySnapshot(before), later))).toEqual(['a', 'b'])
	})
	it('leave out ones this tablet marked itself, and a first look at the day', () => {
		expect(
			newArrivals(daySnapshot(before), later, new Set(['a'])).map((r) => r.id),
		).toEqual(['b'])
		expect(newArrivals(null, later)).toEqual([])
		// A booking made after the last look walks in already at the stand: not "arrived".
		expect(
			newArrivals(daySnapshot(before), later).some((r) => r.id === 'd'),
		).toBe(false)
	})
})

describe('an undo is not an arrival', () => {
	it('does not count a seating put back as someone arriving', () => {
		const before = day([rsv({ id: 's', start: 720, status: 'seated' })])
		const later = day([rsv({ id: 's', start: 720, status: 'arrived' })])
		expect(newArrivals(daySnapshot(before), later)).toEqual([])
	})
	it('does not count a no-show put right, or a party seated and then here', () => {
		const before = day([
			rsv({ id: 'n', start: 720, status: 'no_show' }),
			rsv({ id: 'p', start: 730, status: 'partially_seated' }),
		])
		const later = day([
			rsv({ id: 'n', start: 720, status: 'arrived' }),
			rsv({ id: 'p', start: 730, status: 'arrived' }),
		])
		expect(newArrivals(daySnapshot(before), later)).toEqual([])
	})
	it('counts a booking awaiting payment, or a request, that turns up', () => {
		const before = day([
			rsv({ id: 'a', start: 720, status: 'pending_payment' }),
			rsv({ id: 'b', start: 730, status: 'requested' }),
		])
		const later = day([
			rsv({ id: 'a', start: 720, status: 'arrived' }),
			rsv({ id: 'b', start: 730, status: 'arrived' }),
		])
		expect(newArrivals(daySnapshot(before), later).map((r) => r.id)).toEqual([
			'a',
			'b',
		])
	})
})

describe('what changed in the book', () => {
	const NOW = at(13 * 60)
	const kinds = (
		before: ReturnType<typeof daySnapshot> | null,
		feed: ReturnType<typeof day>,
		byUs?: Set<string>,
	) =>
		dayNotices(before, feed, { now: NOW, byUs }).map((n) => [
			n.kind,
			n.reservation.id,
		])
	const existing = day([
		rsv({ id: 'x', start: 1200, status: 'booked', partySize: 2 }),
		rsv({ id: 'y', start: 1230, status: 'confirmed', partySize: 4 }),
	])

	it('says nothing on the first look at a day', () => {
		expect(kinds(null, existing)).toEqual([])
	})

	it('announces a booking a guest made online or in an app, once it is new', () => {
		const later = day([
			...existing.reservations,
			rsv({ id: 'o', start: 1260, channel: 'online', createdAt: NOW - 60_000 }),
			rsv({ id: 'a', start: 1290, channel: 'native', createdAt: NOW - 60_000 }),
			// Made by staff: the stand knows about its own.
			rsv({ id: 'p', start: 1320, channel: 'phone', createdAt: NOW - 60_000 }),
			rsv({ id: 'h', start: 1350, channel: 'host', createdAt: NOW - 60_000 }),
		])
		expect(kinds(daySnapshot(existing), later)).toEqual([
			['online', 'o'],
			['online', 'a'],
		])
	})

	it('does not call an old booking new because it moved onto this day', () => {
		const later = day([
			...existing.reservations,
			rsv({
				id: 'm',
				start: 1260,
				channel: 'online',
				createdAt: NOW - 3 * 3600_000,
			}),
			rsv({
				id: 'z',
				start: 1290,
				channel: 'online',
				status: 'cancelled',
				createdAt: NOW,
			}),
		])
		expect(kinds(daySnapshot(existing), later)).toEqual([])
		// A booking with no creation time yet is taken as new.
		const unknown = day([
			...existing.reservations,
			rsv({ id: 'u', start: 1260, channel: 'online' }),
		])
		expect(kinds(daySnapshot(existing), unknown)).toEqual([['online', 'u']])
	})

	it('announces a cancelled booking, and a party size that changed', () => {
		const later = day([
			rsv({ id: 'x', start: 1200, status: 'cancelled', partySize: 2 }),
			rsv({ id: 'y', start: 1230, status: 'confirmed', partySize: 6 }),
		])
		const notices = dayNotices(daySnapshot(existing), later, { now: NOW })
		expect(notices.map((n) => n.kind)).toEqual(['cancelled', 'size'])
		expect(notices[1]).toMatchObject({ kind: 'size', from: 4 })
	})

	it('leaves out what this tablet did itself, and what was never standing', () => {
		const later = day([
			rsv({ id: 'x', start: 1200, status: 'cancelled', partySize: 2 }),
			rsv({ id: 'y', start: 1230, status: 'confirmed', partySize: 6 }),
		])
		expect(kinds(daySnapshot(existing), later, new Set(['x', 'y']))).toEqual([])
		// A party that finished and is edited later is no news at the stand.
		const done = day([
			rsv({ id: 'f', start: 700, status: 'finished', partySize: 2 }),
		])
		const edited = day([
			rsv({ id: 'f', start: 700, status: 'finished', partySize: 3 }),
		])
		expect(kinds(daySnapshot(done), edited)).toEqual([])
	})
})
