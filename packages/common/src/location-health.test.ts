import { describe, expect, it } from 'vitest'

import {
	getLocationHealth,
	STALE_SYNC_MS,
	summarizeLocations,
	UNSUPPORTED_HEALTH_CHECKS,
	type LocationHealthInput,
} from './location-health.ts'

// Wednesday 12:00 in New York.
const NOW = new Date('2027-03-10T17:00:00Z')

const week = (open: string, close: string) =>
	JSON.stringify(
		[
			'monday',
			'tuesday',
			'wednesday',
			'thursday',
			'friday',
			'saturday',
			'sunday',
		].map((day) => ({ day, isOpen: true, slots: [{ start: open, end: close }] })),
	)

function healthy(overrides: Partial<LocationHealthInput> = {}): LocationHealthInput {
	return {
		now: NOW,
		location: {
			id: 'loc_1',
			name: 'Main',
			timezone: 'America/New_York',
			storeHours: week('09:00', '21:00'),
			onlineHours: week('09:00', '21:00'),
			specialHours: null,
			orderingPausedAt: null,
			orderingPausedUntil: null,
		},
		organization: {
			onlinePaymentsEnabled: true,
			payAtPickupOnly: false,
			sitePublished: true,
			customDomain: null,
			customDomainStatus: null,
		},
		hasActiveMenu: true,
		connections: [],
		phoneAgent: null,
		...overrides,
	}
}

const check = (health: ReturnType<typeof getLocationHealth>, id: string) =>
	health.checks.filter((c) => c.id === id)

