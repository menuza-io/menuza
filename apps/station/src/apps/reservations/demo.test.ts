import { describe, expect, it } from 'vitest'
import { HostApiError } from './api.ts'
import {
	createDemoHostApi,
	demoShift,
	toE164,
	type DemoControls,
	type DemoHostOptions,
} from './demo.ts'
import { dayFeedSchema, tableState, type DayFeed } from './feed.ts'
import { newlyFree, pickOffer, tableKinds } from './freeTable.ts'
import { textQueuedOf } from './waitlist.ts'
import { addDays, zonedDate, zonedMinutes } from './zoned.ts'

const MIN = 60_000
const ZONE = 'UTC'
/** 1:20 PM on a Saturday: the sample is built around this clock. */
const T0 = Date.UTC(2026, 9, 24, 13, 20)

function demo(options: DemoHostOptions = {}) {
	let now = T0
	const api = createDemoHostApi({ now: () => now, timeZone: ZONE, ...options })
	return {
		api,
		advance: (minutes: number) => (now += minutes * MIN),
		now: () => now,
		today: () => zonedDate(now, ZONE),
		async feed(date?: string): Promise<DayFeed> {
			const answer = await api.day(undefined, date)
			if ('unchanged' in answer) throw new Error('unexpected 304')
			return answer.feed
		},
	}
}

const refusal = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(error: unknown) =>
			error instanceof HostApiError ? [error.status, error.code] : error,
	)

const named = (feed: DayFeed, first: string) =>
	feed.reservations.find((r) => r.guest?.firstName === first)!

describe('the sample day', () => {
	it('is a realistic day: rooms, tables, services, a waitlist, every kind of party', async () => {
		const d = demo()
		const feed = await d.feed()
		expect(dayFeedSchema.safeParse(feed).success).toBe(true)
		expect(feed.businessDate).toBe('2026-10-24')
		expect(feed.areas.map((a) => a.name)).toEqual(['Main room', 'Patio'])
		expect(feed.tables).toHaveLength(18)
		expect(feed.services.map((s) => s.name)).toEqual(['Lunch', 'Dinner'])
		expect(feed.reservations.length).toBeGreaterThanOrEqual(14)
		const statuses = new Set(feed.reservations.map((r) => r.status))
		for (const status of [
			'booked',
			'confirmed',
			'arrived',
			'seated',
			'finished',
			'no_show',
		])
			expect(statuses.has(status)).toBe(true)
		expect(feed.reservations.some((r) => (r.runningLateMin ?? 0) > 0)).toBe(
			true,
		)
		expect(feed.reservations.some((r) => r.hasAllergy)).toBe(true)
		expect(
			feed.reservations.some((r) =>
				r.guest?.tags.some((t) => /vip/i.test(t.name)),
			),
		).toBe(true)
		expect(feed.reservations.some((r) => r.occasion)).toBe(true)
		expect(feed.pacing.length).toBeGreaterThan(10)
		const list = await d.api.waitlist()
		expect(list.entries).toHaveLength(6)
		expect(list.entries.every((e) => e.quotedMin !== null)).toBe(true)
	})

	it('has something happening now, whatever the hour: seated, one at the stand, one late', async () => {
		for (const hour of [3, 9, 13, 20, 23]) {
			const real = Date.UTC(2026, 9, 24, hour, 5)
			// The demo's own clock moves a morning or a night into the afternoon.
			const now = real + demoShift(real, ZONE)
			const minutes = zonedMinutes(now, ZONE)
			expect(minutes).toBeGreaterThanOrEqual(13 * 60 + 30)
			expect(minutes).toBeLessThanOrEqual(19 * 60 + 30)
			const api = createDemoHostApi({ now: () => now, timeZone: ZONE })
			const answer = await api.day()
			if ('unchanged' in answer) throw new Error('304')
			const feed = answer.feed
			expect(
				feed.reservations.filter((r) => r.status === 'arrived').length,
			).toBeGreaterThan(0)
			const seated = feed.reservations.filter((r) => r.status === 'seated')
			expect(seated.length).toBeGreaterThan(2)
			// Nobody has been seated since a time that has not come yet.
			for (const r of seated) expect(r.seatedAt!).toBeLessThanOrEqual(now)
			// Someone is late: booked, time gone by, nobody at the stand.
			expect(
				feed.reservations.some(
					(r) => r.status === 'confirmed' && r.startAt < now - 15 * MIN,
				),
			).toBe(true)
		}
		// The clock keeps an afternoon as it is.
		expect(demoShift(Date.UTC(2026, 9, 24, 15, 7), ZONE)).toBe(0)
	})

	it('answers “unchanged” to an ETag it gave, and a new one after a change', async () => {
		const d = demo()
		const first = await d.api.day()
		if ('unchanged' in first) throw new Error('304')
		expect(await d.api.day(first.etag!)).toEqual({ unchanged: true })
		const yusuf = named(first.feed, 'Yusuf')
		await d.api.transition(yusuf.id, 'arrived', {
			expectedVersion: yusuf.version,
		})
		const after = await d.api.day(first.etag!)
		expect('feed' in after && after.etag !== first.etag).toBe(true)
	})
})

describe('seating', () => {
	it('puts a party on a free table, and refuses a table with someone on it', async () => {
		const d = demo()
		const feed = await d.feed()
		const rana = named(feed, 'Rana')
		const seatedTable = feed.reservations.find((r) => r.status === 'seated')!
			.tableIds[0]!
		expect(
			await refusal(
				d.api.transition(rana.id, 'seated', {
					tableIds: [seatedTable],
					expectedVersion: rana.version,
				}),
			),
			// A party sitting there is never moved to make room: the server's `locked_table_conflict`.
		).toEqual([409, 'locked_table_conflict'])
		await d.api.transition(rana.id, 'seated', {
			tableIds: ['t6'],
			expectedVersion: rana.version,
		})
		const after = await d.feed()
		const seated = after.reservations.find((r) => r.id === rana.id)!
		expect(seated).toMatchObject({
			status: 'seated',
			tableIds: ['t6'],
			tableLabels: ['6'],
		})
		expect(
			tableState(
				after.tables.find((t) => t.id === 't6')!,
				after,
				d.now(),
			).kind,
		).toBe('seated')
	})

	it('refuses a table booked before the party would be done, unless the host insists', async () => {
		const d = demo()
		const feed = await d.feed()
		const rana = named(feed, 'Rana')
		// Table 8 is booked for Ahmed within the half hour: Rana's stay would run into
		// it, and he is too close to his time to be moved (the server's freeze window).
		expect(
			await refusal(
				d.api.transition(rana.id, 'seated', {
					tableIds: ['t8'],
					expectedVersion: rana.version,
				}),
			),
		).toEqual([409, 'locked_table_conflict'])
		await d.api.transition(rana.id, 'seated', {
			tableIds: ['t8'],
			expectedVersion: rana.version,
			overbook: true,
			overbookReason: 'Seated at the host stand',
		})
		expect(
			(await d.feed()).reservations.find((r) => r.id === rana.id)!.status,
		).toBe('seated')
	})

	it('refuses a table taped off right now even when the host insists', async () => {
		const d = demo()
		const rana = named(await d.feed(), 'Rana')
		expect(
			await refusal(
				d.api.transition(rana.id, 'seated', {
					tableIds: ['p3'],
					expectedVersion: rana.version,
					overbook: true,
				}),
			),
		).toEqual([409, 'table_occupied'])
	})

	it('refuses a version that changed under the host', async () => {
		const d = demo()
		const rana = named(await d.feed(), 'Rana')
		expect(
			await refusal(
				d.api.transition(rana.id, 'seated', {
					tableIds: ['t6'],
					expectedVersion: rana.version + 1,
				}),
			),
		).toEqual([409, 'stale_version'])
	})

	it('seats a walk-in, and the same key never seats them twice', async () => {
		const d = demo()
		const before = await d.feed()
		await d.api.walkIn(
			{ partySize: 2, tableIds: ['t6'], guestName: 'Kim Lee' },
			'key-1',
		)
		await d.api.walkIn(
			{ partySize: 2, tableIds: ['t6'], guestName: 'Kim Lee' },
			'key-1',
		)
		const after = await d.feed()
		expect(after.reservations).toHaveLength(before.reservations.length + 1)
		const kim = after.reservations.find((r) => r.guest?.firstName === 'Kim')!
		expect(kim).toMatchObject({
			status: 'seated',
			channel: 'walk_in',
			tableIds: ['t6'],
		})
		// The table is theirs now.
		expect(
			await refusal(d.api.walkIn({ partySize: 2, tableIds: ['t6'] }, 'key-2')),
		).toEqual([409, 'table_occupied'])
	})
})

