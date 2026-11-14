import { describe, expect, it, vi } from 'vitest'
import {
	armForRequest,
	handleOrgAlarm,
	type OrgAlarmStorage,
} from './org-alarm.ts'
import {
	createOrderMessagesTickModule,
	isOrderMessagesActivityPath,
	ORDER_MESSAGES_TICK_PATH,
} from './orders-alarm.ts'

function memoryStorage(): OrgAlarmStorage & { alarm: number | null } {
	const values = new Map<string, unknown>()
	return {
		alarm: null,
		async getAlarm() {
			return this.alarm
		},
		async setAlarm(at: number) {
			this.alarm = at
		},
		async get<T>(key: string) {
			return values.get(key) as T | undefined
		},
		async put<T>(key: string, value: T) {
			values.set(key, value)
		},
		async delete(key: string) {
			return values.delete(key)
		},
	}
}

describe('order messages alarm module', () => {
	it('arms on order writes, never on polled reads', () => {
		for (const path of [
			'/orders',
			'/api/orders/payment-status',
			'/operator/orders/abc',
			'/pos/online-orders/abc/command',
			'/pos/kds/command',
		]) {
			expect(isOrderMessagesActivityPath(path), path).toBe(true)
		}
		for (const path of [
			'/orders/abc',
			'/orders/options',
			'/operator/orders',
			'/pos/kds',
			'/pos/online-orders',
			ORDER_MESSAGES_TICK_PATH,
		]) {
			expect(isOrderMessagesActivityPath(path), path).toBe(false)
		}
	})

	it('re-arms only while queued messages remain', async () => {
		const now = 1_800_000_000_000
		const run = vi
			.fn()
			.mockResolvedValueOnce({ needsFollowUp: true, nextDueAt: now + 60_000 })
			.mockResolvedValueOnce({ needsFollowUp: false, nextDueAt: null })
		const module = createOrderMessagesTickModule(run)
		expect(module.name).toBe('orders')
		expect(module.tickPath).toBe('/api/order-messages/tick')

		const storage = memoryStorage()
		expect(
			await armForRequest({
				storage,
				orgId: 'org_1',
				now,
				pathname: '/orders',
				modules: [module],
			}),
		).toBe('armed')

		const first = await handleOrgAlarm({ storage, now, modules: [module] })
		expect(first).toMatchObject({ status: 'ran', rearmedAt: now + 60_000 })
		storage.alarm = null
		const second = await handleOrgAlarm({ storage, now, modules: [module] })
		expect(second).toMatchObject({ status: 'ran', rearmedAt: null })
		expect(storage.alarm).toBeNull()
	})
})
