import { TILL_NO_SHOW_GRACE_MS } from '@repo/reservations'
import { describe, expect, it } from 'vitest'
import { UNDO_WINDOW_MS } from './feed.ts'
import {
	armedStillHolds,
	partyActions,
	type PartyActionsInput,
} from './partyActions.ts'
import { at, MIN, rsv } from './testing.ts'

const NOW = at(13 * 60)
const actionsFor = (
	status: string,
	over: Record<string, unknown> = {},
	options: {
		now?: number
		viewOnly?: boolean
		seatTableKind?: PartyActionsInput['seatTableKind']
	} = {},
) =>
	partyActions({
		r: rsv({ start: 13 * 60, status, ...over }) as PartyActionsInput['r'],
		now: options.now ?? NOW,
		viewOnly: options.viewOnly ?? false,
		seatTableKind: options.seatTableKind,
	})

describe('what a till may do to a booking', () => {
	it('lets a booked party be confirmed, marked here, seated, changed or cancelled', () => {
		const a = actionsFor('booked')
		expect(a).toMatchObject({
			canSeat: true,
			canArrive: true,
			canConfirm: true,
			canChange: true,
			canCancel: true,
			canFinish: false,
			undo: null,
		})
		// Confirmed already: nothing to confirm.
		expect(actionsFor('confirmed').canConfirm).toBe(false)
	})

	it('leaves "they are here" off for a party already at the stand', () => {
		const a = actionsFor('arrived')
		expect(a.canArrive).toBe(false)
		expect(a.canSeat).toBe(true)
		expect(a.canChange).toBe(true)
	})

	it('allows a no-show only once the grace after the booked time has passed', () => {
		const start = at(13 * 60)
		const early = actionsFor(
			'booked',
			{},
			{ now: start + TILL_NO_SHOW_GRACE_MS - 1 },
		)
		expect(early.canNoShow).toBe(false)
		const due = actionsFor('booked', {}, { now: start + TILL_NO_SHOW_GRACE_MS })
		expect(due.canNoShow).toBe(true)
		// Not for a party already seated.
		expect(
			actionsFor('seated', {}, { now: start + TILL_NO_SHOW_GRACE_MS * 3 })
				.canNoShow,
		).toBe(false)
	})

	it('finishes a seated party and undoes seating only inside the window', () => {
		const seatedAt = NOW - 5 * MIN
		const fresh = actionsFor('seated', { seatedAt })
		expect(fresh).toMatchObject({ canFinish: true, undo: 'seat' })
		const stale = actionsFor('seated', { seatedAt: NOW - UNDO_WINDOW_MS - 1 })
		expect(stale.undo).toBeNull()
		expect(stale.canFinish).toBe(true)
		// The window's edge is inclusive.
		expect(actionsFor('seated', { seatedAt: NOW - UNDO_WINDOW_MS }).undo).toBe(
			'seat',
		)
		// With no seating time recorded, undoing is left to the server.
		expect(actionsFor('seated', { seatedAt: null }).undo).toBe('seat')
	})

	it('puts back a finished party, or a no-show, unless the till is not allowed to', () => {
		const done = actionsFor('finished', { finishedAt: NOW - 10 * MIN })
		expect(done.undo).toBe('finish')
		expect(
			actionsFor('finished', { finishedAt: NOW - 10 * MIN, canUndo: false })
				.undo,
		).toBeNull()
		expect(actionsFor('no_show').undo).toBe('no_show')
		expect(actionsFor('no_show', { canUndo: false }).undo).toBeNull()
		// Cleared too long ago for any till to put right.
		expect(
			actionsFor('finished', { finishedAt: NOW - 24 * 60 * MIN }).undo,
		).toBeNull()
	})

	it('leaves a deposit to a manager', () => {
		const held = actionsFor('pending_payment')
		expect(held.awaitingPayment).toBe(true)
		expect(held.canConfirm).toBe(false)
		expect(held.canCancel).toBe(false)
		expect(held.any).toBe(false)
	})

	it('on another day allows only confirming and cancelling', () => {
		const a = actionsFor('booked', {}, { viewOnly: true })
		expect(a).toMatchObject({
			canConfirm: true,
			canCancel: true,
			canSeat: false,
			canArrive: false,
			canNoShow: false,
			canFinish: false,
		})
		// Changing is still the booking's own business.
		expect(a.canChange).toBe(true)
		expect(actionsFor('seated', {}, { viewOnly: true }).undo).toBeNull()
	})

	it('leads with "Seat at Table 3" for a party at the stand with one table', () => {
		const here = actionsFor('arrived', { tableIds: ['t3'], tableLabels: ['3'] })
		expect(here.seatAt).toEqual({ label: '3', tableId: 't3' })
		// Not at the stand yet, no table, or several tables: choosing a table stays the way.
		expect(
			actionsFor('booked', { tableIds: ['t3'], tableLabels: ['3'] }).seatAt,
		).toBeNull()
		expect(actionsFor('arrived').seatAt).toBeNull()
		expect(
			actionsFor('arrived', { tableIds: ['t3', 't4'], tableLabels: ['3', '4'] })
				.seatAt,
		).toBeNull()
		// Another day seats nobody.
		expect(
			actionsFor(
				'arrived',
				{ tableIds: ['t3'], tableLabels: ['3'] },
				{ viewOnly: true },
			).seatAt,
		).toBeNull()
	})

	it('offers booking again once a booking has ended', () => {
		expect(actionsFor('finished').canBookAgain).toBe(true)
		expect(actionsFor('no_show').canBookAgain).toBe(true)
		expect(actionsFor('cancelled').canBookAgain).toBe(true)
		expect(actionsFor('booked').canBookAgain).toBe(false)
		expect(actionsFor('seated').canBookAgain).toBe(false)
		// A cancelled booking still has this one button.
		expect(actionsFor('cancelled').any).toBe(true)
	})
})