describe('undo', () => {
	it('puts a seated party back at the stand, within half an hour', async () => {
		const d = demo()
		const rana = named(await d.feed(), 'Rana')
		await d.api.transition(rana.id, 'seated', {
			tableIds: ['t6'],
			expectedVersion: rana.version,
		})
		await d.api.undo(rana.id)
		expect(
			(await d.feed()).reservations.find((r) => r.id === rana.id),
		).toMatchObject({
			status: 'arrived',
			seatedAt: null,
		})
		// Seated again, then too long ago to undo.
		const again = (await d.feed()).reservations.find((r) => r.id === rana.id)!
		await d.api.transition(rana.id, 'seated', {
			tableIds: ['t6'],
			expectedVersion: again.version,
		})
		d.advance(31)
		expect(await refusal(d.api.undo(rana.id))).toEqual([
			409,
			'undo_window_expired',
		])
	})

	it('puts back a cleared table, if nobody has taken it', async () => {
		const d = demo()
		const omar = named(await d.feed(), 'Omar')
		await d.api.transition(omar.id, 'finished', {
			expectedVersion: omar.version,
		})
		await d.api.undo(omar.id)
		expect(
			(await d.feed()).reservations.find((r) => r.id === omar.id)!.status,
		).toBe('seated')
		// Cleared, then someone else is put there: the undo is refused.
		const fresh = (await d.feed()).reservations.find((r) => r.id === omar.id)!
		await d.api.transition(omar.id, 'finished', {
			expectedVersion: fresh.version,
		})
		await d.api.walkIn({ partySize: 2, tableIds: [omar.tableIds[0]!] })
		expect(await refusal(d.api.undo(omar.id))).toEqual([409, 'table_occupied'])
	})

	it('takes back a no-show within half an hour of marking it', async () => {
		const d = demo()
		const dana = named(await d.feed(), 'Dana')
		expect(dana.status).toBe('no_show')
		await d.api.undo(dana.id)
		expect(
			(await d.feed()).reservations.find((r) => r.id === dana.id)!.status,
		).not.toBe('no_show')
	})

	it('cannot undo a walk-in’s seating (there is no booking to go back to)', async () => {
		const d = demo()
		const made = (await d.api.walkIn({ partySize: 2, tableIds: ['t6'] })) as {
			reservation: { id: string }
		}
		expect(await refusal(d.api.undo(made.reservation.id))).toEqual([
			409,
			'cannot_undo',
		])
	})
})

describe('no-shows', () => {
	it('only fifteen minutes after the booked time', async () => {
		const d = demo()
		const feed = await d.feed()
		// Tariq is booked for "now": too early.
		const tariq = named(feed, 'Tariq')
		expect(
			await refusal(
				d.api.transition(tariq.id, 'no_show', {
					expectedVersion: tariq.version,
				}),
			),
		).toEqual([409, 'too_early'])
		d.advance(16)
		await d.api.transition(tariq.id, 'no_show', {
			expectedVersion: tariq.version,
		})
		const after = (await d.feed()).reservations.find((r) => r.id === tariq.id)!
		expect(after.status).toBe('no_show')
		expect(typeof after.noShowAt).toBe('number')
		// It can be put right (back to what it was).
		await d.api.undo(tariq.id)
		expect(
			(await d.feed()).reservations.find((r) => r.id === tariq.id)!.status,
		).toBe('booked')
	})
})

describe('another day', () => {
	it('is a book to read: seating, arrival and no-shows are refused as not today', async () => {
		const d = demo()
		const tomorrow = addDays(d.today(), 1)
		const feed = await d.feed(tomorrow)
		expect(feed.businessDate).toBe(tomorrow)
		expect(feed.reservations.length).toBeGreaterThanOrEqual(6)
		expect(
			feed.reservations.every((r) =>
				['booked', 'confirmed'].includes(r.status),
			),
		).toBe(true)
		// The same day, asked twice, is the same day.
		expect((await d.feed(tomorrow)).reservations.map((r) => r.id)).toEqual(
			feed.reservations.map((r) => r.id),
		)
		const r = feed.reservations[0]!
		for (const to of ['arrived', 'seated', 'no_show'] as const)
			expect(
				await refusal(
					d.api.transition(r.id, to, {
						tableIds: ['t1'],
						expectedVersion: r.version,
					}),
				),
			).toEqual([409, 'not_today'])
		// Confirming and cancelling ahead are allowed.
		await d.api.transition(r.id, 'cancelled', { expectedVersion: r.version })
		expect(
			(await d.feed(tomorrow)).reservations.find((x) => x.id === r.id)!.status,
		).toBe('cancelled')
		// Today's feed is untouched.
		expect((await d.feed()).businessDate).toBe(d.today())
	})

	it('a past day shows who came and who did not', async () => {
		const d = demo()
		const feed = await d.feed(addDays(d.today(), -1))
		expect(feed.reservations.some((r) => r.status === 'finished')).toBe(true)
		expect(
			feed.reservations.every((r) =>
				['finished', 'no_show'].includes(r.status),
			),
		).toBe(true)
	})
})

