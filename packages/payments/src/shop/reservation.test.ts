import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	buildReservationCustomerIdempotencyKey,
	buildReservationFeeIdempotencyKey,
	buildReservationFeeMetadata,
	buildReservationLateRefundIdempotencyKey,
	buildReservationPaymentMetadata,
	buildReservationRefundIdempotencyKey,
	buildReservationRefundMetadata,
	buildReservationSessionIdempotencyKey,
	parseReservationMetadata,
	parseReservationRefundReference,
	reservationCheckoutReference,
	reservationProductName,
	reservationRefundReference,
	reservationStripeExpiresAt,
	sanitizeStatementDescriptorSuffix,
} from './reservation'
import { buildGuaranteeConsentText } from './reservation-consent'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

describe('reservation metadata (opaque ids only)', () => {
	it('builds exactly the documented key sets', () => {
		expect(
			buildReservationPaymentMetadata({
				orgId: 'org_1',
				reservationId: 'rsv_1',
				purpose: 'deposit',
			}),
		).toEqual({
			type: 'reservation_payment',
			orgId: 'org_1',
			reservationId: 'rsv_1',
			purpose: 'deposit',
		})
		expect(
			buildReservationFeeMetadata({
				orgId: 'org_1',
				reservationId: 'rsv_1',
				feeId: 'fee_1',
			}),
		).toEqual({
			type: 'reservation_fee',
			orgId: 'org_1',
			reservationId: 'rsv_1',
			purpose: 'fee',
			feeId: 'fee_1',
		})
		expect(
			buildReservationRefundMetadata({
				orgId: 'org_1',
				reservationId: 'rsv_1',
				refundRequestId: 'rr_1',
			}),
		).toEqual({
			type: 'reservation_refund',
			orgId: 'org_1',
			reservationId: 'rsv_1',
			refundRequestId: 'rr_1',
		})
		expect(
			buildReservationRefundMetadata({ orgId: 'o', reservationId: 'r' }),
		).toEqual({
			type: 'reservation_refund',
			orgId: 'o',
			reservationId: 'r',
			reason: 'late_payment',
		})
	})

	it('round-trips and rejects malformed or foreign tags', () => {
		const payment = parseReservationMetadata(
			buildReservationPaymentMetadata({
				orgId: 'o',
				reservationId: 'r',
				purpose: 'experience',
			}),
		)
		expect(payment).toMatchObject({
			kind: 'payment',
			purpose: 'experience',
			feeId: null,
		})
		expect(
			parseReservationMetadata(
				buildReservationFeeMetadata({
					orgId: 'o',
					reservationId: 'r',
					feeId: 'f',
				}),
			),
		).toMatchObject({ kind: 'fee', purpose: 'fee', feeId: 'f' })
		expect(
			parseReservationMetadata({ type: 'restaurant_order', orgId: 'o' }),
		).toBeNull()
		// A fee tag needs a fee id; a payment tag cannot claim the fee purpose.
		expect(
			parseReservationMetadata({
				type: 'reservation_fee',
				orgId: 'o',
				reservationId: 'r',
				purpose: 'fee',
			}),
		).toBeNull()
		expect(
			parseReservationMetadata({
				type: 'reservation_payment',
				orgId: 'o',
				reservationId: 'r',
				purpose: 'fee',
			}),
		).toBeNull()
		expect(
			parseReservationMetadata({
				type: 'reservation_payment',
				orgId: 'o',
				reservationId: 'r',
				purpose: 'bogus',
			}),
		).toBeNull()
	})

	it('product names are fixed and generic', () => {
		expect(reservationProductName({ purpose: 'deposit' })).toBe(
			'Reservation deposit',
		)
		expect(reservationProductName({ purpose: 'prepay' })).toBe(
			'Reservation prepayment',
		)
		expect(reservationProductName({ purpose: 'guarantee' })).toBe(
			'Card guarantee',
		)
		expect(reservationProductName({ purpose: 'experience' })).toBe(
			'Experience ticket',
		)
		expect(
			reservationProductName({
				purpose: 'experience',
				productLabel: 'Chef tasting menu',
			}),
		).toBe('Chef tasting menu')
		// A label is honoured for experiences only.
		expect(
			reservationProductName({ purpose: 'deposit', productLabel: 'Alice' }),
		).toBe('Reservation deposit')
		expect(
			reservationProductName({ purpose: 'fee', feeKind: 'no_show_fee' }),
		).toBe('No-show fee')
		expect(
			reservationProductName({ purpose: 'fee', feeKind: 'late_cancel_fee' }),
		).toBe('Late cancellation fee')
	})
})

