import { describe, expect, it } from 'vitest'
import { parseOrderPolicyFields } from './order-policy-settings.ts'

const BOTH = { guestCancel: true, acceptance: true }

describe('parseOrderPolicyFields', () => {
	it('reads Arabic-Indic digits and the Arabic decimal mark', () => {
		const result = parseOrderPolicyFields(
			{
				guestCancelMinutes: '5',
				guestCancelScheduledLeadMinutes: '٦٠',
				orderAcceptanceMode: 'manual',
				orderAcceptanceTimeoutMinutes: '10',
				orderAcceptanceMinTotal: '٢٥٫٥٠',
			},
			BOTH,
		)
		expect(result).toEqual({
			ok: true,
			patch: {
				guestCancelMinutes: 5,
				guestCancelScheduledLeadMinutes: 60,
				orderAcceptanceMode: 'manual',
				orderAcceptanceTimeoutMinutes: 10,
				orderAcceptanceMinTotalCents: 2550,
				orderAcceptanceScheduledOnly: false,
			},
		})
	})

	it('reads whole and one-decimal amounts as cents', () => {
		const read = (orderAcceptanceMinTotal: string) => {
			const result = parseOrderPolicyFields(
				{ orderAcceptanceMode: 'manual', orderAcceptanceMinTotal },
				{ guestCancel: false, acceptance: true },
			)
			return result.ok ? result.patch.orderAcceptanceMinTotalCents : 'refused'
		}
		expect(read('25')).toBe(2500)
		expect(read('25.5')).toBe(2550)
		expect(read('1,250.50')).toBe(125050)
		expect(read('')).toBeNull()
		expect(read('0')).toBe(0)
	})

	it.each([
		[
			'minutes',
			{ guestCancelMinutes: '7' },
			{ field: 'guestCancelMinutes', code: 'invalid_choice' },
		],
		[
			'lead too long',
			{ guestCancelMinutes: '5', guestCancelScheduledLeadMinutes: '1441' },
			{ field: 'guestCancelScheduledLeadMinutes', code: 'invalid_minutes' },
		],
		[
			'lead negative',
			{ guestCancelMinutes: '5', guestCancelScheduledLeadMinutes: '-1' },
			{ field: 'guestCancelScheduledLeadMinutes', code: 'invalid_minutes' },
		],
		[
			'lead text',
			{ guestCancelMinutes: '5', guestCancelScheduledLeadMinutes: 'soon' },
			{ field: 'guestCancelScheduledLeadMinutes', code: 'invalid_minutes' },
		],
		[
			'mode',
			{ orderAcceptanceMode: 'sometimes' },
			{ field: 'orderAcceptanceMode', code: 'invalid_choice' },
		],
		[
			'timeout',
			{ orderAcceptanceMode: 'manual', orderAcceptanceTimeoutMinutes: '4' },
			{ field: 'orderAcceptanceTimeoutMinutes', code: 'invalid_choice' },
		],
		[
			'negative amount',
			{ orderAcceptanceMode: 'manual', orderAcceptanceMinTotal: '-3' },
			{ field: 'orderAcceptanceMinTotal', code: 'invalid_amount' },
		],
		[
			'amount text',
			{ orderAcceptanceMode: 'manual', orderAcceptanceMinTotal: 'abc' },
			{ field: 'orderAcceptanceMinTotal', code: 'invalid_amount' },
		],
		[
			'decimal comma',
			{ orderAcceptanceMode: 'manual', orderAcceptanceMinTotal: '4,50' },
			{ field: 'orderAcceptanceMinTotal', code: 'invalid_amount' },
		],
		[
			'too many decimals',
			{ orderAcceptanceMode: 'manual', orderAcceptanceMinTotal: '1.234' },
			{ field: 'orderAcceptanceMinTotal', code: 'invalid_amount' },
		],
	])(
		'names the refused field and code for %s, never the value',
		(_name, fields, expected) => {
			const result = parseOrderPolicyFields(
				{ guestCancelMinutes: '0', orderAcceptanceMode: 'auto', ...fields },
				BOTH,
			)
			expect(result).toMatchObject({ ok: false, ...expected })
			expect(typeof (result as { error: string }).error).toBe('string')
			for (const value of Object.values(fields)) {
				expect((result as { error: string }).error).not.toContain(value)
				expect(JSON.stringify(result)).not.toContain(`"${value}"`)
			}
		},
	)

	it('skips a group whose flag is off', () => {
		const result = parseOrderPolicyFields(
			{ guestCancelMinutes: '7', orderAcceptanceMode: 'sometimes' },
			{ guestCancel: false, acceptance: false },
		)
		expect(result).toEqual({ ok: true, patch: {} })
	})
})