describe('booking', () => {
	it('lists open times, and takes a booking into one', async () => {
		const d = demo()
		const date = addDays(d.today(), 1)
		const open = await d.api.availability(date, 2)
		const slot = open.slots.find((s) => s.available)!
		expect(slot.suggestedTableIds).toHaveLength(1)
		const made = (await d.api.book(
			{
				date,
				time: slot.time,
				partySize: 2,
				firstName: 'Zed',
				lastName: 'Ali',
				phone: '+14155550000',
				notes: 'Window',
			},
			'book-1',
		)) as { reservation: { id: string; confirmationCode: string } }
		expect(made.reservation.confirmationCode).toMatch(/^[A-Z2-9]{6}$/)
		const feed = await d.feed(date)
		const booked = feed.reservations.find((r) => r.id === made.reservation.id)!
		expect(booked).toMatchObject({
			status: 'booked',
			partySize: 2,
			time: slot.time,
			channel: 'host',
			staffNotes: 'Window',
		})
		expect(booked.tableIds).toEqual(slot.suggestedTableIds)
		// The same key is the same booking.
		await d.api.book(
			{
				date,
				time: slot.time,
				partySize: 2,
				firstName: 'Zed',
				lastName: 'Ali',
				phone: null,
				notes: null,
			},
			'book-1',
		)
		expect((await d.feed(date)).reservations).toHaveLength(
			feed.reservations.length,
		)
	})

	it('refuses a time that is not open: one that has passed, or whose tables are taken', async () => {
		const d = demo()
		const today = d.today()
		// 11:00 has gone by at 1:20 PM.
		expect(
			await refusal(
				d.api.book({
					date: today,
					time: '11:00',
					partySize: 2,
					firstName: 'A',
					lastName: 'B',
					phone: null,
					notes: null,
				}),
			),
		).toEqual([409, 'slot_unavailable'])
		// A party of fourteen fits no table, and no combination.
		const big = await d.api.availability(addDays(today, 1), 14)
		expect(big.slots.every((s) => !s.available)).toBe(true)
	})

	it('books the table the host started from, when it is free then; else refuses', async () => {
		const d = demo()
		const date = addDays(d.today(), 3)
		const slot = (await d.api.availability(date, 2)).slots.find(
			(s) => s.available,
		)!
		await d.api.book({
			date,
			time: slot.time,
			partySize: 2,
			firstName: 'Pat',
			lastName: 'Q',
			phone: null,
			notes: null,
			tableIds: ['t3'],
		})
		const pat = (await d.feed(date)).reservations.find(
			(r) => r.guest?.firstName === 'Pat',
		)!
		expect(pat.tableIds).toEqual(['t3'])
		// The same table at the same time is taken now.
		expect(
			await refusal(
				d.api.book({
					date,
					time: slot.time,
					partySize: 2,
					firstName: 'Quin',
					lastName: 'R',
					phone: null,
					notes: null,
					tableIds: ['t3'],
				}),
			),
		).toEqual([409, 'slot_unavailable'])
	})

	it('changes a party’s size and lets go of a table it no longer fits', async () => {
		const d = demo()
		const elena = named(await d.feed(), 'Elena')
		expect(elena.tableIds).toEqual(['p4'])
		await d.api.changeParty(elena.id, { partySize: 6 }, elena.version)
		const after = (await d.feed()).reservations.find((r) => r.id === elena.id)!
		expect(after).toMatchObject({ partySize: 6, tableIds: [] })
		expect(
			await refusal(
				d.api.changeParty(elena.id, { partySize: 2 }, elena.version),
			),
		).toEqual([409, 'stale_version'])
	})

	it('moves a booking to a new time', async () => {
		const d = demo()
		const priya = named(await d.feed(), 'Priya')
		await d.api.changeParty(priya.id, { time: '21:00' }, priya.version)
		const after = (await d.feed()).reservations.find((r) => r.id === priya.id)!
		expect(after).toMatchObject({ time: '21:00', localStartMin: 21 * 60 })
		expect(zonedMinutes(after.startAt, ZONE)).toBe(21 * 60)
		expect(after.endAt - after.startAt).toBe(after.durationMin * MIN)
	})
})

describe('the waitlist', () => {
	it('quotes a wait, adds a party, texts them, and seats them', async () => {
		const d = demo()
		const waiting = (await d.api.waitlist()).entries.length
		const quote = await d.api.waitlistQuote(2)
		expect(quote.position).toBe(waiting + 1)
		expect(quote.quotedMin).toBeGreaterThan(0)
		const entry = await d.api.joinWaitlist(
			{ displayName: 'Lina Haddad', partySize: 2, phone: '+14155550999' },
			'wl-1',
		)
		expect(entry).toMatchObject({
			status: 'waiting',
			partySize: 2,
			firstName: 'Lina',
		})
		await d.api.joinWaitlist(
			{ displayName: 'Lina Haddad', partySize: 2, phone: '+14155550999' },
			'wl-1',
		)
		expect((await d.api.waitlist()).entries).toHaveLength(waiting + 1)

		await d.api.notifyWaitlist(entry!.id, entry!.version)
		const told = (await d.api.waitlist()).entries.find(
			(e) => e.id === entry!.id,
		)!
		expect(told.status).toBe('notified')
		expect(
			await refusal(d.api.notifyWaitlist(entry!.id, entry!.version)),
		).toEqual([409, 'stale_version'])

		await d.api.seatWaitlist(entry!.id, ['t6'], told.version)
		expect(
			(await d.api.waitlist()).entries.some((e) => e.id === entry!.id),
		).toBe(false)
		const seated = (await d.feed()).reservations.find(
			(r) => r.guest?.firstName === 'Lina',
		)!
		expect(seated).toMatchObject({ status: 'seated', tableIds: ['t6'] })
	})

	it('marks a party with no number ready without a text, and lets one leave', async () => {
		const d = demo()
		const sofia = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Sofia',
		)!
		expect(sofia.phone).toBeNull()
		// Marking ready works; the answer says no text was queued.
		const answer = await d.api.notifyWaitlist(sofia.id, sofia.version)
		expect(textQueuedOf(answer)).toBe(false)
		const told = (await d.api.waitlist()).entries.find(
			(e) => e.id === sofia.id,
		)!
		expect(told.status).toBe('notified')
		await d.api.leaveWaitlist(sofia.id, told.version)
		expect(
			(await d.api.waitlist()).entries.some((e) => e.id === sofia.id),
		).toBe(false)
	})

	it('records a hold that ran out as no response, not as left', async () => {
		const d = demo()
		const amira = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Amira',
		)!
		const answer = (await d.api.leaveWaitlist(
			amira.id,
			amira.version,
			'no_response',
		)) as { entry: { status: string } }
		expect(answer.entry.status).toBe('no_response')
		// Out of the line, but kept a while on the stand to be put back.
		expect(
			(await d.api.waitlist()).entries.find((e) => e.id === amira.id)?.status,
		).toBe('no_response')
		const wei = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Wei',
		)!
		const left = (await d.api.leaveWaitlist(wei.id, wei.version)) as {
			entry: { status: string }
		}
		expect(left.entry.status).toBe('left')
	})

	it('seating them anyway is the same rules as a booking: not on a taken table', async () => {
		const d = demo()
		const jamal = (await d.api.waitlist()).entries[0]!
		const seatedTable = (await d.feed()).reservations.find(
			(r) => r.status === 'seated',
		)!.tableIds[0]!
		expect(
			await refusal(d.api.seatWaitlist(jamal.id, [seatedTable], jamal.version)),
		).toEqual([409, 'table_occupied'])
	})
})

describe('the sample for the guest card and the notices', () => {
	it('has a booking held for its deposit, and one made online a few minutes ago', async () => {
		const d = demo()
		const feed = await d.feed()
		const held = named(feed, 'Dalia')
		expect(held).toMatchObject({
			status: 'pending_payment',
			paymentStatus: 'pending',
			channel: 'online',
		})
		const fresh = named(feed, 'Nadia')
		expect(fresh).toMatchObject({
			status: 'booked',
			channel: 'online',
			client: 'ios',
			paymentStatus: 'paid',
		})
		expect(d.now() - fresh.createdAt!).toBeLessThanOrEqual(10 * MIN)
		// A booking made at the stand today is as new as it gets; the others are older.
		expect(d.now() - named(feed, 'Chris').createdAt!).toBeGreaterThan(60 * MIN)
	})

	it('has a regular with several tags and a record, and a no-show with a bad one', async () => {
		const d = demo()
		const feed = await d.feed()
		const regular = named(feed, 'Giulia')
		expect(regular.guest!.tags.map((t) => t.name)).toEqual([
			'VIP',
			'Wine lover',
			'Friend of chef',
		])
		expect(regular.guest).toMatchObject({ visits: 9 })
		expect(regular.guest!.lastVisitAt).toBeLessThan(d.now())
		const missed = named(feed, 'Dana')
		expect(missed.status).toBe('no_show')
		expect(missed.guest).toMatchObject({
			visits: 3,
			noShows: 2,
			lateCancels: 1,
		})
		// Pinned notes ride with the guest.
		expect(named(feed, 'Marco').guest!.pinnedNotes).toHaveLength(1)
	})

	it('has an allergy told only in codes, with no free text of the guest’s own', async () => {
		const d = demo()
		const hannah = named(await d.feed(), 'Hannah')
		expect(hannah.dietaryCodes).toEqual([
			'shellfish_allergy',
			'nut_allergy',
			'gluten_free',
		])
		expect(hannah.hasAllergy).toBe(true)
		expect(hannah.guest!.allergyNotes).toBeNull()
		// The older sample still has its free-text allergies.
		expect(named(await d.feed(), 'Omar').guest!.allergyNotes).toMatch(
			/peanuts/i,
		)
	})

	it('has a party told their table is ready, one who joined online, one with no consent', async () => {
		const d = demo()
		const { entries } = await d.api.waitlist()
		const told = entries.find((e) => e.firstName === 'Amira')!
		expect(told).toMatchObject({ status: 'notified' })
		expect(told.notifiedAt).toBeLessThan(d.now())
		expect(told.responseDeadlineAt).toBeGreaterThan(d.now())
		expect(entries.find((e) => e.firstName === 'Theo')).toMatchObject({
			channel: 'remote',
			smsOptIn: true,
		})
		expect(entries.find((e) => e.firstName === 'Bilal')).toMatchObject({
			phone: expect.any(String),
			smsOptIn: false,
		})
	})

	it('marks a party with no consent ready, says no text was queued, and refuses one already told', async () => {
		const d = demo()
		const { entries } = await d.api.waitlist()
		const bilal = entries.find((e) => e.firstName === 'Bilal')!
		const answer = await d.api.notifyWaitlist(bilal.id, bilal.version)
		expect(answer).toMatchObject({ changed: true, textQueued: false })
		const amira = entries.find((e) => e.firstName === 'Amira')!
		expect(
			await refusal(d.api.notifyWaitlist(amira.id, amira.version)),
		).toEqual([409, 'invalid_status_transition'])
	})

	it('lets the hold run out: the deadline passes with the clock', async () => {
		const d = demo()
		const amira = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Amira',
		)!
		d.advance(7)
		expect(d.now()).toBeGreaterThan(amira.responseDeadlineAt!)
		// Still on the list: the host decides, the sample does not expire them.
		expect(
			(await d.api.waitlist()).entries.some((e) => e.id === amira.id),
		).toBe(true)
	})
})

