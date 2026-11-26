import { describe, expect, it } from 'vitest'
import {
	computeOrderAmountDueCents,
	parseOrderPayLinkToken,
	serializeOrderPayLinkToken,
} from './order-pay-links.ts'

describe('order-pay-links', () => {
	const mac = 'a'.repeat(64)

	it('round-trips a valid online or pos capability token', () => {
		const token = serializeOrderPayLinkToken({
			kind: 'o',
			orderId: '123e4567-e89b-12d3-a456-426614174000',
			version: 2,
			expiresAtSec: 1800000000,
			mac,
		})
		expect(parseOrderPayLinkToken(token)).toEqual({
			kind: 'o',
			orderId: '123e4567-e89b-12d3-a456-426614174000',
			version: 2,
			expiresAtSec: 1800000000,
			mac,
		})
		const posToken = serializeOrderPayLinkToken({
			kind: 'p',
			orderId: '123e4567-e89b-12d3-a456-426614174001',
			version: 1,
			expiresAtSec: 1800000000,
			mac,
		})
		expect(parseOrderPayLinkToken(posToken)?.kind).toBe('p')
	})

	it('rejects malformed or tampered tokens', () => {
		expect(parseOrderPayLinkToken('')).toBeNull()
		expect(parseOrderPayLinkToken(`x.12345678.1.1800000000.${mac}`)).toBeNull()
		expect(parseOrderPayLinkToken(`o.12345678.0.1800000000.${mac}`)).toBeNull()
		expect(parseOrderPayLinkToken(`o.12345678.1.1800000000.short`)).toBeNull()
		expect(parseOrderPayLinkToken(`o.short.1.1800000000.${mac}`)).toBeNull()
	})

	it('computes amount due clamped at zero', () => {
		expect(computeOrderAmountDueCents({ totalCents: 2500, paidCents: 0 })).toBe(
			2500,
		)
		expect(
			computeOrderAmountDueCents({ totalCents: 2500, paidCents: 1000 }),
		).toBe(1500)
		expect(
			computeOrderAmountDueCents({
				totalCents: 2500,
				paidCents: 2000,
				giftCardCents: 500,
			}),
		).toBe(0)
		expect(
			computeOrderAmountDueCents({ totalCents: 2500, paidCents: 3000 }),
		).toBe(0)
	})
})
