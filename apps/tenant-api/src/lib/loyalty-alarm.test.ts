import { describe, expect, it } from 'vitest'
import {
	createLoyaltyTickModule,
	isLoyaltyActivityPath,
	LOYALTY_ALARM_INTERVAL_MS,
} from './loyalty-alarm.ts'

describe('isLoyaltyActivityPath', () => {
	it('counts customer, till and operator loyalty traffic', () => {
		for (const path of [
			'/loyalty',
			'/loyalty/enroll',
			'/loyalty/wallet',
			'/pos/loyalty/identify',
			'/operator/loyalty',
			'/operator/loyalty/members',
			'/api/loyalty/tick',
		]) {
			expect(isLoyaltyActivityPath(path)).toBe(true)
		}
	})

	it('leaves order traffic out: settling rides the order commit', () => {
		for (const path of [
			'/orders',
			'/orders/ord_1',
			'/api/orders',
			'/qr/t/abc',
			'/pos/orders',
			'/operator/orders',
			'/loyaltyish',
			'/operator/loyaltyish',
			'/',
		]) {
			expect(isLoyaltyActivityPath(path)).toBe(false)
		}
	})
})

describe('createLoyaltyTickModule', () => {
	it('declares the loyalty tick for the alarm scheduler', () => {
		const module = createLoyaltyTickModule(async () => ({
			needsFollowUp: true,
			nextDueAt: 1234,
		}))
		expect(module.name).toBe('loyalty')
		expect(module.tickPath).toBe('/api/loyalty/tick')
		expect(module.intervalMs).toBe(LOYALTY_ALARM_INTERVAL_MS)
		expect(module.intervalMs).toBe(2 * 60 * 1000)
		expect(module.isActivityPath).toBe(isLoyaltyActivityPath)
	})

	it('forwards the run result to the scheduler', async () => {
		const module = createLoyaltyTickModule(async (orgId, now) => ({
			needsFollowUp: orgId === 'org_a' && now === 42,
			nextDueAt: null,
		}))
		expect(await module.run('org_a', 42)).toEqual({
			needsFollowUp: true,
			nextDueAt: null,
		})
		expect(await module.run('org_b', 42)).toEqual({
			needsFollowUp: false,
			nextDueAt: null,
		})
	})
})