describe('the connection going down', () => {
	it('fails every call as an unreachable server does, and comes back', async () => {
		const d = demo()
		const controls = (d.api as unknown as { controls: DemoControls }).controls
		const elena = named(await d.feed(), 'Elena')
		controls.setOffline(true)
		expect(await refusal(d.api.day())).toEqual([0, 'network_unavailable'])
		expect(await refusal(d.api.grant())).toEqual([0, 'network_unavailable'])
		expect(
			await refusal(
				d.api.transition(elena.id, 'arrived', {
					expectedVersion: elena.version,
				}),
			),
		).toEqual([0, 'network_unavailable'])
		controls.setOffline(false)
		// Nothing was changed while it was down.
		const after = named(await d.feed(), 'Elena')
		expect(after.status).toBe(elena.status)
	})
})

describe('what other people do while the host looks', () => {
	it('a guest books online, cancels, changes the size, another host marks a party here', async () => {
		const d = demo()
		const controls = (d.api as unknown as { controls: DemoControls }).controls
		const before = (await d.feed()).reservations.length
		const id = controls.bookOnline({ name: ['Zara', 'Quinn'], party: 3 })
		let feed = await d.feed()
		expect(feed.reservations).toHaveLength(before + 1)
		const made = feed.reservations.find((r) => r.id === id)!
		expect(made).toMatchObject({
			channel: 'online',
			status: 'booked',
			partySize: 3,
		})
		expect(d.now() - made.createdAt!).toBeLessThan(MIN)
		controls.resize(id, 5)
		feed = await d.feed()
		expect(feed.reservations.find((r) => r.id === id)!.partySize).toBe(5)
		controls.cancel(id)
		feed = await d.feed()
		expect(feed.reservations.find((r) => r.id === id)!.status).toBe('cancelled')
		const booked = named(feed, 'Elena')
		controls.arrive(booked.id)
		feed = await d.feed()
		expect(feed.reservations.find((r) => r.id === booked.id)!.status).toBe(
			'arrived',
		)
	})

	it('changes the ETag, so the stand’s next look sees it', async () => {
		const d = demo()
		const controls = (d.api as unknown as { controls: DemoControls }).controls
		const first = await d.api.day()
		if ('unchanged' in first) throw new Error('unexpected 304')
		controls.bookOnline({})
		const next = await d.api.day(first.etag ?? undefined)
		expect('unchanged' in next).toBe(false)
	})
})

describe('the texting of the waitlist, as the server does it', () => {
	const NAMES = ['Jamal', 'Sofia', 'Wei', 'Theo', 'Bilal'] as const
	/** The entry's answer to "tell them it's ready": was a text queued? */
	async function told(options: DemoHostOptions, first: string) {
		const d = demo(options)
		const entry = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === first,
		)!
		return textQueuedOf(await d.api.notifyWaitlist(entry.id, entry.version))
	}

	// number x consent x node: only a guest with a number AND consent, on a node that texts, is texted.
	const expected = (
		phone: boolean,
		consent: boolean,
		sms: boolean,
		quirk = false,
	) => phone && consent && sms && !quirk
	const SEEDS: Record<(typeof NAMES)[number], [boolean, boolean, boolean]> = {
		// [has a number, agreed to texts, this entry simulates an SMS-less node]
		Jamal: [true, true, true],
		Sofia: [false, false, false],
		Wei: [true, false, false],
		Theo: [true, true, false],
		Bilal: [true, false, false],
	}
	for (const name of NAMES)
		for (const sms of [true, false]) {
			const [phone, consent, quirk] = SEEDS[name]
			it(`${name}, ${sms ? 'a node that texts' : 'a KSA node with no SMS'}: textQueued is ${expected(phone, consent, sms, quirk)}`, async () => {
				expect(await told({ smsEnabled: sms }, name)).toBe(
					expected(phone, consent, sms, quirk),
				)
			})
		}

	it('has a party who joined online, agreed, and gets the text', async () => {
		const d = demo()
		const theo = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Theo',
		)!
		expect(theo).toMatchObject({ channel: 'remote', smsOptIn: true })
		const answer = await d.api.notifyWaitlist(theo.id, theo.version)
		expect(answer).toMatchObject({ changed: true, textQueued: true })
	})

	it('has no consent for a party added at the stand, whatever number it was given', async () => {
		const d = demo()
		const joined = (await d.api.joinWaitlist({
			displayName: 'Maha Nasser',
			partySize: 2,
			phone: '+966 55 123 4567',
		})) as { id: string; version: number; smsOptIn: boolean; phone: string }
		expect(joined.smsOptIn).toBe(false)
		// Stored the way the server keeps a number.
		expect(joined.phone).toBe('+966551234567')
		const answer = await d.api.notifyWaitlist(joined.id, joined.version)
		expect(textQueuedOf(answer)).toBe(false)
	})

	it('can be switched to an SMS-less node while the stand is open', async () => {
		const d = demo()
		const controls = (d.api as unknown as { controls: DemoControls }).controls
		controls.setSmsEnabled(false)
		const theo = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Theo',
		)!
		expect(
			textQueuedOf(await d.api.notifyWaitlist(theo.id, theo.version)),
		).toBe(false)
	})

	it('marks a party already told as such, and refuses to tell them twice', async () => {
		const d = demo()
		const theo = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Theo',
		)!
		await d.api.notifyWaitlist(theo.id, theo.version)
		expect(
			await refusal(d.api.notifyWaitlist(theo.id, theo.version + 1)),
		).toEqual([409, 'invalid_status_transition'])
	})
})

