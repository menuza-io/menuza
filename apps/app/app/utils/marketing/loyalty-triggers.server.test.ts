import { LOYALTY_PERMISSIONS } from '@repo/loyalty'
import { LOYALTY_JOURNEY_TRIGGER_TYPES } from '@repo/tenant-db/types/journey'
import { describe, expect, it } from 'vitest'
import {
	computeLoyaltyTriggersEnabled,
	loyaltyTriggerBlocked,
} from './loyalty-triggers.server.ts'

describe('computeLoyaltyTriggersEnabled', () => {
	const read = [LOYALTY_PERMISSIONS.READ_LOYALTY]
	it('needs the module on and a loyalty read grant', () => {
		expect(computeLoyaltyTriggersEnabled({ enabled: true }, read)).toBe(true)
		expect(computeLoyaltyTriggersEnabled({ enabled: false }, read)).toBe(false)
		expect(computeLoyaltyTriggersEnabled({ enabled: true }, [])).toBe(false)
		expect(
			computeLoyaltyTriggersEnabled({ enabled: true }, [
				LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM,
			]),
		).toBe(false)
	})
})

describe('loyaltyTriggerBlocked', () => {
	it.each(LOYALTY_JOURNEY_TRIGGER_TYPES)(
		'blocks %s while off',
		(triggerType) => {
			expect(loyaltyTriggerBlocked({ triggerType, enabled: false })).toBe(true)
			expect(loyaltyTriggerBlocked({ triggerType, enabled: true })).toBe(false)
		},
	)

	it('lets a journey keep the trigger it already has', () => {
		expect(
			loyaltyTriggerBlocked({
				triggerType: 'loyalty_inactive',
				enabled: false,
				currentTriggerType: 'loyalty_inactive',
			}),
		).toBe(false)
		expect(
			loyaltyTriggerBlocked({
				triggerType: 'loyalty_inactive',
				enabled: false,
				currentTriggerType: 'loyalty_near_reward',
			}),
		).toBe(true)
	})

	it('ignores other triggers', () => {
		expect(
			loyaltyTriggerBlocked({ triggerType: 'manual', enabled: false }),
		).toBe(false)
	})
})
