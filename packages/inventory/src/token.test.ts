import { describe, expect, test } from 'vitest'
import { INVENTORY_FEATURES_OFF } from './flags.ts'
import {
	canApproveInventoryCount,
	expandInventoryGrants,
	INVENTORY_PERMISSIONS as P,
} from './permissions.ts'
import {
	INVENTORY_TOKEN_AUDIENCE,
	inventoryAllowsLocation,
	inventoryScopeGrantsFor,
	inventoryTokenClaimsSchema,
} from './token.ts'

const now = 1_800_000_000
const claims = (over: Record<string, unknown> = {}) => ({
	aud: INVENTORY_TOKEN_AUDIENCE,
	role: 'operator',
	region: 'us',
	orgId: 'org_1',
	sub: 'user_1',
	scope: 'write',
	grants: [P.READ_INVENTORY, P.UPDATE_INVENTORY],
	locationIds: null,
	features: { ...INVENTORY_FEATURES_OFF, enabled: true },
	impersonated: false,
	iat: now,
	exp: now + 15 * 60,
	...over,
})

describe('inventory grants', () => {
	test('updates and cost imply reading stock', () => {
		expect(expandInventoryGrants([P.UPDATE_INVENTORY_RECIPE])).toEqual([
			P.READ_INVENTORY,
			P.UPDATE_INVENTORY_RECIPE,
		])
		expect(expandInventoryGrants([P.READ_INVENTORY_COST])).toEqual([
			P.READ_INVENTORY,
			P.READ_INVENTORY_COST,
		])
		expect(expandInventoryGrants(['read:menu:any'])).toEqual([])
	})

	test('approving a count needs update and cost', () => {
		expect(canApproveInventoryCount([P.UPDATE_INVENTORY])).toBe(false)
		expect(canApproveInventoryCount([P.READ_INVENTORY_COST])).toBe(false)
		expect(
			canApproveInventoryCount([P.UPDATE_INVENTORY, P.READ_INVENTORY_COST]),
		).toBe(true)
	})

	test('scopes limit grants and impersonation drops writes', () => {
		const held = [P.UPDATE_INVENTORY, P.READ_INVENTORY_COST]
		expect(inventoryScopeGrantsFor('read', held)).toEqual([
			P.READ_INVENTORY,
			P.READ_INVENTORY_COST,
		])
		expect(inventoryScopeGrantsFor('write', held)).toEqual([
			P.READ_INVENTORY,
			P.UPDATE_INVENTORY,
			P.READ_INVENTORY_COST,
		])
		expect(inventoryScopeGrantsFor('write', held, true)).toEqual([
			P.READ_INVENTORY,
			P.READ_INVENTORY_COST,
		])
		expect(inventoryScopeGrantsFor('read', ['read:menu:any'])).toEqual([])
	})
})

describe('inventory token claims', () => {
	test('accepts a well formed token', () => {
		expect(inventoryTokenClaimsSchema.safeParse(claims()).success).toBe(true)
	})

	test.each([
		['wrong audience', { aud: 'tenant-api-loyalty-operator' }],
		['too long', { exp: now + 15 * 60 + 1 }],
		['expired before issued', { exp: now }],
		[
			'impersonated too long',
			{ impersonated: true, grants: [P.READ_INVENTORY] },
		],
		['impersonated writes', { impersonated: true, exp: now + 300 }],
		['write grant on a read token', { scope: 'read' }],
		['duplicate grant', { grants: [P.READ_INVENTORY, P.READ_INVENTORY] }],
		['no grants', { grants: [] }],
		['unknown field', { extra: 1 }],
		['bad location id', { locationIds: ['a b'] }],
	])('refuses %s', (_name, over) => {
		expect(inventoryTokenClaimsSchema.safeParse(claims(over)).success).toBe(
			false,
		)
	})

	test('location scoping', () => {
		expect(inventoryAllowsLocation(null, 'loc_1')).toBe(true)
		expect(inventoryAllowsLocation([], 'loc_1')).toBe(false)
		expect(inventoryAllowsLocation(['loc_1'], 'loc_1')).toBe(true)
	})
})