describe('phone numbers, stored as the server stores them', () => {
	it('become E.164 from what a host types', () => {
		expect(toE164('+1 212 555 0100')).toBe('+12125550100')
		expect(toE164('(415) 555-0142')).toBe('+14155550142')
		expect(toE164('00966 55 123 4567')).toBe('+966551234567')
		expect(toE164('055 123 4567')).toBe('+966551234567')
		expect(toE164('+٩٦٦٥٥١٢٣٤٥٦٧')).toBe('+966551234567')
		expect(toE164('')).toBeNull()
		expect(toE164(null)).toBeNull()
		expect(toE164('abc')).toBeNull()
	})
	it('are kept so on a booking made at the stand', async () => {
		const d = demo()
		const slot = (await d.api.availability(d.today(), 2)).slots.find(
			(s) => s.available,
		)!
		const made = (await d.api.book({
			date: d.today(),
			time: slot.time,
			localStartMin: slot.localStartMin,
			partySize: 2,
			firstName: 'Hind',
			lastName: 'Said',
			phone: '+971 50 123 4567',
			notes: null,
		})) as { reservation: { guest: { phone: string } } }
		expect(made.reservation.guest.phone).toBe('+971501234567')
	})
	it('are all E.164 in the sample', async () => {
		const d = demo()
		const feed = await d.feed()
		for (const r of feed.reservations)
			if (r.guest?.phone) expect(r.guest.phone).toMatch(/^\+\d{8,15}$/)
		for (const e of (await d.api.waitlist()).entries)
			if (e.phone) expect(e.phone).toMatch(/^\+\d{8,15}$/)
	})
})

describe('seen without the guest-details grant', () => {
	it('sends only the end of a number, no allergy notes and no pinned notes', async () => {
		const d = demo({ canReadGuest: false })
		expect((await d.api.grant()).canReadGuest).toBe(false)
		const feed = await d.feed()
		const marco = named(feed, 'Marco')
		expect(marco.guest!.phone).toBe('••••0112')
		expect(marco.guest!.pinnedNotes).toEqual([])
		const omar = named(feed, 'Omar')
		expect(omar.guest!.allergyNotes).toBeNull()
		expect(omar.dietaryNotes).toBeNull()
		// The flag still says there is something: a manager can read it.
		expect(omar.hasAllergy).toBe(true)
		for (const e of (await d.api.waitlist()).entries)
			if (e.phone) expect(e.phone).toMatch(/^••••\d{4}$/)
	})
	it('sends all of it with the grant, and switches while the stand is open', async () => {
		const d = demo()
		expect((await d.api.grant()).canReadGuest).toBe(true)
		const first = await d.api.day()
		if ('unchanged' in first) throw new Error('unexpected 304')
		expect(named(first.feed, 'Marco').guest!.phone).toBe('+14155550112')
		const controls = (d.api as unknown as { controls: DemoControls }).controls
		controls.setGuestDetails(false)
		expect((await d.api.grant()).canReadGuest).toBe(false)
		// The held day is read again: its ETag changed.
		const again = await d.api.day(first.etag ?? undefined)
		if ('unchanged' in again) throw new Error('the day should be read again')
		expect(named(again.feed, 'Marco').guest!.phone).toBe('••••0112')
		controls.setGuestDetails(true)
		const back = await d.api.day()
		if ('unchanged' in back) throw new Error('unexpected 304')
		expect(named(back.feed, 'Marco').guest!.phone).toBe('+14155550112')
	})
})

describe('tables kept through a reset', () => {
	it('send each table’s reset buffer, and a party that just left is resetting', async () => {
		const d = demo()
		const feed = await d.feed()
		expect(feed.tables.find((t) => t.id === 't4')!.resetBufferMin).toBe(10)
		expect(feed.tables.find((t) => t.id === 't1')!.resetBufferMin).toBe(0)
		const table = feed.tables.find((t) => t.id === 't4')!
		const state = tableState(table, feed, d.now())
		expect(state).toMatchObject({ kind: 'resetting' })
		expect(state.kind === 'resetting' && state.readyAt - d.now()).toBe(6 * MIN)
	})
	it('is free again once the buffer has passed', async () => {
		const d = demo()
		d.advance(7)
		const feed = await d.feed()
		const table = feed.tables.find((t) => t.id === 't4')!
		expect(tableState(table, feed, d.now()).kind).not.toBe('resetting')
	})
	it('keeps a table through its buffer, as the server does: a booking right after is a clash', async () => {
		// Table 9 keeps 5 minutes after a stay; Nadia is booked on it at 15:00.
		const seatWalkIn = async (afterMinutes: number) => {
			const d = demo()
			const layla = named(await d.feed(), 'Layla')
			await d.api.transition(layla.id, 'finished', {
				expectedVersion: layla.version,
			})
			d.advance(afterMinutes)
			return refusal(d.api.walkIn({ partySize: 2, tableIds: ['t9'] }))
		}
		// 13:24: a 90 minute stay and the buffer end at 14:59, a minute before the booking.
		expect(await seatWalkIn(4)).toBeNull()
		// 13:26: the stay alone would end at 14:56, but with the buffer it runs past 15:00.
		expect(await seatWalkIn(6)).toEqual([409, 'table_occupied'])
	})
	it('frees a table the moment a party is cleared when it has no buffer, and offers it', async () => {
		const d = demo()
		const before = await d.feed()
		const omar = named(before, 'Omar')
		expect(omar.tableIds).toEqual(['t2'])
		const kindsBefore = tableKinds(before, d.now())
		expect(kindsBefore.get('t2')).toBe('seated')
		await d.api.transition(omar.id, 'finished', {
			expectedVersion: omar.version,
		})
		const after = await d.feed()
		const kindsAfter = tableKinds(after, d.now())
		expect(kindsAfter.get('t2')).toBe('open')
		const freed = newlyFree(kindsBefore, kindsAfter)
		expect(freed).toContain('t2')
		// Table 2 seats two: the longest-waiting party of two or fewer is Amira, told 4 minutes ago.
		const offer = pickOffer({
			freed,
			feed: after,
			waitlist: (await d.api.waitlist()).entries,
			now: d.now(),
			dismissed: new Set(),
		})
		expect(offer?.placing).toMatchObject({
			kind: 'waitlist',
			entry: { firstName: 'Amira' },
		})
		expect(offer?.waitedMin).toBe(22)
	})
	it('resets a table on finishing when it has a buffer', async () => {
		const d = demo()
		const before = await d.feed()
		const sarah = named(before, 'Sarah')
		await d.api.transition(sarah.id, 'finished', {
			expectedVersion: sarah.version,
		})
		const after = await d.feed()
		const state = tableState(
			after.tables.find((t) => t.id === 't7')!,
			after,
			d.now(),
		)
		expect(state).toMatchObject({ kind: 'resetting' })
		expect(
			newlyFree(tableKinds(before, d.now()), tableKinds(after, d.now())),
		).not.toContain('t7')
	})
	it('seats a party at a table that is still resetting: the stand asks, the server does not', async () => {
		const d = demo()
		const before = await d.feed()
		const layla = named(before, 'Layla')
		await d.api.transition(layla.id, 'finished', {
			expectedVersion: layla.version,
		})
		const resetting = await d.feed()
		const t9 = resetting.tables.find((t) => t.id === 't9')!
		expect(tableState(t9, resetting, d.now()).kind).toBe('resetting')
		const answer = (await d.api.walkIn({
			partySize: 2,
			tableIds: ['t9'],
		})) as { reservation: { tableIds: string[]; status: string } }
		expect(answer.reservation).toMatchObject({
			status: 'seated',
			tableIds: ['t9'],
		})
	})
})

