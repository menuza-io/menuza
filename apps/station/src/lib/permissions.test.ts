import { describe, expect, it } from 'vitest'
import { KITCHEN_TERMINAL_PERMISSIONS } from '@repo/common/pos-roles'
import { tillCan } from './permissions.ts'

describe('Station can() (#230)', () => {
	it('a custom role without Refund cannot refund without a manager PIN', () => {
		expect(
			tillCan({
				signInRequired: true,
				session: {
					role: 'cashier',
					permissions: ['take_orders', 'take_payment', 'view_orders'],
				},
				terminalAllow: null,
				permission: 'refund',
			}),
		).toBe(false)
		expect(
			tillCan({
				signInRequired: true,
				session: { role: 'manager', permissions: ['refund', 'view_refunds'] },
				terminalAllow: null,
				permission: 'refund',
			}),
		).toBe(true)
	})

	it('a kitchen terminal cannot take payment', () => {
		expect(
			tillCan({
				signInRequired: false,
				session: { role: 'manager' },
				terminalAllow: KITCHEN_TERMINAL_PERMISSIONS,
				permission: 'take_payment',
			}),
		).toBe(false)
		expect(
			tillCan({
				signInRequired: false,
				session: null,
				terminalAllow: KITCHEN_TERMINAL_PERMISSIONS,
				permission: 'kitchen_screen',
			}),
		).toBe(true)
	})
})
