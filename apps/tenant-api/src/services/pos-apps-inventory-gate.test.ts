import { INVENTORY_FEATURES_OFF } from '@repo/inventory'
import { type PosDevice } from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from '../lib/inventory-context.ts'
import { deviceApps, inventoryGate } from './pos-apps-service.ts'

const ORG = 'org_stock_gate_1'

const device = (patch: Partial<PosDevice> = {}) =>
	({
		inventoryEnabled: true,
		signInRequired: true,
		locationId: 'loc_1',
		timeclockEnabled: false,
		reservationsEnabled: false,
		...patch,
	}) as PosDevice

const on = { ...INVENTORY_FEATURES_OFF, enabled: true }

beforeEach(() => {
	vi.stubEnv('INVENTORY_ENABLED', '')
	vi.stubEnv('APP_URL', '')
	invalidateInventoryContext()
})

afterEach(() => {
	invalidateInventoryContext()
	vi.unstubAllEnvs()
})

describe('inventoryGate (the Stock app on a terminal)', () => {
	it('opens only with the terminal switch, sign-in, a location and the flag', async () => {
		seedInventoryContextForTest(ORG, on)
		expect(await inventoryGate(ORG, device())).toEqual({
			ok: true,
			locationId: 'loc_1',
		})
		expect(
			await inventoryGate(ORG, device({ inventoryEnabled: false })),
		).toEqual({ ok: false, code: 'inventory_not_enabled' })
		expect(await inventoryGate(ORG, device({ signInRequired: false }))).toEqual(
			{
				ok: false,
				code: 'inventory_needs_sign_in',
			},
		)
		expect(await inventoryGate(ORG, device({ locationId: null }))).toEqual({
			ok: false,
			code: 'inventory_needs_location',
		})
	})

	it('reads the organization flag fail-closed', async () => {
		seedInventoryContextForTest(ORG, { ...INVENTORY_FEATURES_OFF })
		expect(await inventoryGate(ORG, device())).toEqual({
			ok: false,
			code: 'inventory_disabled',
		})
		// Nothing cached and App not configured: unknown is never on.
		invalidateInventoryContext(ORG)
		expect(await inventoryGate(ORG, device())).toEqual({
			ok: false,
			code: 'service_unavailable',
		})
		// The node's kill switch is its own answer.
		seedInventoryContextForTest(ORG, on)
		vi.stubEnv('INVENTORY_ENABLED', 'false')
		expect(await inventoryGate(ORG, device())).toEqual({
			ok: false,
			code: 'inventory_unavailable',
		})
	})
})

describe('deviceApps inventory', () => {
	it('says false when it is off for sure and says nothing when it cannot tell', async () => {
		seedInventoryContextForTest(ORG, on)
		expect((await deviceApps(ORG, device())).inventory).toBe(true)
		expect(
			(await deviceApps(ORG, device({ inventoryEnabled: false }))).inventory,
		).toBe(false)
		seedInventoryContextForTest(ORG, { ...INVENTORY_FEATURES_OFF })
		expect((await deviceApps(ORG, device())).inventory).toBe(false)
		invalidateInventoryContext(ORG)
		expect(await deviceApps(ORG, device())).not.toHaveProperty('inventory')
	})
})
