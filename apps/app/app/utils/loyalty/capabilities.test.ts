import { LOYALTY_PERMISSIONS as P } from '@repo/loyalty'
import { describe, expect, it } from 'vitest'
import {
	computeLoyaltyCapabilities,
	NO_LOYALTY_CAPABILITIES,
} from './capabilities.ts'

const ON = { enabled: true, redemption: false }

describe('computeLoyaltyCapabilities', () => {
	it('shows nothing while the flag is off, whatever the grants', () => {
		expect(
			computeLoyaltyCapabilities({
				features: { enabled: false, redemption: false },
				grants: [P.READ_LOYALTY, P.UPDATE_LOYALTY_POINTS],
				locationIds: null,
				impersonated: false,
			}),
		).toEqual(NO_LOYALTY_CAPABILITIES)
	})

	it('needs read:loyalty:any to read', () => {
		const caps = computeLoyaltyCapabilities({
			features: ON,
			grants: [P.READ_LOYALTY_REPORT],
			locationIds: null,
			impersonated: false,
		})
		expect(caps).toEqual({
			enabled: true,
			canRead: false,
			canAdjust: false,
			canReconcile: false,
		})
	})

	it('reads with the read grant and acts only with the matching update grant', () => {
		const base = { features: ON, locationIds: null, impersonated: false }
		expect(
			computeLoyaltyCapabilities({ ...base, grants: [P.READ_LOYALTY] }),
		).toEqual({
			enabled: true,
			canRead: true,
			canAdjust: false,
			canReconcile: false,
		})
		expect(
			computeLoyaltyCapabilities({
				...base,
				grants: [P.UPDATE_LOYALTY_POINTS],
			}),
		).toMatchObject({ canRead: true, canAdjust: true, canReconcile: false })
		expect(
			computeLoyaltyCapabilities({
				...base,
				grants: [P.UPDATE_LOYALTY_REDEMPTION],
			}),
		).toMatchObject({ canRead: true, canAdjust: false, canReconcile: true })
	})

	it('never lets support impersonation change anything', () => {
		expect(
			computeLoyaltyCapabilities({
				features: ON,
				grants: [P.UPDATE_LOYALTY_POINTS, P.UPDATE_LOYALTY_REDEMPTION],
				locationIds: null,
				impersonated: true,
			}),
		).toEqual({
			enabled: true,
			canRead: true,
			canAdjust: false,
			canReconcile: false,
		})
	})

	it('hides the panel for a member restricted to no location', () => {
		expect(
			computeLoyaltyCapabilities({
				features: ON,
				grants: [P.READ_LOYALTY],
				locationIds: [],
				impersonated: false,
			}),
		).toMatchObject({ canRead: false, canAdjust: false })
	})
})