describe('a table given to a booking for its own time', () => {
	it('is judged by the booking’s window, as on the server: a party there now who clears before it does not stand in the way', async () => {
		const d = demo()
		const feed = await d.feed()
		const omar = named(feed, 'Omar')
		const jonas = named(feed, 'Jonas')
		// Omar sits at Table 2 until 13:35; Jonas is booked from 15:15.
		expect(omar).toMatchObject({ status: 'seated', tableIds: ['t2'] })
		expect(jonas.startAt).toBeGreaterThan(omar.endAt)
		const given = (await d.api.assign(jonas.id, ['t2'], jonas.version)) as {
			reservation: { tableIds: string[]; status: string }
		}
		expect(given.reservation).toMatchObject({
			status: 'booked',
			tableIds: ['t2'],
		})
	})
	it('is refused while the party there is still in the booking’s window', async () => {
		const d = demo()
		const feed = await d.feed()
		const omar = named(feed, 'Omar')
		const tariq = named(feed, 'Tariq')
		// Tariq is due at 13:15, inside Omar's booked time at Table 2: a party sitting there is never moved.
		expect(tariq.startAt).toBeLessThan(omar.endAt)
		expect(
			await refusal(d.api.assign(tariq.id, ['t2'], tariq.version)),
		).toEqual([409, 'locked_table_conflict'])
	})
})

describe('a party at the table', () => {
	const seatedAt = async (d: ReturnType<typeof demo>, first: string) => {
		const feed = await d.feed()
		return named(feed, first)
	}
	it('moves to a free table, and not onto one that someone sits at', async () => {
		const d = demo()
		const sarah = await seatedAt(d, 'Sarah')
		expect(
			await refusal(d.api.assign(sarah.id, ['t9'], sarah.version)),
		).toEqual([409, 'table_occupied'])
		const moved = (await d.api.assign(sarah.id, ['t6'], sarah.version)) as {
			reservation: { tableIds: string[]; tableLabels: string[]; status: string }
		}
		expect(moved.reservation).toMatchObject({
			status: 'seated',
			tableIds: ['t6'],
			tableLabels: ['6'],
		})
	})
	it('moves back where they were with no version to go by (an undo)', async () => {
		const d = demo()
		const sarah = await seatedAt(d, 'Sarah')
		await d.api.assign(sarah.id, ['t6'], sarah.version)
		const back = (await d.api.assign(sarah.id, ['t7'])) as {
			reservation: { tableIds: string[] }
		}
		expect(back.reservation.tableIds).toEqual(['t7'])
	})
	it('refuses a move from a stale version, and for a booking that is over', async () => {
		const d = demo()
		const sarah = await seatedAt(d, 'Sarah')
		expect(
			await refusal(d.api.assign(sarah.id, ['t6'], sarah.version + 5)),
		).toEqual([409, 'stale_version'])
		const noor = await seatedAt(d, 'Noor')
		expect(noor.status).toBe('finished')
		expect(await refusal(d.api.assign(noor.id, ['t6'], noor.version))).toEqual([
			409,
			'reservation_not_active',
		])
	})
	it('may overbook a move onto a table booked soon, with the host’s reason', async () => {
		const d = demo()
		const chris = await seatedAt(d, 'Chris')
		// Table 8 is booked in half an hour for eight: a move there is refused...
		expect(
			await refusal(d.api.assign(chris.id, ['t8'], chris.version)),
		).toEqual([409, 'table_occupied'])
		// ...unless the host insists.
		const insisted = (await d.api.assign(chris.id, ['t8'], chris.version, {
			overbook: true,
			overbookReason: 'Seated at the host stand',
		})) as { reservation: { tableIds: string[] } }
		expect(insisted.reservation.tableIds).toEqual(['t8'])
	})
	it('can stay a quarter hour longer, and the table’s expected clear moves with it', async () => {
		const d = demo()
		const sarah = await seatedAt(d, 'Sarah')
		const longer = (await d.api.changeParty(
			sarah.id,
			{ durationMin: sarah.durationMin + 15 },
			sarah.version,
		)) as { reservation: { durationMin: number; endAt: number } }
		expect(longer.reservation.durationMin).toBe(sarah.durationMin + 15)
		expect(longer.reservation.endAt).toBe(sarah.endAt + 15 * MIN)
	})
	it('may not be given a stay longer than a till can set', async () => {
		const d = demo()
		const sarah = await seatedAt(d, 'Sarah')
		expect(
			await refusal(
				d.api.changeParty(sarah.id, { durationMin: 361 }, sarah.version),
			),
		).toEqual([409, 'manager_required'])
	})
	it('changes size at the door, on the same table and with the same stay', async () => {
		const d = demo()
		const sarah = await seatedAt(d, 'Sarah')
		const smaller = (await d.api.changeParty(
			sarah.id,
			{ partySize: 5, durationMin: sarah.durationMin },
			sarah.version,
		)) as {
			reservation: {
				partySize: number
				tableIds: string[]
				endAt: number
				status: string
			}
		}
		expect(smaller.reservation).toMatchObject({
			partySize: 5,
			tableIds: ['t7'],
			status: 'seated',
			endAt: sarah.endAt,
		})
	})
	it('may not grow past the table, or have its time moved', async () => {
		const d = demo()
		const sarah = await seatedAt(d, 'Sarah')
		// Table 7 seats six.
		expect(
			await refusal(
				d.api.changeParty(sarah.id, { partySize: 7 }, sarah.version),
			),
		).toEqual([409, 'party_too_large_for_table'])
		expect(
			await refusal(
				d.api.changeParty(
					sarah.id,
					{ time: '19:00', localStartMin: 19 * 60 },
					sarah.version,
				),
			),
		).toEqual([409, 'invalid_status'])
	})
})

describe('a booking with money on it', () => {
	it('is not resized, cancelled or marked a no-show from a till', async () => {
		const d = demo()
		const feed = await d.feed()
		const nadia = named(feed, 'Nadia')
		expect(nadia.paymentStatus).toBe('paid')
		expect(
			await refusal(
				d.api.changeParty(nadia.id, { partySize: 3 }, nadia.version),
			),
		).toEqual([409, 'manager_required'])
		expect(
			await refusal(
				d.api.transition(nadia.id, 'cancelled', {
					expectedVersion: nadia.version,
				}),
			),
		).toEqual([409, 'manager_required'])
		d.advance(120)
		const rana = named(await d.feed(), 'Rana')
		expect(rana.paymentStatus).toBe('paid')
		expect(
			await refusal(
				d.api.transition(rana.id, 'no_show', { expectedVersion: rana.version }),
			),
		).toEqual([409, 'manager_required'])
	})
	it('is not given a longer stay from a till once seated: it is behind the same lock as size and time', async () => {
		const d = demo()
		const rana = named(await d.feed(), 'Rana')
		const seated = (await d.api.transition(rana.id, 'seated', {
			tableIds: ['t6'],
			expectedVersion: rana.version,
		})) as { reservation: { version: number; durationMin: number } }
		expect(
			await refusal(
				d.api.changeParty(
					rana.id,
					{ durationMin: seated.reservation.durationMin + 15 },
					seated.reservation.version,
				),
			),
		).toEqual([409, 'manager_required'])
	})
})

describe('the day’s pacing', () => {
	it('marks its caps as the restaurant’s own, not the server’s default', async () => {
		const d = demo()
		const feed = await d.feed()
		expect(feed.pacing.length).toBeGreaterThan(0)
		expect(feed.pacing.every((p) => p.maxCoversIsDefault === false)).toBe(true)
	})
})