describe('idempotency keys', () => {
	it('session key hashes exactly the quote facts', () => {
		const key = buildReservationSessionIdempotencyKey({
			orgId: 'org_1',
			reservationId: 'rsv_1',
			purpose: 'deposit',
			amountMinor: 5000,
			currency: 'usd',
			paymentExpiresAt: '2026-10-08T12:20:00.000Z',
		})
		const digest = sha(
			'org_1|rsv_1|deposit|5000|USD|2026-10-08T12:20:00.000Z',
		).slice(0, 40)
		expect(key).toBe(`reservation_deposit_${digest}`)
		// Every changing fact changes the key (Stripe rejects reuse with new params).
		const base = {
			orgId: 'org_1',
			reservationId: 'rsv_1',
			purpose: 'deposit' as const,
			amountMinor: 5000,
			currency: 'USD',
			paymentExpiresAt: '2026-10-08T12:20:00.000Z',
		}
		for (const change of [
			{ amountMinor: 5001 },
			{ currency: 'CAD' },
			{ paymentExpiresAt: '2026-10-08T12:40:00.000Z' },
			{ reservationId: 'rsv_2' },
			{ orgId: 'org_2' },
		]) {
			expect(
				buildReservationSessionIdempotencyKey({ ...base, ...change }),
			).not.toBe(key)
		}
	})

	it('customer, fee and refund keys follow the contract', () => {
		expect(
			buildReservationCustomerIdempotencyKey({
				orgId: 'org_1',
				guestRef: 'g_ref_12345',
			}),
		).toBe(`reservation_customer_${sha('org_1|g_ref_12345')}`)
		expect(
			buildReservationFeeIdempotencyKey({
				orgId: 'org_1',
				reservationId: 'rsv_1',
				feeId: 'fee_1',
				attempt: 2,
			}),
		).toBe(`reservation_fee_${sha('org_1|rsv_1|fee_1|2')}`)
		expect(
			buildReservationRefundIdempotencyKey({
				orgId: 'org_1',
				refundRequestId: 'rr_1',
			}),
		).toBe(`reservation_refund_${sha('org_1|rr_1')}`)
		expect(buildReservationLateRefundIdempotencyKey('pi_123')).toBe(
			'reservation_late_refund_pi_123',
		)
	})

	it('a payment token can never be part of a key (no key builder accepts one)', () => {
		const secret = 'tok_super_secret_value'
		const keys = [
			buildReservationSessionIdempotencyKey({
				orgId: 'o',
				reservationId: 'r',
				purpose: 'deposit',
				amountMinor: 1,
				currency: 'USD',
				paymentExpiresAt: 'x',
			}),
			buildReservationFeeIdempotencyKey({
				orgId: 'o',
				reservationId: 'r',
				feeId: 'f',
				attempt: 1,
			}),
		]
		for (const key of keys) expect(key).not.toContain(secret)
		// The builders take object arguments with no token field, so a token
		// cannot be passed in by mistake (checked at compile time).
		expect(keys).toHaveLength(2)
	})
})

