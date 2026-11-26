import { describe, expect, it } from 'vitest'

import {
	BUILTIN_CASHIER_ROLE_ID,
	CASHIER_PERMISSIONS,
	KITCHEN_TERMINAL_PERMISSIONS,
	MANAGER_PERMISSIONS,
	ROLE_REVIEW_REASON,
	actionsOnSale,
	effectivePermissions,
	hasPermission,
	normalizeRolePermissions,
	refusedSaleAction,
} from './pos-roles.ts'

describe('till roles (#230)', () => {
	it('a custom role without Refund cannot refund without a manager', () => {
		const custom = normalizeRolePermissions([
			'take_orders',
			'take_payment',
			'remove_items',
		])
		expect(custom).toContain('view_orders')
		expect(custom).not.toContain('refund')
		expect(
			refusedSaleAction({
				order: {
					status: 'paid',
					payments: [{}],
					refunds: [{ approvedBy: null }],
					staff: { id: 'server' },
				},
				signInRequired: true,
				staffPermissions: custom,
				approverPermissions: new Map(),
				terminalAllow: null,
			}),
		).toBe('refund')
		expect(
			refusedSaleAction({
				order: {
					status: 'paid',
					payments: [{}],
					refunds: [{ approvedBy: { id: 'mgr' } }],
					staff: { id: 'server' },
				},
				signInRequired: true,
				staffPermissions: custom,
				approverPermissions: new Map([['mgr', MANAGER_PERMISSIONS]]),
				terminalAllow: null,
			}),
		).toBeNull()
	})

	it('a kitchen terminal cannot take payment, even for a manager', () => {
		const allowed = effectivePermissions({
			rolePermissions: MANAGER_PERMISSIONS,
			terminalAllow: KITCHEN_TERMINAL_PERMISSIONS,
		})
		expect(allowed).toContain('kitchen_screen')
		expect(allowed).not.toContain('take_payment')
		expect(
			refusedSaleAction({
				order: { status: 'paid', payments: [{}], staff: { id: 'mgr' } },
				signInRequired: true,
				staffPermissions: MANAGER_PERMISSIONS,
				approverPermissions: new Map(),
				terminalAllow: KITCHEN_TERMINAL_PERMISSIONS,
			}),
		).toBe('take_payment')
	})

	it('locks the view partner when manage is on and fails closed to cashier', () => {
		expect(normalizeRolePermissions(['refund', 'not-a-permission'])).toEqual([
			'view_refunds',
			'refund',
		])
		expect(
			effectivePermissions({
				rolePermissions: null,
				legacyRole: 'cashier',
				terminalAllow: null,
			}),
		).toEqual([...CASHIER_PERMISSIONS])
		expect(hasPermission(CASHIER_PERMISSIONS, 'refund')).toBe(false)
		expect(ROLE_REVIEW_REASON).toBe('role_not_permitted')
		expect(BUILTIN_CASHIER_ROLE_ID).toBe('builtin:cashier')
	})

	it('reads actions off an older sale that names no performedActions', () => {
		expect(
			actionsOnSale({
				status: 'void',
				payments: [{}],
				lineVoids: [{}],
				adjustments: [{ kind: 'discount' }],
			}),
		).toEqual([
			'take_payment',
			'void_sale',
			'remove_items',
			'apply_discounts',
		])
	})
})
