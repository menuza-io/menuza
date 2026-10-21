import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	enabled: vi.fn(),
	grants: vi.fn(),
}))

vi.mock('#app/utils/reservations/access.server.ts', () => ({
	isReservationsFeatureEnabled: mocks.enabled,
	getUserReservationsGrants: mocks.grants,
}))

const {
	countVisibleReservationAlerts,
	filterVisibleReservationNotifications,
	isReservationsNotificationType,
	reservationAlertVisibleOrgIds,
} = await import('./notification-visibility.server.ts')

const note = (id: string, type: string, organizationId: string) => ({
	id,
	type,
	organizationId,
})

beforeEach(() => {
	mocks.enabled.mockReset().mockResolvedValue(true)
	mocks.grants.mockReset().mockResolvedValue(['read:reservation:any'])
})

describe('reservations notification visibility', () => {
	it('recognises only reservations types', () => {
		expect(isReservationsNotificationType('reservations-payment-failed')).toBe(
			true,
		)
		expect(isReservationsNotificationType('staffing-no-clock-in')).toBe(false)
	})

	it('shows alerts while the module is on and the member reads reservations', async () => {
		const list = [
			note('1', 'reservations-large-party-request', 'o1'),
			note('2', 'mention', 'o1'),
		]
		expect(await filterVisibleReservationNotifications('u', list)).toEqual(list)
	})

	it('shows alerts to a member who only edits reservation settings', async () => {
		mocks.grants.mockResolvedValue(['update:reservation_settings:any'])
		expect(await reservationAlertVisibleOrgIds('u', ['o1'])).toEqual(
			new Set(['o1']),
		)
	})

	it('hides alerts, and only alerts, when the flag is off', async () => {
		mocks.enabled.mockResolvedValue(false)
		const out = await filterVisibleReservationNotifications('u', [
			note('1', 'reservations-payment-failed', 'o1'),
			note('2', 'mention', 'o1'),
		])
		expect(out.map((n) => n.id)).toEqual(['2'])
	})

	it('hides alerts after the member loses the permission', async () => {
		mocks.grants.mockResolvedValue(['read:reservation_guest:any'])
		expect(
			await filterVisibleReservationNotifications('u', [
				note('1', 'reservations-payment-failed', 'o1'),
			]),
		).toEqual([])
	})

	it('hides the email-only marker even for a member who may see alerts', async () => {
		expect(
			await filterVisibleReservationNotifications('u', [
				note('1', 'reservations-email-sent', 'o1'),
				note('2', 'reservations-payment-review', 'o1'),
			]),
		).toEqual([note('2', 'reservations-payment-review', 'o1')])
	})

	it('hides rather than shows when access cannot be determined', async () => {
		mocks.enabled.mockRejectedValue(new Error('down'))
		expect(await reservationAlertVisibleOrgIds('u', ['o1'])).toEqual(new Set())
	})

	it('counts only the alerts of organizations the member can still open', async () => {
		mocks.enabled.mockImplementation(async (org: string) => org === 'o1')
		expect(
			await countVisibleReservationAlerts('u', [
				{ organizationId: 'o1' },
				{ organizationId: 'o1' },
				{ organizationId: 'o2' },
			]),
		).toBe(2)
		expect(await countVisibleReservationAlerts('u', [])).toBe(0)
	})
})
