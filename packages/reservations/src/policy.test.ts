import { describe, expect, it } from 'vitest'
import {
	cancellationTerms,
	currencyMinimum,
	noShowFee,
	platformFeeMinor,
	policyTotalMinor,
	proportionalFeeRefund,
	refundOnCancel,
	resolveFeeAmount,
	selectPolicy,
	snapshotPolicy,
	type PolicyInput,
} from './policy.ts'

const base: PolicyInput = {
	id: 'pol_1',
	name: 'Deposit',
	kind: 'deposit',
	amountMinor: 2500,
	perCover: true,
	currency: 'usd',
	freeCancelUntilMin: 1440,
	lateCancelFeeMinor: 5000,
	noShowFeeMinor: 2500,
	feePerCover: true,
	feeCapMinor: 10_000,
	refundRule: 'full_before_window',
	partialRefundBp: null,
	appliesPartyMin: null,
	termsVersion: 2,
}

const START = Date.UTC(2030, 0, 10, 19, 0)
const HOUR = 3_600_000

describe('policy selection and snapshot', () => {
	it('prefers experience, then service, then the location default', () => {
		const exp = { ...base, id: 'e' }
		const svc = { ...base, id: 's' }
		const loc = { ...base, id: 'l' }
		expect(
			selectPolicy({ experience: exp, service: svc, location: loc }, 2)?.id,
		).toBe('e')
		expect(selectPolicy({ service: svc, location: loc }, 2)?.id).toBe('s')
		expect(selectPolicy({ location: loc }, 2)?.id).toBe('l')
		expect(selectPolicy({}, 2)).toBeNull()
	})

	it('skips none, archived and below applies_party_min policies', () => {
		const small = { ...base, id: 'small', appliesPartyMin: 6 }
		const loc = { ...base, id: 'loc' }
		expect(selectPolicy({ service: small, location: loc }, 4)?.id).toBe('loc')
		expect(selectPolicy({ service: small, location: loc }, 6)?.id).toBe('small')
		expect(selectPolicy({ location: { ...base, kind: 'none' } }, 4)).toBeNull()
		expect(selectPolicy({ location: { ...base, archivedAt: 5 } }, 4)).toBeNull()
	})

	it('snapshots amounts for the party, per cover or flat; guarantees charge nothing', () => {
		expect(snapshotPolicy(base, 4).totalAmountMinor).toBe(10_000)
		expect(snapshotPolicy(base, 4).currency).toBe('USD')
		expect(snapshotPolicy(base, 4).cancelCutoffMin).toBe(1440)
		expect(policyTotalMinor({ ...base, perCover: false }, 4)).toBe(2500)
		expect(policyTotalMinor({ ...base, kind: 'card_guarantee' }, 4)).toBe(0)
	})
})

describe('cancellation terms and refunds', () => {
	const snap = snapshotPolicy(base, 4)

	it('is free up to the deadline and late after it', () => {
		const deadline = START - 1440 * 60_000
		expect(
			cancellationTerms({ snapshot: snap, startAtMs: START, nowMs: deadline })
				.free,
		).toBe(true)
		const late = cancellationTerms({
			snapshot: snap,
			startAtMs: START,
			nowMs: deadline + 1,
			paidMinor: 10_000,
		})
		expect(late).toMatchObject({
			free: false,
			lateCancel: true,
			feeMinor: 5000 * 4 > 10_000 ? 10_000 : 20_000,
			refundMinor: 0,
		})
	})

	it('refunds the full payment when free, per rule when late', () => {
		const free = cancellationTerms({
			snapshot: snap,
			startAtMs: START,
			nowMs: START - 48 * HOUR,
			paidMinor: 10_000,
		})
		expect(free.refundMinor).toBe(10_000)
		const partial = snapshotPolicy(
			{ ...base, refundRule: 'partial', partialRefundBp: 5000 },
			4,
		)
		expect(
			cancellationTerms({
				snapshot: partial,
				startAtMs: START,
				nowMs: START - HOUR,
				paidMinor: 10_000,
			}).refundMinor,
		).toBe(5000)
		const none = snapshotPolicy({ ...base, refundRule: 'none' }, 4)
		expect(
			cancellationTerms({
				snapshot: none,
				startAtMs: START,
				nowMs: START - HOUR,
				paidMinor: 10_000,
			}).refundMinor,
		).toBe(0)
	})

	it('a restaurant cancellation always refunds in full', () => {
		const none = snapshotPolicy({ ...base, refundRule: 'none' }, 4)
		expect(
			refundOnCancel({
				snapshot: none,
				startAtMs: START,
				nowMs: START - HOUR,
				paidMinor: 10_000,
				cancelledBy: 'restaurant',
			}),
		).toBe(10_000)
		expect(
			refundOnCancel({
				snapshot: none,
				startAtMs: START,
				nowMs: START - HOUR,
				paidMinor: 10_000,
				cancelledBy: 'guest',
			}),
		).toBe(0)
	})
})