describe('a large party and tables joined', () => {
	it('has a twelve-top booked on a defined combination, and tables that join', async () => {
		const d = demo()
		const feed = await d.feed()
		const twelve = named(feed, 'Hassan')
		expect(twelve).toMatchObject({
			partySize: 12,
			tableIds: ['t6', 't7'],
			comboId: 'combo_67',
		})
		expect(feed.combos).toHaveLength(1)
		expect(feed.combos[0]).toMatchObject({
			tableIds: ['t6', 't7'],
			maxCovers: 12,
		})
		const combinable = feed.tables.filter((t) => t.combinable).map((t) => t.id)
		expect(combinable.sort()).toEqual(
			['p6', 'p7', 'p8', 't10', 't6', 't7', 't9'].sort(),
		)
	})
	it('seats a walk-in at several tables as one party', async () => {
		const d = demo()
		const feed = await d.feed()
		// Tables 6 and 7: 7 is taken by Sarah's birthday, so use 9 and 10's neighbours: P4 and P5 are booked; 6 + P6 are free.
		const answer = (await d.api.walkIn(
			{ partySize: 10, tableIds: ['t6', 'p6'] },
			'k1',
		)) as { reservation: { tableIds: string[]; partySize: number } }
		expect(answer.reservation).toMatchObject({
			partySize: 10,
			tableIds: ['t6', 'p6'],
		})
		const after = await d.feed()
		expect(
			tableState(
				after.tables.find((t) => t.id === 'p6')!,
				after,
				d.now(),
			).kind,
		).toBe('seated')
		expect(feed.reservations.length).toBeLessThan(after.reservations.length)
	})
	it('refuses a walk-in joined onto a table with someone on it', async () => {
		const d = demo()
		const feed = await d.feed()
		const seatedTable = feed.reservations.find((r) => r.status === 'seated')!
			.tableIds[0]!
		expect(
			await refusal(
				d.api.walkIn({ partySize: 10, tableIds: ['t6', seatedTable] }, 'k2'),
			),
		).toEqual([409, 'table_occupied'])
	})
	it('seats a booking at its combination and keeps it as one on the book', async () => {
		const d = demo()
		const first = await d.feed()
		const twelve = named(first, 'Hassan')
		// Sarah's birthday has left Table 7 by the time the twelve are here.
		const sarah = named(first, 'Sarah')
		await d.api.transition(sarah.id, 'finished', {
			expectedVersion: sarah.version,
		})
		d.advance(160)
		const here = (await d.api.transition(twelve.id, 'arrived', {
			expectedVersion: twelve.version,
		})) as { reservation: { version: number } }
		const seated = (await d.api.transition(twelve.id, 'seated', {
			tableIds: ['t6', 't7'],
			comboId: 'combo_67',
			expectedVersion: here.reservation.version,
		})) as { reservation: { tableIds: string[]; comboId: string | null } }
		expect(seated.reservation).toMatchObject({
			tableIds: ['t6', 't7'],
			comboId: 'combo_67',
		})
	})
	it('moves a seated party onto several tables, with the combination kept', async () => {
		const d = demo()
		const chris = named(await d.feed(), 'Chris')
		const moved = (await d.api.assign(
			chris.id,
			['t6', 'p6'],
			chris.version,
			{},
			null,
		)) as { reservation: { tableIds: string[]; comboId: string | null } }
		expect(moved.reservation.tableIds).toEqual(['t6', 'p6'])
		expect(moved.reservation.comboId).toBeNull()
		// Moved back as one combination: the combination is kept, under the version it has now.
		const now = named(await d.feed(), 'Chris')
		const back = (await d.api.assign(
			chris.id,
			['p6', 't6'],
			now.version,
			{},
			'combo_x',
		)) as { reservation: { tableIds: string[]; comboId: string | null } }
		expect(back.reservation).toMatchObject({
			tableIds: ['p6', 't6'],
			comboId: 'combo_x',
		})
	})
})

describe('seating a booking, as the server assigns tables', () => {
	it('moves a soft booking that is not due soon to another table to make room', async () => {
		const d = demo()
		const feed = await d.feed()
		const rana = named(feed, 'Rana')
		const giulia = named(feed, 'Giulia')
		expect(giulia.tableIds).toEqual(['t4'])
		// Giulia is booked 75 minutes from now at Table 4: well beyond the freeze window.
		await d.api.transition(rana.id, 'seated', {
			tableIds: ['t4'],
			expectedVersion: rana.version,
		})
		const after = await d.feed()
		const moved = after.reservations.find((r) => r.id === giulia.id)!
		expect(moved.tableIds).not.toEqual(['t4'])
		expect(moved.tableIds).toHaveLength(1)
	})
	it('does not move a party that is due within the freeze window (the next party is due)', async () => {
		const d = demo()
		const feed = await d.feed()
		const rana = named(feed, 'Rana')
		// Elena is booked at Table P4 in fifteen minutes.
		expect(named(feed, 'Elena').tableIds).toEqual(['p4'])
		expect(
			await refusal(
				d.api.transition(rana.id, 'seated', {
					tableIds: ['p4'],
					expectedVersion: rana.version,
				}),
			),
		).toEqual([409, 'locked_table_conflict'])
	})
	it('refuses a table taped off from a time inside the stay, as the server does, and an overbook lets it through', async () => {
		const d = demo()
		const rana = named(await d.feed(), 'Rana')
		// Table P2 is taped off for a private party from 45 minutes from now.
		expect(
			await refusal(
				d.api.transition(rana.id, 'seated', {
					tableIds: ['p2'],
					expectedVersion: rana.version,
				}),
			),
		).toEqual([409, 'table_blocked'])
		const insisted = (await d.api.transition(rana.id, 'seated', {
			tableIds: ['p2'],
			expectedVersion: rana.version,
			overbook: true,
			overbookReason: 'Seated at the host stand',
		})) as { reservation: { status: string } }
		expect(insisted.reservation.status).toBe('seated')
	})
	it('is not a blocked table for a walk-in: the server calls it occupied', async () => {
		const d = demo()
		expect(
			await refusal(d.api.walkIn({ partySize: 2, tableIds: ['p2'] }, 'k3')),
		).toEqual([409, 'table_occupied'])
	})
})

describe('a party that is only partly here', () => {
	it('keeps a partial arrival as an arrived booking short of its size, and seats some of them with the tables in one call', async () => {
		const d = demo()
		const dina = named(await d.feed(), 'Dina')
		expect(dina).toMatchObject({
			status: 'arrived',
			partySize: 5,
			arrivedCovers: 3,
		})
		// One call, as the server takes it: the status, the tables and how many sit.
		const partly = (await d.api.transition(dina.id, 'seated', {
			tableIds: ['t6'],
			seatedCovers: 3,
			expectedVersion: dina.version,
		})) as {
			reservation: {
				status: string
				seatedCovers: number
				tableIds: string[]
				version: number
			}
		}
		expect(partly.reservation).toMatchObject({
			status: 'seated',
			seatedCovers: 3,
			tableIds: ['t6'],
		})
		// They are on the floor: Table 6 is theirs.
		const feed = await d.feed()
		expect(
			tableState(
				feed.tables.find((t) => t.id === 't6')!,
				feed,
				d.now(),
			).kind,
		).toBe('seated')
		// The server has nothing to add the rest with: seated goes only to finished.
		expect(
			await refusal(
				d.api.transition(dina.id, 'seated', {
					seatedCovers: 5,
					expectedVersion: partly.reservation.version,
				}),
			),
		).toEqual([409, 'invalid_status_transition'])
	})
	it('seats as many as were marked here when no count is sent, and all of them when it says so', async () => {
		const d = demo()
		const dina = named(await d.feed(), 'Dina')
		const whole = (await d.api.transition(dina.id, 'seated', {
			tableIds: ['t6'],
			seatedCovers: 5,
			expectedVersion: dina.version,
		})) as { reservation: { seatedCovers: number } }
		expect(whole.reservation.seatedCovers).toBe(5)
		const other = demo()
		const again = named(await other.feed(), 'Dina')
		const bare = (await other.api.transition(again.id, 'seated', {
			tableIds: ['t6'],
			expectedVersion: again.version,
		})) as { reservation: { seatedCovers: number } }
		// The server falls back to the count of the ones at the door.
		expect(bare.reservation.seatedCovers).toBe(3)
	})
	it('marks some of a booked party here as `arrived` with the count, and cannot raise it after', async () => {
		const d = demo()
		const elena = named(await d.feed(), 'Elena')
		const some = (await d.api.transition(elena.id, 'arrived', {
			arrivedCovers: 2,
			expectedVersion: elena.version,
		})) as {
			reservation: { status: string; arrivedCovers: number; version: number }
		}
		expect(some.reservation).toMatchObject({
			status: 'arrived',
			arrivedCovers: 2,
		})
		// arrived -> arrived is not a step the server has: no way to raise the count.
		expect(
			await refusal(
				d.api.transition(elena.id, 'arrived', {
					arrivedCovers: 4,
					expectedVersion: some.reservation.version,
				}),
			),
		).toEqual([409, 'invalid_status_transition'])
	})
	it('has no partial statuses: the server would refuse them', async () => {
		const d = demo()
		const elena = named(await d.feed(), 'Elena')
		expect(
			await refusal(
				d.api.transition(elena.id, 'partially_arrived' as never, {
					arrivedCovers: 2,
					expectedVersion: elena.version,
				}),
			),
		).toEqual([409, 'invalid_status_transition'])
	})
	it('never counts more than the party', async () => {
		const d = demo()
		const elena = named(await d.feed(), 'Elena')
		const some = (await d.api.transition(elena.id, 'arrived', {
			arrivedCovers: 40,
			expectedVersion: elena.version,
		})) as { reservation: { arrivedCovers: number } }
		expect(some.reservation.arrivedCovers).toBe(4)
	})
})

