import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	features: vi.fn(),
	grants: vi.fn(),
}))

vi.mock('./access.server.ts', () => ({
	getInventoryFeatureState: mocks.features,
	getUserInventoryGrants: mocks.grants,
}))

const {
	countVisibleInventoryAlerts,
	filterVisibleInventoryNotifications,
	inventoryAlertSettingsVisible,
	inventoryAlertVisibleOrgIds,
	isInventoryNotificationType,
} = await import('./notification-visibility.server.ts')

const note = (id: string, type: string, organizationId: string) => ({
	id,
	type,
	organizationId,
})

const ON = {
	enabled: true,
	purchasing: true,
	recipes: false,
	prep: false,
	transfers: false,
}

beforeEach(() => {
	mocks.features.mockReset().mockResolvedValue(ON)
	mocks.grants.mockReset().mockResolvedValue(['read:inventory:any'])
})

describe('inventory notification visibility', () => {
	it('recognises only inventory types', () => {
		expect(isInventoryNotificationType('inventory-low-stock')).toBe(true)
		expect(isInventoryNotificationType('reservations-payment-failed')).toBe(
			false,
		)
	})

	it('shows alerts while the module is on and the member reads inventory', async () => {
		const list = [
			note('1', 'inventory-low-stock', 'o1'),
			note('2', 'mention', 'o1'),
		]
		expect(await filterVisibleInventoryNotifications('u', list)).toEqual(list)
	})

	it('hides alerts, and only alerts, when the module is off', async () => {
		mocks.features.mockResolvedValue({ ...ON, enabled: false })
		const out = await filterVisibleInventoryNotifications('u', [
			note('1', 'inventory-count-review', 'o1'),
			note('2', 'mention', 'o1'),
		])
		expect(out.map((n) => n.id)).toEqual(['2'])
	})

	it('hides order and price alerts, but not stock alerts, when Purchasing is off', async () => {
		mocks.features.mockResolvedValue({ ...ON, purchasing: false })
		mocks.grants.mockResolvedValue([
			'read:inventory:any',
			'read:inventory_cost:any',
		])
		const out = await filterVisibleInventoryNotifications('u', [
			note('1', 'inventory-low-stock', 'o1'),
			note('2', 'inventory-delivery-due', 'o1'),
			note('3', 'inventory-price-rise', 'o1'),
		])
		expect(out.map((n) => n.id)).toEqual(['1'])
	})

	it('hides alerts after the member loses every inventory grant', async () => {
		mocks.grants.mockResolvedValue([])
		expect(
			await filterVisibleInventoryNotifications('u', [
				note('1', 'inventory-low-stock', 'o1'),
			]),
		).toEqual([])
	})

	it('hides a price rise from a member without the cost grant', async () => {
		const out = await filterVisibleInventoryNotifications('u', [
			note('1', 'inventory-price-rise', 'o1'),
			note('2', 'inventory-low-stock', 'o1'),
		])
		expect(out.map((n) => n.id)).toEqual(['2'])
		mocks.grants.mockResolvedValue(['read:inventory_cost:any'])
		expect(
			(
				await filterVisibleInventoryNotifications('u', [
					note('1', 'inventory-price-rise', 'o1'),
				])
			).map((n) => n.id),
		).toEqual(['1'])
	})

	it('hides the email-only marker even for a member who may see alerts', async () => {
		expect(
			await filterVisibleInventoryNotifications('u', [
				note('1', 'inventory-email-sent', 'o1'),
				note('2', 'inventory-count-review', 'o1'),
			]),
		).toEqual([note('2', 'inventory-count-review', 'o1')])
	})

	it('hides rather than shows when access cannot be determined', async () => {
		mocks.features.mockRejectedValue(new Error('down'))
		expect(await inventoryAlertVisibleOrgIds('u', ['o1'])).toEqual(new Set())
	})

	it('counts only the alerts of organizations the member can still open', async () => {
		mocks.features.mockImplementation(async (org: string) => ({
			...ON,
			enabled: org === 'o1',
		}))
		expect(
			await countVisibleInventoryAlerts('u', [
				note('1', 'inventory-low-stock', 'o1'),
				note('2', 'inventory-low-stock', 'o1'),
				note('3', 'inventory-low-stock', 'o2'),
			]),
		).toBe(2)
		expect(await countVisibleInventoryAlerts('u', [])).toBe(0)
	})

	it('offers price alerts in settings only with the cost grant', async () => {
		expect(await inventoryAlertSettingsVisible('u', 'o1')).toEqual({
			any: true,
			priceRise: false,
		})
		mocks.grants.mockResolvedValue(['read:inventory_cost:any'])
		expect(await inventoryAlertSettingsVisible('u', 'o1')).toEqual({
			any: true,
			priceRise: true,
		})
	})
})
