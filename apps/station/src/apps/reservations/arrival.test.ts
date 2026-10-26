import { TILL_NO_SHOW_GRACE_MS } from '@repo/reservations'
import { describe, expect, it } from 'vitest'
import {
	coversHere,
	earlyArrival,
	EARLY_MIN,
	LATE_PROMPT_MIN,
	LATE_URGENT_MIN,
	latePrompt,
	standWait,
	WAIT_WARN_MIN,
} from './arrival.ts'
import { at, day, MIN, rsv } from './testing.ts'

const NOW = at(18 * 60)

describe('how long a party has waited at the stand', () => {
	const here = (minutesAgo: number, status = 'arrived') =>
		rsv({ start: 17 * 60 + 45, status, arrivedAt: NOW - minutesAgo * MIN })
	it('counts whole minutes since they were marked here', () => {
		expect(standWait(here(12), NOW)).toEqual({ minutes: 12, warn: true })
		expect(standWait(here(3), NOW)).toEqual({ minutes: 3, warn: false })
		expect(
			standWait(
				rsv({ start: 600, status: 'arrived', arrivedAt: NOW - 90_000 }),
				NOW,
			)!.minutes,
		).toBe(1)
	})
	it('turns to a warning from ten minutes', () => {
		expect(WAIT_WARN_MIN).toBe(10)
		expect(standWait(here(9), NOW)!.warn).toBe(false)
		expect(standWait(here(10), NOW)!.warn).toBe(true)
	})
	it('counts a partly arrived party too (an arrived booking short of its party)', () => {
		const partly = rsv({
			start: 17 * 60 + 45,
			status: 'arrived',
			partySize: 5,
			arrivedCovers: 3,
			arrivedAt: NOW - 11 * MIN,
		})
		expect(standWait(partly, NOW)).toEqual({
			minutes: 11,
			warn: true,
		})
	})
	it('is nothing for a party that is not at the stand or was never stamped', () => {
		expect(standWait(rsv({ start: 600, status: 'booked' }), NOW)).toBeNull()
		expect(
			standWait(
				rsv({ start: 600, status: 'seated', arrivedAt: NOW - MIN }),
				NOW,
			),
		).toBeNull()
		expect(
			standWait(rsv({ start: 600, status: 'arrived', arrivedAt: null }), NOW),
		).toBeNull()
	})
	it('never reads below zero (a clock behind the server)', () => {
		expect(standWait(here(-3), NOW)!.minutes).toBe(0)
	})
})

describe('an early arrival', () => {
	const tables = [
		{ id: 't8', areaId: 'a1', label: '8', minCovers: 4, maxCovers: 8 },
		{ id: 't6', areaId: 'a1', label: '6', minCovers: 2, maxCovers: 6 },
	]
	const early = (extra: Record<string, unknown> = {}) =>
		rsv({
			start: 18 * 60 + 28,
			partySize: 6,
			status: 'arrived',
			arrivedAt: NOW - 2 * MIN,
			tableIds: ['t8'],
			tableLabels: ['8'],
			...extra,
		})
	const withTables = (reservations: ReturnType<typeof rsv>[]) =>
		day(reservations, { tables })

	it('says how early they are and that their own table is free now', () => {
		const r = early()
		expect(earlyArrival(r, withTables([r]), NOW)).toEqual({
			earlyMin: 28,
			table: { kind: 'free_now', label: '8' },
		})
	})
	it('is not early when it is within a few minutes of their time, or late', () => {
		expect(EARLY_MIN).toBe(5)
		const close = early({ start: 18 * 60 + 4, partySize: 2 })
		expect(earlyArrival(close, withTables([close]), NOW)).toBeNull()
		const late = early({ start: 17 * 60 + 50 })
		expect(earlyArrival(late, withTables([late]), NOW)).toBeNull()
	})
	it('is nothing for a party that is not at the stand', () => {
		const r = early({ status: 'booked' })
		expect(earlyArrival(r, withTables([r]), NOW)).toBeNull()
	})
	it('offers the smallest table that seats them when their own is taken', () => {
		const r = early({ partySize: 5 })
		const sitting = rsv({
			start: 17 * 60,
			status: 'seated',
			seatedAt: at(17 * 60),
			tableIds: ['t8'],
			tableLabels: ['8'],
		})
		expect(earlyArrival(r, withTables([r, sitting]), NOW)).toEqual({
			earlyMin: 28,
			table: { kind: 'free_now', label: '6' },
		})
	})
	it('says when a table frees up when nothing is free now', () => {
		const r = early({ partySize: 7 })
		// Table 8 (seats 8) is the only one that seats seven: seated at 17:00 for 90 minutes.
		const sitting = rsv({
			start: 17 * 60,
			status: 'seated',
			seatedAt: at(17 * 60),
			tableIds: ['t8'],
			tableLabels: ['8'],
		})
		expect(earlyArrival(r, withTables([r, sitting]), NOW)).toEqual({
			earlyMin: 28,
			table: { kind: 'free_in', minutes: 30, label: '8' },
		})
	})
	it('counts a table that is only being reset as free in the minutes it has left', () => {
		const r = early({ partySize: 7 })
		const left = rsv({
			start: 16 * 60,
			status: 'finished',
			finishedAt: NOW - 4 * MIN,
			tableIds: ['t8'],
			tableLabels: ['8'],
		})
		const feed = day([r, left], {
			tables: [{ ...tables[0], resetBufferMin: 10 }, tables[1]],
		})
		expect(earlyArrival(r, feed, NOW)).toEqual({
			earlyMin: 28,
			table: { kind: 'free_in', minutes: 6, label: '8' },
		})
	})
	it('says only how early when no table could be named', () => {
		const r = early({ partySize: 12 })
		expect(earlyArrival(r, withTables([r]), NOW)).toEqual({
			earlyMin: 28,
			table: null,
		})
	})
	it('does not offer a table someone is booked at inside their own booked window', () => {
		const r = early({ partySize: 6 })
		// Someone else holds table 8 from 19:00, inside this party's 18:28 to 19:58.
		const other = rsv({ start: 19 * 60, tableIds: ['t8'], tableLabels: ['8'] })
		expect(earlyArrival(r, withTables([r, other]), NOW)!.table).toEqual({
			kind: 'free_now',
			label: '6',
		})
	})
})