describe('a booking with money on it', () => {
	// What a till can do to a booking at each step of its life, with and without a deposit.
	const LIVE = ['booked', 'confirmed', 'arrived', 'seated'] as const
	const PAYMENTS = [
		'none',
		'pending',
		'paid',
		'guaranteed',
		'refund_pending',
		'refunded',
		'partially_refunded',
		'fee_pending',
	]
	// A no-show needs the grace to have passed.
	const late = { now: NOW + TILL_NO_SHOW_GRACE_MS * 4 }

	for (const status of LIVE) {
		for (const paymentStatus of PAYMENTS) {
			const paid = paymentStatus !== 'none'
			it(`${status} with payment "${paymentStatus}": ${paid ? 'size, cancel and no-show go to a manager' : 'the till keeps them'}`, () => {
				const a = actionsFor(status, { paymentStatus }, late)
				if (paid) {
					expect(a.canChange).toBe(false)
					expect(a.canNoShow).toBe(false)
					expect(a.canCancel).toBe(false)
					expect(a.managerHandles).toBe(true)
					// The footer still shows: the line that says whose it is.
					expect(a.any).toBe(true)
				} else {
					expect(a.managerHandles).toBe(false)
					expect(a.canChange).toBe(
						status === 'booked' ||
							status === 'confirmed' ||
							status === 'arrived' ||
							status === 'seated',
					)
					expect(a.canCancel).toBe(
						status === 'booked' ||
							status === 'confirmed' ||
							status === 'arrived',
					)
				}
			})
		}
	}

	it('still lets the till do what the money does not touch', () => {
		const a = actionsFor('arrived', { paymentStatus: 'paid' }, late)
		expect(a.canSeat).toBe(true)
		const seated = actionsFor('seated', { paymentStatus: 'paid' })
		expect(seated.canFinish).toBe(true)
		// Moving a party to another table is not money.
		expect(seated.canMove).toBe(true)
	})

	it('keeps a longer stay, like a size change, from a booking with money or an experience on it', () => {
		const sat = { seatedAt: NOW - 30 * MIN }
		// The server refuses a stay change behind the same lock as size and time.
		for (const paymentStatus of [
			'pending',
			'paid',
			'guaranteed',
			'refund_pending',
			'refunded',
		]) {
			const a = actionsFor('seated', { ...sat, paymentStatus })
			expect(a.canExtend).toBe(false)
			expect(a.canChange).toBe(false)
		}
		const tasting = actionsFor('seated', { ...sat, experienceId: 'exp_1' })
		expect(tasting.canExtend).toBe(false)
		expect(tasting.canChange).toBe(false)
		// Nothing owed and no experience: the till may.
		const plain = actionsFor('seated', { ...sat, paymentStatus: 'none' })
		expect(plain.canExtend).toBe(true)
		expect(plain.canChange).toBe(true)
	})

	it('says nothing twice about a booking still awaiting its deposit', () => {
		const held = actionsFor('pending_payment', { paymentStatus: 'pending' })
		expect(held.awaitingPayment).toBe(true)
		expect(held.managerHandles).toBe(false)
		expect(held.canChange).toBe(false)
		expect(held.canCancel).toBe(false)
	})

	it('has no manager line for a booking that is over', () => {
		for (const status of ['finished', 'no_show', 'cancelled'])
			expect(actionsFor(status, { paymentStatus: 'paid' }).managerHandles).toBe(
				false,
			)
	})
})

describe('a party at the table', () => {
	const seated = (over: Record<string, unknown> = {}) =>
		actionsFor('seated', { seatedAt: NOW - 30 * MIN, ...over })
	it('can have its size changed at the door, but not its time', () => {
		const a = seated()
		expect(a.canChange).toBe(true)
		expect(a.changeKind).toBe('size')
		expect(actionsFor('booked').changeKind).toBe('size_time')
	})
	it('can move to another table, and stay a quarter hour longer', () => {
		expect(seated()).toMatchObject({ canMove: true, canExtend: true })
	})
	it('cannot be extended past what a till may set', () => {
		expect(seated({ durationMin: 345 }).canExtend).toBe(true)
		expect(seated({ durationMin: 346 }).canExtend).toBe(false)
		expect(seated({ durationMin: 360 }).canExtend).toBe(false)
	})
	it('can still be given a quarter hour when it is over its time', () => {
		// 13:00 for 90 minutes: over at 14:30; at 15:00 a quarter hour from now is 15:15.
		const a = actionsFor('seated', { seatedAt: NOW }, { now: NOW + 120 * MIN })
		expect(a.canExtend).toBe(true)
	})
	it('is not moved, extended or resized from another day', () => {
		const a = actionsFor('seated', {}, { viewOnly: true })
		expect(a).toMatchObject({
			canMove: false,
			canExtend: false,
			canChange: false,
		})
	})
	it('is only for a party that is seated', () => {
		for (const status of ['booked', 'arrived', 'finished', 'no_show']) {
			const a = actionsFor(status)
			expect(a.canMove).toBe(false)
			expect(a.canExtend).toBe(false)
		}
	})
})

