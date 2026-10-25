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
	options: { now?: number; viewOnly?: boolean } = {},
) =>
	partyActions({
		r: rsv({ start: 13 * 60, status, ...over }) as PartyActionsInput['r'],
		now: options.now ?? NOW,
		viewOnly: options.viewOnly ?? false,
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
