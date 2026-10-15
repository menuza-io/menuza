import { describe, expect, it } from 'vitest'
import {
	FINISHED_UNDO_WINDOW_MS,
	RESERVATION_ACTORS,
	RESERVATION_STATUSES,
	canTransition,
	consumesCapacity,
	quickActionsFor,
	transitionReservation,
} from './state-machine.ts'

describe('booking state machine, capacity consumption, undo rules, and quick actions', () => {
	const nowMs = 1_700_000_000_000

	it('defines all 13 statuses and 4 actors', () => {
		expect(RESERVATION_STATUSES).toEqual([
			'pending_payment',
			'pending_approval',
			'booked',
			'confirmed',
			'arrived',
			'partially_seated',
			'seated',
			'finished',
			'cancelled',
			'no_show',
			'declined',
			'expired',
			'disputed',
		])
		expect(RESERVATION_ACTORS).toEqual(['guest', 'operator', 'system', 'voice'])
		expect(FINISHED_UNDO_WINDOW_MS).toBe(30 * 60_000)
	})

	it('correctly identifies which statuses consume table capacity (Invariant I2)', () => {
		const consuming = [
			'booked',
			'confirmed',
			'arrived',
			'partially_seated',
			'seated',
		] as const
		const nonConsuming = [
			'pending_payment',
			'pending_approval',
			'finished',
			'cancelled',
			'no_show',
			'declined',
			'expired',
			'disputed',
		] as const

		for (const s of consuming) {
			expect(consumesCapacity(s)).toBe(true)
		}
		for (const s of nonConsuming) {
			expect(consumesCapacity(s)).toBe(false)
		}
	})

	it('enforces allowed and forbidden transitions per actor (guest, operator, system, voice)', () => {
		// Guest can confirm from booked and cancel from booked/confirmed/arrived/pending_approval/pending_payment
		expect(canTransition('booked', 'confirmed', 'guest')).toBe(true)
		expect(canTransition('booked', 'cancelled', 'guest')).toBe(true)
		expect(canTransition('confirmed', 'cancelled', 'guest')).toBe(true)
		// Guest cannot seat or finish or mark no_show
		expect(canTransition('booked', 'seated', 'guest')).toBe(false)
		expect(canTransition('seated', 'finished', 'guest')).toBe(false)
		expect(canTransition('booked', 'no_show', 'guest')).toBe(false)

		// Voice can confirm or cancel from booked/confirmed, but cannot seat
		expect(canTransition('booked', 'cancelled', 'voice')).toBe(true)
		expect(canTransition('confirmed', 'cancelled', 'voice')).toBe(true)
		expect(canTransition('booked', 'seated', 'voice')).toBe(false)

		// System can transition pending_payment -> booked | expired, booked/confirmed -> no_show, any -> disputed
		expect(canTransition('pending_payment', 'booked', 'system')).toBe(true)
		expect(canTransition('pending_payment', 'expired', 'system')).toBe(true)
		expect(canTransition('booked', 'no_show', 'system')).toBe(true)
		expect(canTransition('finished', 'disputed', 'system')).toBe(true)

		// Operator can approve/decline pending_approval, walk through service flow, and undo
		expect(canTransition('pending_approval', 'booked', 'operator')).toBe(true)
		expect(canTransition('pending_approval', 'declined', 'operator')).toBe(true)
		expect(canTransition('booked', 'confirmed', 'operator')).toBe(true)
		expect(canTransition('confirmed', 'arrived', 'operator')).toBe(true)
		expect(canTransition('arrived', 'partially_seated', 'operator')).toBe(true)
		expect(canTransition('partially_seated', 'seated', 'operator')).toBe(true)
		expect(canTransition('seated', 'finished', 'operator')).toBe(true)
		// Operator undo: seated -> arrived | confirmed | booked, no_show -> booked | confirmed | arrived | seated
		expect(canTransition('seated', 'arrived', 'operator')).toBe(true)
		expect(canTransition('seated', 'booked', 'operator')).toBe(true)
		expect(canTransition('no_show', 'seated', 'operator')).toBe(true)
	})

	it('enforces the 30-minute window on operator undo finished -> seated', () => {
		// Within 20 minutes of finishedAtMs -> allowed
		const withinWindow = transitionReservation({
			from: 'finished',
			to: 'seated',
			actor: 'operator',
			nowMs,
			finishedAtMs: nowMs - 20 * 60_000,
		})
		expect(withinWindow.ok).toBe(true)

		// After 31 minutes of finishedAtMs -> rejected
		const expiredWindow = transitionReservation({
			from: 'finished',
			to: 'seated',
			actor: 'operator',
			nowMs,
			finishedAtMs: nowMs - 31 * 60_000,
		})
		expect(expiredWindow.ok).toBe(false)
		if (!expiredWindow.ok) {
			expect(expiredWindow.code).toBe('invalid_transition')
		}
	})

	it('returns contextual quick actions for each reservation status', () => {
		expect(quickActionsFor('pending_approval')).toContain('approve')
		expect(quickActionsFor('pending_approval')).toContain('decline')
		expect(quickActionsFor('booked')).toContain('arrive')
		expect(quickActionsFor('booked')).toContain('seat')
		expect(quickActionsFor('arrived')).toContain('seat')
		expect(quickActionsFor('seated')).toContain('finish')
		expect(quickActionsFor('seated')).toContain('undo_seat')
		expect(
			quickActionsFor('finished', {
				nowMs,
				finishedAtMs: nowMs - 10 * 60_000,
			}),
		).toContain('undo_finish')
		expect(
			quickActionsFor('finished', {
				nowMs,
				finishedAtMs: nowMs - 45 * 60_000,
			}),
		).not.toContain('undo_finish')
	})
})
