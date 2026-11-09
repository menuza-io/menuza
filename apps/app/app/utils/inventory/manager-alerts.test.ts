import {
	INVENTORY_NOTIFY_KINDS,
	inventoryNotifyEventSchema,
} from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	describeInventoryAlert,
	INVENTORY_ALERT_GRANTS,
	INVENTORY_ALERT_WORKFLOWS,
	INVENTORY_COST_BEARING_KINDS,
	inventoryAlertAllowedFor,
	inventoryAlertKindFromNotificationType,
	inventoryAlertNotificationType,
	inventoryAlertPath,
	inventoryAlertWorkflow,
	isInventoryAlertWorkflow,
} from './manager-alerts.ts'

describe('inventory alert vocabulary', () => {
	it('maps every contract kind to a workflow and a notification type that round-trip', () => {
		expect(INVENTORY_ALERT_WORKFLOWS).toHaveLength(
			INVENTORY_NOTIFY_KINDS.length,
		)
		for (const kind of INVENTORY_NOTIFY_KINDS) {
			expect(isInventoryAlertWorkflow(inventoryAlertWorkflow(kind))).toBe(true)
			expect(
				inventoryAlertKindFromNotificationType(
					inventoryAlertNotificationType(kind),
				),
			).toBe(kind)
			expect(inventoryAlertPath(kind)).toMatch(/^\/inventory\//)
		}
		expect(inventoryAlertWorkflow('inventory_low_stock')).toBe(
			'inventory.low_stock',
		)
		expect(inventoryAlertNotificationType('inventory_price_rise')).toBe(
			'inventory-price-rise',
		)
		expect(
			inventoryAlertKindFromNotificationType('inventory-email-sent'),
		).toBeNull()
		expect(inventoryAlertKindFromNotificationType('staffing-x')).toBeNull()
		expect(isInventoryAlertWorkflow('inventory.other')).toBe(false)
	})

	it('accepts the contract event and refuses an item name', () => {
		const event = {
			orgId: 'org_1',
			eventId: 'abcdef0123456789',
			kind: 'inventory_low_stock',
			locationId: 'main',
			count: 2,
		}
		expect(inventoryNotifyEventSchema.safeParse(event).success).toBe(true)
		expect(
			inventoryNotifyEventSchema.safeParse({ ...event, itemName: 'x' }).success,
		).toBe(false)
	})

	it('tells holders of any inventory grant, and gates only the cost-bearing kind on the cost grant', () => {
		expect(INVENTORY_COST_BEARING_KINDS).toEqual(['inventory_price_rise'])
		expect([...INVENTORY_ALERT_GRANTS]).toContain('read:inventory:any')
		const reader = new Set(['read:inventory:any'])
		const buyer = new Set(['update:inventory_purchasing:any'])
		const cost = new Set(['read:inventory_cost:any'])
		expect(inventoryAlertAllowedFor('inventory_low_stock', reader)).toBe(true)
		expect(inventoryAlertAllowedFor('inventory_low_stock', buyer)).toBe(true)
		expect(inventoryAlertAllowedFor('inventory_price_rise', reader)).toBe(false)
		expect(inventoryAlertAllowedFor('inventory_price_rise', buyer)).toBe(false)
		expect(inventoryAlertAllowedFor('inventory_price_rise', cost)).toBe(true)
		expect(
			inventoryAlertAllowedFor(
				'inventory_low_stock',
				new Set(['read:note:any']),
			),
		).toBe(false)
	})

	it('writes email copy with the count and optional place for every kind', () => {
		for (const kind of INVENTORY_NOTIFY_KINDS) {
			const withPlace = describeInventoryAlert({
				kind,
				count: 2,
				locationName: 'Downtown',
			})
			expect(withPlace.subject).toContain('Downtown')
			expect(withPlace.headline).toMatch(/2/)
			const without = describeInventoryAlert({
				kind,
				count: 1,
				locationName: null,
			})
			expect(without.subject).not.toContain('null')
			expect(without.detail.length).toBeGreaterThan(10)
		}
	})
})