describe('fees', () => {
	it('no-show fee is per cover or flat, clamped to the cap', () => {
		expect(noShowFee(snapshotPolicy(base, 2))).toBe(5000)
		expect(noShowFee(snapshotPolicy(base, 4))).toBe(10_000)
		expect(noShowFee(snapshotPolicy(base, 8))).toBe(10_000)
		expect(noShowFee(snapshotPolicy({ ...base, feePerCover: false }, 8))).toBe(
			2500,
		)
		expect(noShowFee(snapshotPolicy({ ...base, feeCapMinor: null }, 8))).toBe(
			20_000,
		)
	})

	it('an operator amount may only lower the fee, never below the minimum', () => {
		const snap = snapshotPolicy(base, 4)
		const args = { snapshot: snap, kind: 'no_show_fee' as const }
		expect(resolveFeeAmount(args)).toEqual({ ok: true, amountMinor: 10_000 })
		expect(resolveFeeAmount({ ...args, requestedMinor: 8000 })).toEqual({
			ok: true,
			amountMinor: 8000,
		})
		expect(resolveFeeAmount({ ...args, requestedMinor: 10_001 })).toMatchObject(
			{ ok: false, code: 'fee_not_allowed', reason: 'above_policy_fee' },
		)
		expect(resolveFeeAmount({ ...args, requestedMinor: 49 })).toMatchObject({
			ok: false,
			code: 'fee_not_allowed',
			reason: 'below_minimum',
		})
		expect(resolveFeeAmount({ ...args, requestedMinor: 1.5 })).toMatchObject({
			ok: false,
			code: 'invalid',
		})
		expect(
			resolveFeeAmount({
				snapshot: snapshotPolicy({ ...base, noShowFeeMinor: 0 }, 4),
				kind: 'no_show_fee',
			}),
		).toMatchObject({ ok: false, code: 'fee_not_allowed' })
	})

	it('late-cancel fee uses the late-cancel amount', () => {
		const snap = snapshotPolicy({ ...base, feePerCover: false }, 4)
		expect(
			resolveFeeAmount({ snapshot: snap, kind: 'late_cancel_fee' }),
		).toEqual({ ok: true, amountMinor: 5000 })
	})

	it('currency minimums: 50 for USD and CAD, 200 for SAR', () => {
		expect(currencyMinimum('USD')).toBe(50)
		expect(currencyMinimum('cad')).toBe(50)
		expect(currencyMinimum('SAR')).toBe(200)
		expect(currencyMinimum('XXX')).toBe(50)
	})
})

describe('platform fee math (floor, snapshot, proportional reversal)', () => {
	it('floors the fee in basis points', () => {
		expect(platformFeeMinor(10_000, 250)).toBe(250)
		expect(platformFeeMinor(3333, 150)).toBe(49) // floor(49.995)
		expect(platformFeeMinor(999, 250)).toBe(24)
		expect(platformFeeMinor(10_000, 0)).toBe(0)
		expect(platformFeeMinor(0, 500)).toBe(0)
		expect(platformFeeMinor(10_000, 10_000)).toBe(10_000)
		expect(platformFeeMinor(10_000, 20_000)).toBe(10_000)
	})

	it('rounds each reversal on the cumulative share so the parts sum to the snapshot', () => {
		const gross = 3333
		const fee = platformFeeMinor(gross, 1000)
		expect(fee).toBe(333)
		const first = proportionalFeeRefund(fee, 1667, gross, 0, 0)
		expect(first).toBe(167) // round(166.55)
		const second = proportionalFeeRefund(fee, 1666, gross, 1667, first)
		expect(second).toBe(166)
		expect(first + second).toBe(fee)
	})

	it('a full refund reverses the whole fee and zero amounts reverse nothing', () => {
		expect(proportionalFeeRefund(250, 10_000, 10_000)).toBe(250)
		expect(proportionalFeeRefund(250, 5000, 10_000)).toBe(125)
		expect(proportionalFeeRefund(250, 0, 10_000)).toBe(0)
		expect(proportionalFeeRefund(0, 5000, 10_000)).toBe(0)
	})

	it('three uneven partial refunds always sum to the fee', () => {
		const gross = 10_000
		const fee = 1001
		let refunded = 0
		let reversed = 0
		for (const part of [3333, 3333, 3334]) {
			const r = proportionalFeeRefund(fee, part, gross, refunded, reversed)
			refunded += part
			reversed += r
		}
		expect(reversed).toBe(fee)
	})
})
