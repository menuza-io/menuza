import { RESERVATIONS_PERMISSIONS as P } from '@repo/reservations'
import { describe, expect, it } from 'vitest'
import { computePeopleAccess, hasPeopleAccess } from './people-access.ts'

const base = {
	canReadSettings: false,
	canUpdateSettings: false,
	reservationsEnabled: true,
	grants: [] as Array<(typeof P)[keyof typeof P]>,
	impersonated: false,
}

describe('computePeopleAccess', () => {
	it('gives a host (read:reservation only) no access at all', () => {
		const access = computePeopleAccess({
			...base,
			grants: [P.READ_RESERVATION],
		})
		expect(hasPeopleAccess(access)).toBe(false)
	})

	it('gives the guest grant the full dining facet and no customer facet', () => {
		const access = computePeopleAccess({
			...base,
			grants: [P.READ_RESERVATION_GUEST],
		})
		expect(access).toMatchObject({
			customers: false,
			dining: 'full',
			canUpdateDining: false,
			canDelete: false,
		})
	})

	it('gives customer readers only flags (no allergy, notes) when they hold read:reservation without the guest grant', () => {
		const access = computePeopleAccess({
			...base,
			canReadSettings: true,
			grants: [P.READ_RESERVATION],
		})
		expect(access.dining).toBe('flags')
		expect(access.customers).toBe(true)
	})

	it('has no dining facet when reservations are off', () => {
		const access = computePeopleAccess({
			...base,
			canReadSettings: true,
			reservationsEnabled: false,
			grants: [P.READ_RESERVATION_GUEST],
		})
		expect(access).toMatchObject({ customers: true, dining: 'none' })
	})

	it('lets an admin do everything, and nothing destructive while impersonating', () => {
		const admin = {
			...base,
			canReadSettings: true,
			canUpdateSettings: true,
			grants: [P.READ_RESERVATION_GUEST, P.UPDATE_RESERVATION_GUEST],
		}
		expect(computePeopleAccess(admin)).toEqual({
			customers: true,
			dining: 'full',
			canUpdateCustomers: true,
			canUpdateDining: true,
			canDelete: true,
		})
		expect(computePeopleAccess({ ...admin, impersonated: true })).toEqual({
			customers: true,
			dining: 'flags',
			canUpdateCustomers: false,
			canUpdateDining: false,
			canDelete: false,
		})
	})

	it('needs both write rights to erase when both facets exist', () => {
		const settingsOnly = computePeopleAccess({
			...base,
			canReadSettings: true,
			canUpdateSettings: true,
			grants: [P.READ_RESERVATION_GUEST],
		})
		expect(settingsOnly.canDelete).toBe(false)
		const noReservations = computePeopleAccess({
			...base,
			canReadSettings: true,
			canUpdateSettings: true,
			reservationsEnabled: false,
		})
		expect(noReservations.canDelete).toBe(true)
	})
})