describe('a late party', () => {
	const booked = (lateMin: number, extra: Record<string, unknown> = {}) =>
		rsv({ start: 18 * 60 - lateMin, status: 'booked', ...extra })
	it('is worth a nudge from fifteen minutes, louder from thirty', () => {
		expect(LATE_PROMPT_MIN).toBe(15)
		expect(LATE_URGENT_MIN).toBe(30)
		expect(latePrompt(booked(14), NOW)).toBeNull()
		expect(latePrompt(booked(15), NOW)).toEqual({ late: 15, urgent: false })
		expect(latePrompt(booked(29), NOW)).toEqual({ late: 29, urgent: false })
		expect(latePrompt(booked(30), NOW)).toEqual({ late: 30, urgent: true })
		expect(latePrompt(booked(45, { status: 'confirmed' }), NOW)).toEqual({
			late: 45,
			urgent: true,
		})
	})
	it('is the same moment a till may call a no-show', () => {
		expect(LATE_PROMPT_MIN * MIN).toBe(TILL_NO_SHOW_GRACE_MS)
	})
	it('is nothing for a party that is here, seated, or gone', () => {
		for (const status of [
			'arrived',
			'seated',
			'finished',
			'no_show',
			'cancelled',
		])
			expect(latePrompt(booked(40, { status }), NOW)).toBeNull()
	})
	it('waits for a guest who called to say how late they would be', () => {
		expect(latePrompt(booked(20, { runningLateMin: 30 }), NOW)).toBeNull()
		expect(latePrompt(booked(30, { runningLateMin: 30 }), NOW)).toBeNull()
		expect(latePrompt(booked(35, { runningLateMin: 30 }), NOW)).toEqual({
			late: 35,
			urgent: true,
		})
	})
})

describe('a party only partly here', () => {
	it('says how many of how many are at the door: an arrived booking short of its party', () => {
		expect(
			coversHere({
				status: 'arrived',
				partySize: 5,
				arrivedCovers: 3,
				seatedCovers: null,
			}),
		).toEqual({ here: 3, of: 5, stage: 'door' })
	})
	it('says how many are seated: a seated booking short of its party', () => {
		expect(
			coversHere({
				status: 'seated',
				partySize: 5,
				arrivedCovers: 5,
				seatedCovers: 4,
			}),
		).toEqual({ here: 4, of: 5, stage: 'table' })
	})
	it('is nothing for a whole party', () => {
		expect(
			coversHere({
				status: 'arrived',
				partySize: 5,
				arrivedCovers: 5,
				seatedCovers: null,
			}),
		).toBeNull()
		expect(
			coversHere({
				status: 'seated',
				partySize: 5,
				arrivedCovers: 5,
				seatedCovers: 5,
			}),
		).toBeNull()
		expect(
			coversHere({
				status: 'arrived',
				partySize: 5,
				arrivedCovers: null,
				seatedCovers: null,
			}),
		).toBeNull()
	})
	it('is nothing for a booking nobody is at yet, whatever count the server kept through an undo', () => {
		for (const status of ['booked', 'confirmed', 'finished', 'no_show'])
			expect(
				coversHere({
					status,
					partySize: 5,
					arrivedCovers: 3,
					seatedCovers: 3,
				}),
			).toBeNull()
	})
	it('counts the seated ones at the table and the arrived ones at the door, not the other', () => {
		// Seated: the arrived count is old news (they all came, then some sat).
		expect(
			coversHere({
				status: 'seated',
				partySize: 6,
				arrivedCovers: 3,
				seatedCovers: 6,
			}),
		).toBeNull()
		expect(
			coversHere({
				status: 'arrived',
				partySize: 6,
				arrivedCovers: 6,
				seatedCovers: 2,
			}),
		).toBeNull()
	})
})
