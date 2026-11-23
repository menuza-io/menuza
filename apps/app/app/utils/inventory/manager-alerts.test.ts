import {
	INVENTORY_ALL_NOTIFY_KINDS,
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
		// Going off the menu and coming back are one setting.
		expect(INVENTORY_ALERT_WORKFLOWS).toHaveLength(
			INVENTORY_ALL_NOTIFY_KINDS.length - 1,
		)
		for (const kind of INVENTORY_ALL_NOTIFY_KINDS) {
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
		for (const kind of INVENTORY_ALL_NOTIFY_KINDS) {
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

	it('writes the email for a sold-out alert with the dishes and what ran out', () => {
		const off = describeInventoryAlert({
			kind: 'inventory_sold_out',
			count: 3,
			locationName: 'Olaya',
			dishes: ['Burger', 'Wrap', 'Extra chicken'],
			ingredients: ['Chicken', 'Chicken'],
		})
		expect(off.subject).toBe(
			'Burger, Wrap and Extra chicken are off the menu at Olaya',
		)
		expect(off.detail).toContain('Chicken ran out at Olaya')
		expect(off.detail).toContain('undo')
		const back = describeInventoryAlert({
			kind: 'inventory_sold_out_back',
			count: 1,
			locationName: null,
			dishes: ['Burger'],
			ingredients: ['Chicken'],
		})
		expect(back.subject).toBe('Burger is back on the menu')
		expect(inventoryAlertPath('inventory_sold_out')).toBe(
			'/inventory/today#sold-out',
		)
		expect(inventoryAlertWorkflow('inventory_sold_out_back')).toBe(
			'inventory.sold_out',
		)
	})

	it('includes optional overdueCount on inventory_delivery_due alerts (#501)', () => {
		const singleOverdue = describeInventoryAlert({
			kind: 'inventory_delivery_due',
			count: 1,
			overdueCount: 1,
			locationName: 'Downtown',
		})
		expect(singleOverdue.headline).toBe('An order is overdue for delivery')
		expect(singleOverdue.detail).toContain('1 overdue')

		const mixed = describeInventoryAlert({
			kind: 'inventory_delivery_due',
			count: 3,
			overdueCount: 2,
			locationName: null,
		})
		expect(mixed.headline).toBe('3 orders are due for delivery (2 overdue)')
	})
})