describe('Checkout.com references', () => {
	it('is deterministic, at most 50 characters and recomputable from ids', () => {
		const input = {
			orgId: 'org_01HZZZZZZZZZZZZZZZZZZZZZZZ',
			reservationId: 'rsv_01HZZZZZZZZZZZZZZZZZZZZZZZ',
			purpose: 'experience' as const,
		}
		const reference = reservationCheckoutReference(input)
		expect(reference).toBe(reservationCheckoutReference(input))
		expect(reference.length).toBeLessThanOrEqual(50)
		expect(reference).toMatch(/^rsv_experience_[0-9a-f]{32}$/)
		expect(
			reservationCheckoutReference({
				...input,
				purpose: 'fee',
				feeId: 'fee_1',
			}),
		).not.toBe(
			reservationCheckoutReference({
				...input,
				purpose: 'fee',
				feeId: 'fee_2',
			}),
		)
	})

	it('refund references carry the opaque request id', () => {
		const reference = reservationRefundReference({
			refundRequestId: 'rr_abc',
			paymentRef: 'pay_1',
		})
		expect(reference).toBe('rsv_refund_rr_abc')
		expect(parseReservationRefundReference(reference)).toEqual({
			refundRequestId: 'rr_abc',
			late: false,
		})
		const late = reservationRefundReference({ paymentRef: 'pay_9' })
		expect(parseReservationRefundReference(late)).toEqual({
			refundRequestId: null,
			late: true,
		})
		expect(parseReservationRefundReference('order:1')).toBeNull()
		expect(parseReservationRefundReference(null)).toBeNull()
	})
})

describe('provider presentation', () => {
	it('sanitizes the statement descriptor suffix', () => {
		expect(sanitizeStatementDescriptorSuffix("Joe's Café & Grill #1")).toBe(
			'JOES CAFE GRILL 1',
		)
		expect(
			sanitizeStatementDescriptorSuffix(
				'A very long restaurant name that overflows',
			)?.length,
		).toBeLessThanOrEqual(22)
		expect(sanitizeStatementDescriptorSuffix('12345')).toBeNull()
		expect(sanitizeStatementDescriptorSuffix('مطعم')).toBeNull()
		expect(sanitizeStatementDescriptorSuffix(null)).toBeNull()
	})

	it('Stripe expiry is max(now + 31 min, hold) and below 24 hours', () => {
		const now = Date.parse('2026-10-08T12:00:00.000Z')
		expect(reservationStripeExpiresAt(now, '2026-10-08T12:10:00.000Z')).toBe(
			Math.floor((now + 31 * 60_000) / 1000),
		)
		expect(reservationStripeExpiresAt(now, '2026-10-08T13:00:00.000Z')).toBe(
			Math.floor(Date.parse('2026-10-08T13:00:00.000Z') / 1000),
		)
		expect(
			reservationStripeExpiresAt(now, '2026-10-12T13:00:00.000Z'),
		).toBeLessThan(Math.floor((now + 24 * 3600_000) / 1000))
		expect(reservationStripeExpiresAt(now, 'garbage')).toBe(
			Math.floor((now + 31 * 60_000) / 1000),
		)
	})
})

describe('guarantee consent text', () => {
	const facts = {
		currency: 'USD',
		capMinor: 5000,
		noShowFeeMinor: 2500,
		lateCancelFeeMinor: 1500,
		freeCancelUntilMin: 24 * 60,
		timeZone: 'America/New_York',
		startAtIso: '2026-10-20T23:00:00.000Z',
	}

	it('states amounts, window and time zone in English', () => {
		const text = buildGuaranteeConsentText(facts, 'en')
		expect(text).toContain('$25.00')
		expect(text).toContain('$15.00')
		expect(text).toContain('$50.00')
		expect(text).toContain('24 hours')
		expect(text).toContain('America/New_York')
		expect(text.length).toBeLessThanOrEqual(1200)
	})

	it('speaks Arabic for ar locales and falls back to English otherwise', () => {
		const ar = buildGuaranteeConsentText(
			{ ...facts, currency: 'SAR', timeZone: 'Asia/Riyadh' },
			'ar',
		)
		expect(ar).toMatch(/[؀-ۿ]/)
		expect(ar).toContain('Asia/Riyadh')
		expect(buildGuaranteeConsentText(facts, 'fr')).toContain('By saving')
	})

	it('omits a trigger whose fee is zero and never exceeds the limit', () => {
		const text = buildGuaranteeConsentText(
			{ ...facts, lateCancelFeeMinor: 0 },
			'en',
		)
		expect(text).not.toContain('cancel less than')
		expect(text).toContain('do not show up')
		expect(
			buildGuaranteeConsentText({ ...facts, timeZone: 'x'.repeat(5000) }, 'en')
				.length,
		).toBeLessThanOrEqual(1200)
	})
})