describe('getLocationHealth', () => {
	it('a healthy location shows all checks passed', () => {
		const health = getLocationHealth(healthy())
		expect(health.summary).toBe('taking_orders')
		expect(health.allPassed).toBe(true)
		expect(health.closedNow).toBe(false)
		expect(health.checks.every((c) => c.status === 'ok')).toBe(true)
		expect(health.checks.map((c) => c.id)).toEqual([
			'ordering',
			'hours',
			'payments',
			'menu',
			'website',
		])
	})

	it('a disabled payments account is Not taking orders and links to payments', () => {
		const health = getLocationHealth(
			healthy({
				organization: {
					...healthy().organization,
					onlinePaymentsEnabled: false,
				},
			}),
		)
		expect(health.summary).toBe('not_taking_orders')
		expect(health.allPassed).toBe(false)
		expect(check(health, 'payments')[0]).toMatchObject({
			status: 'blocking',
			code: 'payments_disabled',
			href: '/settings/shop',
		})
		expect(check(health, 'payments')[0]!.message).toMatch(/payments account/i)
	})

	it('pay-at-pickup-only is a deliberate choice, not a problem', () => {
		const health = getLocationHealth(
			healthy({
				organization: {
					...healthy().organization,
					onlinePaymentsEnabled: false,
					payAtPickupOnly: true,
				},
			}),
		)
		expect(health.summary).toBe('taking_orders')
		expect(check(health, 'payments')[0]!.code).toBe('pay_at_pickup_only')
	})

	it('a pause blocks, an expired pause does not', () => {
		const paused = getLocationHealth(
			healthy({
				location: {
					...healthy().location,
					orderingPausedAt: new Date(NOW.getTime() - 60_000),
					orderingPausedUntil: null,
				},
			}),
		)
		expect(paused.summary).toBe('not_taking_orders')
		expect(check(paused, 'ordering')[0]).toMatchObject({
			code: 'ordering_paused',
			href: '/orders',
		})
		const until = getLocationHealth(
			healthy({
				location: {
					...healthy().location,
					orderingPausedAt: new Date(NOW.getTime() - 3_600_000),
					orderingPausedUntil: new Date(NOW.getTime() + 60_000),
				},
			}),
		)
		expect(until.summary).toBe('not_taking_orders')
		const over = getLocationHealth(
			healthy({
				location: {
					...healthy().location,
					orderingPausedAt: new Date(NOW.getTime() - 3_600_000),
					orderingPausedUntil: new Date(NOW.getTime() - 60_000),
				},
			}),
		)
		expect(over.summary).toBe('taking_orders')
	})

	it('closed by its hours is a note, not a problem', () => {
		const late = getLocationHealth(
			healthy({ now: new Date('2027-03-10T09:00:00Z') }), // 05:00 local
		)
		expect(late.closedNow).toBe(true)
		expect(check(late, 'hours')[0]).toMatchObject({ status: 'info', code: 'closed_now' })
		expect(late.summary).toBe('taking_orders')
		expect(late.allPassed).toBe(true)
	})

	it('a special closed day shows closed now', () => {
		const health = getLocationHealth(
			healthy({
				location: {
					...healthy().location,
					specialHours: JSON.stringify([
						{ id: 's', date: '2027-03-10', isOpen: false, slots: [] },
					]),
				},
			}),
		)
		expect(health.closedNow).toBe(true)
	})

	it('no hours at all is a warning that links to the location', () => {
		const health = getLocationHealth(
			healthy({
				location: { ...healthy().location, storeHours: null, onlineHours: null },
			}),
		)
		expect(health.summary).toBe('taking_orders_with_problems')
		expect(check(health, 'hours')[0]).toMatchObject({
			code: 'no_hours',
			href: '/settings/locations/loc_1',
		})
	})

	it('no menu on sale and an unpublished site block orders and link to the fix', () => {
		const health = getLocationHealth(
			healthy({
				hasActiveMenu: false,
				organization: { ...healthy().organization, sitePublished: false },
			}),
		)
		expect(health.summary).toBe('not_taking_orders')
		expect(check(health, 'menu')[0]).toMatchObject({ code: 'no_active_menu', href: '/menu/menus' })
		expect(check(health, 'website')[0]).toMatchObject({ code: 'site_unpublished', href: '/website' })
	})

	it('a broken custom domain is a warning; a healthy one passes; none is left out', () => {
		const broken = getLocationHealth(
			healthy({
				organization: {
					...healthy().organization,
					customDomain: 'order.example.com',
					customDomainStatus: 'error',
				},
			}),
		)
		expect(broken.summary).toBe('taking_orders_with_problems')
		expect(check(broken, 'domain')[0]).toMatchObject({ code: 'domain_error', href: '/website' })
		const fine = getLocationHealth(
			healthy({
				organization: {
					...healthy().organization,
					customDomain: 'order.example.com',
					customDomainStatus: 'active',
				},
			}),
		)
		expect(check(fine, 'domain')[0]!.status).toBe('ok')
		expect(check(getLocationHealth(healthy()), 'domain')).toEqual([])
	})

	it('POS and delivery connections: disconnected and stale warn, fresh passes', () => {
		const health = getLocationHealth(
			healthy({
				connections: [
					{ providerName: 'Toast', isActive: false, lastSyncAt: null },
					{
						providerName: 'DoorDash',
						isActive: true,
						lastSyncAt: new Date(NOW.getTime() - STALE_SYNC_MS - 1000),
					},
					{
						providerName: 'Deliveroo',
						isActive: true,
						lastSyncAt: new Date(NOW.getTime() - 60_000),
					},
				],
			}),
		)
		expect(check(health, 'sync').map((c) => c.code)).toEqual([
			'sync_disconnected',
			'sync_stale',
			'sync_ok',
		])
		expect(health.summary).toBe('taking_orders_with_problems')
		expect(check(health, 'sync')[0]!.href).toContain('/settings/integrations')
	})

	it('the phone agent is checked only when it is on', () => {
		expect(check(getLocationHealth(healthy({ phoneAgent: { enabled: false, hasActiveLine: false } })), 'phone_agent')).toEqual([])
		expect(check(getLocationHealth(healthy({ phoneAgent: { enabled: true, hasActiveLine: true } })), 'phone_agent')[0]!.status).toBe('ok')
		const noLine = getLocationHealth(healthy({ phoneAgent: { enabled: true, hasActiveLine: false } }))
		expect(check(noLine, 'phone_agent')[0]).toMatchObject({ code: 'phone_line_inactive', href: '/phone-agent' })
	})

	it('the restaurant summary is the worst state of any location', () => {
		const ok = getLocationHealth(healthy())
		const warn = getLocationHealth(healthy({ location: { ...healthy().location, id: 'b', storeHours: null, onlineHours: null } }))
		const bad = getLocationHealth(healthy({ hasActiveMenu: false }))
		expect(summarizeLocations([ok])).toBe('taking_orders')
		expect(summarizeLocations([ok, warn])).toBe('taking_orders_with_problems')
		expect(summarizeLocations([ok, warn, bad])).toBe('not_taking_orders')
		expect(summarizeLocations([])).toBe('taking_orders')
	})

	it('says plainly which check it cannot run', () => {
		expect(UNSUPPORTED_HEALTH_CHECKS.map((c) => c.id)).toEqual(['kitchen_device'])
	})

	it('every check has words and a link only when there is something to fix', () => {
		const bad = getLocationHealth(
			healthy({
				hasActiveMenu: false,
				organization: { ...healthy().organization, onlinePaymentsEnabled: false, sitePublished: false },
			}),
		)
		for (const c of bad.checks) {
			expect(c.message.length).toBeGreaterThan(10)
			if (c.status === 'blocking' || c.status === 'warning') expect(c.href).toBeTruthy()
		}
	})
})
