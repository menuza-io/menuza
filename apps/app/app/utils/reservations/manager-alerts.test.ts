import { describe, expect, it } from 'vitest'
import {
	describeReservationAlert,
	isReservationAlertWorkflow,
	RESERVATION_ALERT_GRANTS,
	RESERVATION_ALERT_KINDS,
	reservationAlertEventSchema,
	reservationAlertKindFromNotificationType,
	reservationAlertNotificationType,
	reservationAlertWorkflow,
} from './manager-alerts.ts'

const valid = {
	orgId: 'org_1',
	eventId: 'evt_0123456789',
	kind: 'large_party_request',
	locationId: 'loc_1',
	count: 2,
}

describe('reservation alert event schema', () => {
	it('accepts the five documented fields only', () => {
		expect(reservationAlertEventSchema.safeParse(valid).success).toBe(true)
		expect(
			reservationAlertEventSchema.safeParse({ ...valid, guestName: 'A' })
				.success,
		).toBe(false)
	})

	it('accepts the seven documented kinds and nothing else', () => {
		expect(RESERVATION_ALERT_KINDS).toEqual([
			'large_party_request',
			'waitlist_remote_join',
			'unassigned_conflict',
			'payment_failed',
			'payment_review',
			'dispute_opened',
			'message_failed_bulk',
		])
		expect(
			reservationAlertEventSchema.safeParse({ ...valid, kind: 'other' })
				.success,
		).toBe(false)
	})

	it('rejects ids that are not opaque', () => {
		for (const patch of [
			{ orgId: 'a b' },
			{ locationId: 'x@y.com' },
			{ eventId: 'short' },
		]) {
			expect(
				reservationAlertEventSchema.safeParse({ ...valid, ...patch }).success,
			).toBe(false)
		}
	})
})

describe('reservation alert vocabulary', () => {
	it('maps every kind to a workflow and a notification type that round-trips', () => {
		for (const kind of RESERVATION_ALERT_KINDS) {
			expect(isReservationAlertWorkflow(reservationAlertWorkflow(kind))).toBe(
				true,
			)
			expect(reservationAlertWorkflow(kind)).toBe(`reservations.${kind}`)
			expect(
				reservationAlertKindFromNotificationType(
					reservationAlertNotificationType(kind),
				),
			).toBe(kind)
		}
		expect(reservationAlertKindFromNotificationType('staffing-x')).toBeNull()
		expect(isReservationAlertWorkflow('reservations.other')).toBe(false)
	})

	it('tells members who read reservations or edit reservation settings', () => {
		expect([...RESERVATION_ALERT_GRANTS].sort()).toEqual([
			'read:reservation:any',
			'update:reservation:any',
			'update:reservation_settings:any',
		])
	})

	it('writes email copy with the count and optional place for every kind', () => {
		for (const kind of RESERVATION_ALERT_KINDS) {
			const withPlace = describeReservationAlert({
				kind,
				count: 2,
				locationName: 'Downtown',
			})
			expect(withPlace.subject).toContain('2')
			expect(withPlace.subject).toContain('Downtown')
			const without = describeReservationAlert({
				kind,
				count: 1,
				locationName: null,
			})
			expect(without.subject).not.toContain('null')
			expect(without.detail.length).toBeGreaterThan(10)
		}
	})
})