describe('seating at the booked table in one tap', () => {
	const here = { tableIds: ['t3'], tableLabels: ['3'] }
	it('only while the table is free', () => {
		for (const kind of ['open', 'soon'] as const)
			expect(
				actionsFor('arrived', here, { seatTableKind: kind }).seatAt,
			).toEqual({ label: '3', tableId: 't3' })
		// A table that is taken, taped off or being reset is not one tap away.
		for (const kind of ['seated', 'blocked', 'resetting'] as const)
			expect(
				actionsFor('arrived', here, { seatTableKind: kind }).seatAt,
			).toBeNull()
		// Unknown (the table is not on this floor): as before.
		expect(
			actionsFor('arrived', here, { seatTableKind: null }).seatAt,
		).not.toBeNull()
	})
	it('still lets them choose a table when the booked one is not free', () => {
		const a = actionsFor('arrived', here, { seatTableKind: 'seated' })
		expect(a.canSeat).toBe(true)
		expect(a.seatAt).toBeNull()
	})
})

describe('an armed cancel or no-show', () => {
	const armed = { to: 'no_show' as const, version: 3, status: 'booked' }
	it('holds while the booking is as the host saw it', () => {
		expect(armedStillHolds(armed, { version: 3, status: 'booked' })).toBe(true)
	})
	it('disarms when the booking changed, moved on, or went away', () => {
		expect(armedStillHolds(armed, { version: 4, status: 'booked' })).toBe(false)
		expect(armedStillHolds(armed, { version: 3, status: 'arrived' })).toBe(
			false,
		)
		expect(armedStillHolds(armed, null)).toBe(false)
	})
})

describe('a party that is only partly here', () => {
	it('can be marked partly here while it has not been marked here at all', () => {
		for (const status of ['booked', 'confirmed'])
			expect(actionsFor(status, { partySize: 5 }).canPartlyHere).toBe(true)
	})
	it('cannot be marked partly here once at the stand: the server cannot raise or lower the count', () => {
		// arrived -> arrived is not a step the server has.
		expect(actionsFor('arrived', { partySize: 5 }).canPartlyHere).toBe(false)
		expect(
			actionsFor('arrived', { partySize: 5, arrivedCovers: 3 }).canPartlyHere,
		).toBe(false)
	})
	it('is for a party of two or more, today, and not for one seated or gone', () => {
		expect(actionsFor('booked', { partySize: 1 }).canPartlyHere).toBe(false)
		expect(
			actionsFor('booked', { partySize: 5 }, { viewOnly: true }).canPartlyHere,
		).toBe(false)
		for (const status of ['seated', 'finished', 'no_show', 'cancelled'])
			expect(actionsFor(status, { partySize: 5 }).canPartlyHere).toBe(false)
	})
	it('seats the ones who are here (a stepper) once the party is at the stand short of its size', () => {
		const a = actionsFor('arrived', { partySize: 5, arrivedCovers: 3 })
		expect(a.canSeatPart).toBe(true)
		// The plain seating is for a party that is all here.
		expect(a.canSeat).toBe(false)
		expect(a.any).toBe(true)
	})
	it('seats a whole party the plain way', () => {
		for (const arrivedCovers of [5, null]) {
			const a = actionsFor('arrived', { partySize: 5, arrivedCovers })
			expect(a.canSeat).toBe(true)
			expect(a.canSeatPart).toBe(false)
		}
	})
	it('has no seat-part for a booking not at the stand, a lone guest, or another day', () => {
		expect(actionsFor('booked', { partySize: 5 }).canSeatPart).toBe(false)
		expect(
			actionsFor('arrived', { partySize: 1, arrivedCovers: 1 }).canSeatPart,
		).toBe(false)
		expect(
			actionsFor(
				'arrived',
				{ partySize: 5, arrivedCovers: 3 },
				{ viewOnly: true },
			).canSeatPart,
		).toBe(false)
	})
	it('has nothing to seat for a party that sat down short of its size: the rest cannot be added', () => {
		const a = actionsFor('seated', {
			partySize: 5,
			arrivedCovers: 5,
			seatedCovers: 3,
			tableIds: ['t2'],
			tableLabels: ['2'],
		})
		expect(a.canSeat).toBe(false)
		expect(a.canSeatPart).toBe(false)
		expect(a.canFinish).toBe(true)
	})
})
