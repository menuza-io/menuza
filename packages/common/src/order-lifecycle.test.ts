import { describe, expect, it } from 'vitest'

import {
	acceptanceDeadline,
	guestCancelWindow,
	guestVisibleCancelReason,
	ORDER_ACCEPTANCE_AUTO,
	ORDER_CANCEL_REASONS,
	ORDER_REJECT_REASONS,
	ORDER_STORED_CANCEL_REASONS,
	orderNeedsAcceptance,
	publicOrderLifecycleSchema,
	readGuestCancelPolicy,
	readOrderAcceptancePolicy,
	readStoredCancelReason,
	type GuestCancelWindowInput,
	type OrderAcceptancePolicy,
} from './restaurant-orders.ts'

const MIN = 60_000
const T0 = new Date('2026-11-14T12:00:00.000Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN)

describe('cancel reasons', () => {
	it('stores every operator, reject and system reason', () => {
		for (const reason of [
			...ORDER_CANCEL_REASONS,
			...ORDER_REJECT_REASONS,
			'not_accepted_in_time',
		])
			expect(ORDER_STORED_CANCEL_REASONS).toContain(reason)
	})

	it('shows the guest only out of stock and kitchen closed', () => {
		expect(guestVisibleCancelReason('out_of_stock')).toBe('out_of_stock')
		expect(guestVisibleCancelReason('kitchen_closed')).toBe('kitchen_closed')
		for (const reason of [
			'guest_asked',
			'duplicate',
			'too_busy',
			'other',
			'not_accepted_in_time',
			'bananas',
			null,
			undefined,
		])
			expect(guestVisibleCancelReason(reason)).toBeNull()
	})

	it('reads stored reasons, unknown ones as null', () => {
		expect(readStoredCancelReason('too_busy')).toBe('too_busy')
		expect(readStoredCancelReason('x')).toBeNull()
		expect(readStoredCancelReason(3)).toBeNull()
	})
})

describe('readGuestCancelPolicy', () => {
	it('reads one location, failing closed', () => {
		const context = {
			loc_1: { minutes: 2, scheduledLeadMinutes: 60 },
			loc_bad: { minutes: 3, scheduledLeadMinutes: null },
			loc_neg: { minutes: 5, scheduledLeadMinutes: -1 },
		}
		expect(readGuestCancelPolicy(context, 'loc_1')).toEqual({
			minutes: 2,
			scheduledLeadMinutes: 60,
		})
		expect(readGuestCancelPolicy(context, 'loc_bad')).toBeNull()
		expect(readGuestCancelPolicy(context, 'loc_neg')).toBeNull()
		expect(readGuestCancelPolicy(context, 'loc_missing')).toBeNull()
		expect(readGuestCancelPolicy(context, 'toString')).toBeNull()
		for (const value of [undefined, null, 'x', [], 1])
			expect(readGuestCancelPolicy(value, 'loc_1')).toBeNull()
	})
})

describe('guestCancelWindow', () => {
	const base: GuestCancelWindowInput = {
		status: 'accepted',
		paymentMethod: 'online',
		paymentStatus: 'paid',
		fulfillment: 'pickup',
		source: null,
		tabId: null,
		placedAt: at(0),
		paidAt: at(1),
		scheduledFor: null,
		dropCutoffAt: null,
		policy: { minutes: 2, scheduledLeadMinutes: 60 },
		kitchenStarted: false,
		now: at(2),
	}

	it('is off without a policy', () => {
		expect(guestCancelWindow({ ...base, policy: null })).toEqual({
			allowed: false,
			until: null,
			reason: 'disabled',
		})
	})

	it('opens an ASAP window from the payment, closed exactly at its end', () => {
		expect(guestCancelWindow(base)).toEqual({
			allowed: true,
			until: at(3),
			reason: null,
		})
		expect(
			guestCancelWindow({ ...base, now: new Date(at(3).getTime() - 1) })
				.allowed,
		).toBe(true)
		expect(guestCancelWindow({ ...base, now: at(3) })).toEqual({
			allowed: false,
			until: at(3),
			reason: 'cancel_window_closed',
		})
	})

	it('starts a handoff order window at placement', () => {
		const result = guestCancelWindow({
			...base,
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			paidAt: null,
			now: at(1),
		})
		expect(result).toEqual({ allowed: true, until: at(2), reason: null })
	})

	it('falls back to placement when a paid online order has no payment time', () => {
		expect(
			guestCancelWindow({ ...base, paidAt: null, now: at(1) }).until,
		).toEqual(at(2))
	})

	it('refuses an online order that is not paid', () => {
		for (const paymentStatus of ['pending', 'unpaid', 'failed', 'review'])
			expect(guestCancelWindow({ ...base, paymentStatus }).reason).toBe(
				'not_cancellable',
			)
		// A free order needs no payment.
		expect(
			guestCancelWindow({ ...base, paymentStatus: 'not_required' }).allowed,
		).toBe(true)
	})

	it('refuses a pay-at-handoff order that is already paid: a guest cancel books no refund for it', () => {
		const handoff = {
			...base,
			paymentMethod: 'handoff',
			paidAt: null,
			now: at(1),
		}
		expect(guestCancelWindow({ ...handoff, paymentStatus: 'paid' })).toEqual({
			allowed: false,
			until: null,
			reason: 'not_cancellable',
		})
		// Not yet paid (or nothing to pay) stays cancellable.
		for (const paymentStatus of ['unpaid', 'not_required'])
			expect(guestCancelWindow({ ...handoff, paymentStatus }).allowed).toBe(
				true,
			)
		// A paid online order is still cancellable (the refund is booked).
		expect(guestCancelWindow(base).allowed).toBe(true)
	})

	it('lets a scheduled order be cancelled until the lead before its time', () => {
		const scheduled = { ...base, scheduledFor: at(180) }
		expect(guestCancelWindow({ ...scheduled, now: at(100) })).toEqual({
			allowed: true,
			until: at(120),
			reason: null,
		})
		expect(guestCancelWindow({ ...scheduled, now: at(120) }).reason).toBe(
			'cancel_window_closed',
		)
	})

	it('never gives a scheduled order less than the ASAP window', () => {
		// Due in 30 minutes with a 60-minute lead: the 2-minute window still holds.
		const result = guestCancelWindow({ ...base, scheduledFor: at(30) })
		expect(result).toEqual({ allowed: true, until: at(3), reason: null })
	})

	it('gives a scheduled order the ASAP window when no lead is set', () => {
		const result = guestCancelWindow({
			...base,
			scheduledFor: at(180),
			policy: { minutes: 5, scheduledLeadMinutes: null },
		})
		expect(result.until).toEqual(at(6))
	})

	it('closes a drop order at the drop cutoff', () => {
		const result = guestCancelWindow({
			...base,
			scheduledFor: at(180),
			dropCutoffAt: at(2),
			now: at(2),
		})
		expect(result).toEqual({
			allowed: false,
			until: at(2),
			reason: 'cancel_window_closed',
		})
	})

	it('refuses once the kitchen started, even inside the window', () => {
		expect(guestCancelWindow({ ...base, kitchenStarted: true })).toEqual({
			allowed: false,
			until: at(3),
			reason: 'order_in_preparation',
		})
		expect(guestCancelWindow({ ...base, status: 'preparing' }).reason).toBe(
			'order_in_preparation',
		)
	})

	it('allows an order still waiting for acceptance', () => {
		expect(
			guestCancelWindow({ ...base, status: 'pending_acceptance' }).allowed,
		).toBe(true)
	})

	it('refuses table rounds, tabs, dine-in and finished orders', () => {
		for (const change of [
			{ fulfillment: 'dine_in' },
			{ tabId: 'tab_1' },
			{ source: 'qr_table' },
			{ status: 'ready' },
			{ status: 'completed' },
			{ status: 'cancelled' },
			{ status: 'expired' },
			{ status: 'payment_review' },
		])
			expect(guestCancelWindow({ ...base, ...change })).toMatchObject({
				allowed: false,
				reason: 'not_cancellable',
			})
		// A QR poster order is an ordinary pickup.
		expect(guestCancelWindow({ ...base, source: 'qr_poster' }).allowed).toBe(
			true,
		)
	})
})

describe('order acceptance', () => {
	const manual: OrderAcceptancePolicy = {
		mode: 'manual',
		timeoutMinutes: 5,
		minTotalCents: null,
		scheduledOnly: false,
	}
	const webOrder = {
		totalCents: 2000,
		scheduled: false,
		fulfillment: 'pickup',
		source: null,
		tabId: null,
	}

	it('reads one location, failing closed to Automatic', () => {
		const context = {
			loc_1: { ...manual, minTotalCents: 5000 },
			loc_bad: { ...manual, timeoutMinutes: 4 },
		}
		expect(readOrderAcceptancePolicy(context, 'loc_1')).toEqual({
			...manual,
			minTotalCents: 5000,
		})
		expect(readOrderAcceptancePolicy(context, 'loc_bad')).toEqual(
			ORDER_ACCEPTANCE_AUTO,
		)
		expect(readOrderAcceptancePolicy(context, 'loc_missing')).toEqual(
			ORDER_ACCEPTANCE_AUTO,
		)
		for (const value of [undefined, null, 'x', []])
			expect(readOrderAcceptancePolicy(value, 'loc_1')).toEqual(
				ORDER_ACCEPTANCE_AUTO,
			)
	})

	it('only manual locations make web orders wait', () => {
		expect(orderNeedsAcceptance(ORDER_ACCEPTANCE_AUTO, webOrder)).toBe(false)
		expect(orderNeedsAcceptance(null, webOrder)).toBe(false)
		expect(orderNeedsAcceptance(manual, webOrder)).toBe(true)
		expect(
			orderNeedsAcceptance(manual, { ...webOrder, fulfillment: 'delivery' }),
		).toBe(true)
		expect(
			orderNeedsAcceptance(manual, { ...webOrder, source: 'qr_poster' }),
		).toBe(true)
	})

	it('never makes table rounds, tabs or dine-in wait', () => {
		for (const change of [
			{ fulfillment: 'dine_in' },
			{ tabId: 'tab_1' },
			{ source: 'qr_table' },
		])
			expect(orderNeedsAcceptance(manual, { ...webOrder, ...change })).toBe(
				false,
			)
	})

	it('narrows by a minimum total (strictly over) and by scheduled orders', () => {
		const overFifty = { ...manual, minTotalCents: 5000 }
		expect(
			orderNeedsAcceptance(overFifty, { ...webOrder, totalCents: 5000 }),
		).toBe(false)
		expect(
			orderNeedsAcceptance(overFifty, { ...webOrder, totalCents: 5001 }),
		).toBe(true)
		const scheduledOnly = { ...manual, scheduledOnly: true }
		expect(orderNeedsAcceptance(scheduledOnly, webOrder)).toBe(false)
		expect(
			orderNeedsAcceptance(scheduledOnly, { ...webOrder, scheduled: true }),
		).toBe(true)
		// Both set: the order must match both.
		const both = { ...manual, minTotalCents: 5000, scheduledOnly: true }
		expect(
			orderNeedsAcceptance(both, {
				...webOrder,
				scheduled: true,
				totalCents: 1000,
			}),
		).toBe(false)
		expect(
			orderNeedsAcceptance(both, {
				...webOrder,
				scheduled: true,
				totalCents: 9000,
			}),
		).toBe(true)
	})

	it('gives an ASAP order the configured minutes', () => {
		expect(acceptanceDeadline({ timeoutMinutes: 5 }, { now: T0 })).toEqual(
			at(5),
		)
		expect(
			acceptanceDeadline(
				{ timeoutMinutes: 3 },
				{ now: T0, scheduledFireAt: null },
			),
		).toEqual(at(3))
	})

	it('gives a scheduled order until 30 minutes before it fires, never less than the minutes', () => {
		// Two days ahead: decide up to 30 minutes before the fire time.
		expect(
			acceptanceDeadline(
				{ timeoutMinutes: 5 },
				{ now: T0, scheduledFireAt: at(48 * 60) },
			),
		).toEqual(at(48 * 60 - 30))
		// Fires in 32 minutes: 30 before is 2 minutes from now, so the 10 hold.
		expect(
			acceptanceDeadline(
				{ timeoutMinutes: 10 },
				{ now: T0, scheduledFireAt: at(32) },
			),
		).toEqual(at(10))
	})
})

describe('publicOrderLifecycleSchema', () => {
	it('parses an older response with none of the fields', () => {
		expect(publicOrderLifecycleSchema.safeParse({}).success).toBe(true)
	})

	it('never carries an internal cancel reason', () => {
		expect(
			publicOrderLifecycleSchema.safeParse({ cancelReason: 'duplicate' })
				.success,
		).toBe(false)
		expect(
			publicOrderLifecycleSchema.safeParse({
				cancelReason: 'kitchen_closed',
				cancelledBy: 'operator',
				rejected: true,
				acceptanceDeadlineAt: null,
				refundStatus: 'pending',
				refundPendingCents: 1200,
				cancel: { allowed: false, until: null },
				refundsOnCancel: false,
			}).success,
		).toBe(true)
		expect(
			publicOrderLifecycleSchema.safeParse({ refundsOnCancel: 'yes' }).success,
		).toBe(false)
	})
})