describe('a guest marked a no-show who walks in', () => {
	it('can be taken back within the undo window', async () => {
		const d = demo()
		const mariam = named(await d.feed(), 'Mariam')
		expect(mariam.status).toBe('no_show')
		const back = (await d.api.undo(mariam.id)) as {
			reservation: { status: string }
		}
		expect(['booked', 'confirmed', 'arrived']).toContain(
			back.reservation.status,
		)
	})
	it('cannot be reopened by a till once the undo window has passed', async () => {
		const d = demo()
		const faisal = named(await d.feed(), 'Faisal')
		expect(faisal.status).toBe('no_show')
		expect(await refusal(d.api.undo(faisal.id))).toEqual([
			409,
			'undo_window_expired',
		])
		expect(
			await refusal(
				d.api.transition(faisal.id, 'arrived', {
					expectedVersion: faisal.version,
				}),
			),
		).toEqual([409, 'invalid_status_transition'])
	})
})

describe('a stay, as the server lets a till change it', () => {
	it('only grows, never shrinks', async () => {
		const d = demo()
		const sarah = named(await d.feed(), 'Sarah')
		expect(
			await refusal(
				d.api.changeParty(
					sarah.id,
					{ durationMin: sarah.durationMin - 15 },
					sarah.version,
				),
			),
		).toEqual([409, 'manager_required'])
	})
	it('grows a party seated past their time by a quarter hour from now', async () => {
		const d = demo()
		const sarah = named(await d.feed(), 'Sarah')
		d.advance(150)
		const feed = await d.feed()
		const late = feed.reservations.find((r) => r.id === sarah.id)!
		expect(late.endAt).toBeLessThan(d.now())
		const wanted = Math.ceil((d.now() + 15 * MIN - late.startAt) / MIN)
		const longer = (await d.api.changeParty(
			sarah.id,
			{ durationMin: wanted },
			late.version,
		)) as { reservation: { endAt: number } }
		expect(longer.reservation.endAt).toBeGreaterThan(d.now())
	})
	it('refuses a time moved into the past', async () => {
		const d = demo()
		const feed = await d.feed()
		const priya = named(feed, 'Priya')
		expect(
			await refusal(
				d.api.changeParty(
					priya.id,
					{ time: '00:30', localStartMin: 30 },
					priya.version,
				),
			),
		).toEqual([409, 'in_the_past'])
	})
})

describe('a hold that ran out, as the server’s tick does it', () => {
	it('takes a party out of line when the hold ends, texted or not, and lists them to be put back', async () => {
		const d = demo()
		const jamal = (await d.api.waitlist()).entries[0]!
		await d.api.notifyWaitlist(jamal.id, jamal.version)
		d.advance(11)
		const list = await d.api.waitlist()
		const gone = list.entries.find((e) => e.id === jamal.id)!
		expect(gone.status).toBe('no_response')
		// Not counted as waiting any more.
		expect(list.counts.active).toBe(
			list.entries.filter((e) => e.status !== 'no_response').length,
		)
	})
	it('puts a party back in line, clearing the hold', async () => {
		const d = demo()
		const jamal = (await d.api.waitlist()).entries[0]!
		await d.api.notifyWaitlist(jamal.id, jamal.version)
		d.advance(11)
		const gone = (await d.api.waitlist()).entries.find(
			(e) => e.id === jamal.id,
		)!
		const back = (await d.api.leaveWaitlist(
			gone.id,
			gone.version,
			'waiting',
		)) as {
			entry: {
				status: string
				notifiedAt: number | null
				responseDeadlineAt: number | null
			}
		}
		expect(back.entry).toMatchObject({
			status: 'waiting',
			notifiedAt: null,
			responseDeadlineAt: null,
		})
	})
	it('puts a party told by mistake back in line', async () => {
		const d = demo()
		const amira = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Amira',
		)!
		expect(amira.status).toBe('notified')
		const back = (await d.api.leaveWaitlist(
			amira.id,
			amira.version,
			'waiting',
		)) as {
			entry: { status: string }
		}
		expect(back.entry.status).toBe('waiting')
	})
	it('does not put back a party who is already waiting, left, or seated', async () => {
		const d = demo()
		const sofia = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Sofia',
		)!
		// Already waiting: nothing to do.
		const same = (await d.api.leaveWaitlist(
			sofia.id,
			sofia.version,
			'waiting',
		)) as {
			entry: { status: string }
		}
		expect(same.entry.status).toBe('waiting')
		const wei = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Wei',
		)!
		const left = (await d.api.leaveWaitlist(wei.id, wei.version)) as {
			entry: { status: string; version: number }
		}
		expect(
			await refusal(d.api.leaveWaitlist(wei.id, left.entry.version, 'waiting')),
		).toEqual([409, 'invalid_status_transition'])
	})
	it('stops listing a party whose hold ended long ago', async () => {
		const d = demo()
		const jamal = (await d.api.waitlist()).entries[0]!
		await d.api.notifyWaitlist(jamal.id, jamal.version)
		d.advance(11 + 31)
		expect(
			(await d.api.waitlist()).entries.some((e) => e.id === jamal.id),
		).toBe(false)
	})
})

describe('availability for a large party', () => {
	it('offers a defined combination when no single table seats the party', async () => {
		const d = demo()
		d.advance(120)
		const slots = (await d.api.availability(d.today(), 12)).slots
		const open = slots.filter((s) => s.available)
		expect(open.length).toBeGreaterThan(0)
		for (const slot of open)
			expect(slot.suggestedTableIds).toEqual(['t6', 't7'])
		// A party no combination seats has no time at all.
		expect(
			(await d.api.availability(d.today(), 14)).slots.some((s) => s.available),
		).toBe(false)
	})
	it('books the twelve on the combination and keeps it as one', async () => {
		const d = demo()
		d.advance(120)
		const slot = (await d.api.availability(d.today(), 12)).slots.find(
			(s) => s.available,
		)!
		const answer = (await d.api.book(
			{
				date: d.today(),
				time: slot.time,
				localStartMin: slot.localStartMin,
				partySize: 12,
				firstName: 'Ola',
				lastName: 'Hansen',
				phone: null,
				notes: null,
			},
			'bk12',
		)) as { reservation: { tableIds: string[]; comboId: string | null } }
		expect(answer.reservation).toMatchObject({
			tableIds: ['t6', 't7'],
			comboId: 'combo_67',
		})
	})
})
