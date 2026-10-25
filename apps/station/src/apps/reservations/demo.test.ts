import { describe, expect, it } from 'vitest'
import { HostApiError } from './api.ts'
import { createDemoHostApi, demoShift } from './demo.ts'
import { dayFeedSchema, tableState, type DayFeed } from './feed.ts'
import { addDays, zonedDate, zonedMinutes } from './zoned.ts'

const MIN = 60_000
const ZONE = 'UTC'
/** 1:20 PM on a Saturday: the sample is built around this clock. */
const T0 = Date.UTC(2026, 9, 24, 13, 20)

function demo() {
	let now = T0
	const api = createDemoHostApi({ now: () => now, timeZone: ZONE })
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
		expect(feed.tables).toHaveLength(16)
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
		expect(list.entries).toHaveLength(3)
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
		).toEqual([409, 'table_occupied'])
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
		// Table 8 is booked for Ahmed within the half hour: Rana's stay would run into it.
		expect(
			await refusal(
				d.api.transition(rana.id, 'seated', {
					tableIds: ['t8'],
					expectedVersion: rana.version,
				}),
			),
		).toEqual([409, 'table_occupied'])
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

	it('refuses a taped-off table even when the host insists', async () => {
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
		// A party of twelve fits no table.
		const big = await d.api.availability(addDays(today, 1), 12)
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
		const quote = await d.api.waitlistQuote(2)
		expect(quote.position).toBe(4)
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
		expect((await d.api.waitlist()).entries).toHaveLength(4)

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

	it('cannot text a party with no number, and lets one leave', async () => {
		const d = demo()
		const sofia = (await d.api.waitlist()).entries.find(
			(e) => e.firstName === 'Sofia',
		)!
		expect(sofia.phone).toBeNull()
		expect(
			await refusal(d.api.notifyWaitlist(sofia.id, sofia.version)),
		).toEqual([409, 'no_phone'])
		await d.api.leaveWaitlist(sofia.id, sofia.version)
		expect(
			(await d.api.waitlist()).entries.some((e) => e.id === sofia.id),
		).toBe(false)
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
