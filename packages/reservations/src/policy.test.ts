import { describe, expect, it } from 'vitest'
import {
	cancellationTerms,
	currencyMinimum,
	noShowFee,
	platformFeeMinor,
	proportionalFeeRefund,
	refundAmount,
	selectPolicy,
	snapshotPolicy,
	type ReservationPolicyRuleInput,
} from './policy.ts'

describe('policy selection, snapshot, cancellation terms, no-show fees, refunds, and platform fee math', () => {
	const rules: ReservationPolicyRuleInput[] = [
		{
			id: 'pol_default',
			name: 'Standard Free',
			mode: 'none',
			amountMinor: 0,
			perCover: false,
			currency: 'USD',
			minParty: 1,
			serviceId: null,
			daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
			windowStartMin: null,
			windowEndMin: null,
			cancelCutoffMin: 120,
			noShowFeeMinor: 0,
			priority: 0,
			active: true,
		},
		{
			id: 'pol_fri_sat_large',
			name: 'Weekend Large Party Deposit',
			mode: 'deposit',
			amountMinor: 2500, // $25.00 per cover
			perCover: true,
			currency: 'USD',
			minParty: 6,
			serviceId: 'srv_dinner',
			daysOfWeek: [5, 6],
			windowStartMin: 18 * 60,
			windowEndMin: 22 * 60,
			cancelCutoffMin: 24 * 60, // 24h cutoff
			noShowFeeMinor: 2500,
			priority: 10,
			active: true,
		},
	]

	it('selects the highest-priority matching policy rule and snapshots immutable terms', () => {
		const matched = selectPolicy(rules, {
			serviceId: 'srv_dinner',
			dayOfWeek: 6, // Saturday
			slotMin: 19 * 60,
			partySize: 6,
		})
		expect(matched?.id).toBe('pol_fri_sat_large')

		const snap = snapshotPolicy(matched!, 6)
		expect(snap).toEqual({
			policyId: 'pol_fri_sat_large',
			name: 'Weekend Large Party Deposit',
			mode: 'deposit',
			amountMinor: 2500,
			perCover: true,
			partySize: 6,
			totalAmountMinor: 15_000, // 6 * 2500 = $150.00
			currency: 'USD',
			cancelCutoffMin: 1440,
			noShowFeeMinor: 15_000,
		})

		// Small party on Tuesday falls back to pol_default
		const fallback = selectPolicy(rules, {
			serviceId: 'srv_dinner',
			dayOfWeek: 2,
			slotMin: 19 * 60,
			partySize: 2,
		})
		expect(fallback?.id).toBe('pol_default')
	})

	it('computes cancellationTerms, refundAmount, and noShowFee before and after cutoff', () => {
		const snap = snapshotPolicy(rules[1]!, 6) // totalAmountMinor = 15_000, cancelCutoffMin = 1440 (24h)
		const startAtMs = Date.parse('2026-06-13T23:00:00.000Z')
		const beforeCutoffMs = startAtMs - 30 * 3600_000 // 30h before
		const afterCutoffMs = startAtMs - 6 * 3600_000 // 6h before

		const termsEarly = cancellationTerms({
			snapshot: snap,
			startAtMs,
			nowMs: beforeCutoffMs,
		})
		expect(termsEarly.withinFreeWindow).toBe(true)
		expect(termsEarly.refundableMinor).toBe(15_000)
		expect(termsEarly.forfeitedMinor).toBe(0)

		const termsLate = cancellationTerms({
			snapshot: snap,
			startAtMs,
			nowMs: afterCutoffMs,
		})
		expect(termsLate.withinFreeWindow).toBe(false)
		expect(termsLate.refundableMinor).toBe(0)
		expect(termsLate.forfeitedMinor).toBe(15_000)

		expect(
			refundAmount({
				snapshot: snap,
				capturedMinor: 15_000,
				startAtMs,
				nowMs: beforeCutoffMs,
			}),
		).toBe(15_000)
		expect(
			refundAmount({
				snapshot: snap,
				capturedMinor: 15_000,
				startAtMs,
				nowMs: afterCutoffMs,
			}),
		).toBe(0)
		expect(
			refundAmount({
				snapshot: snap,
				capturedMinor: 15_000,
				startAtMs,
				nowMs: afterCutoffMs,
				overrideFullRefund: true,
			}),
		).toBe(15_000)

		// Card hold no-show fee vs deposit retention
		const holdSnap = snapshotPolicy(
			{
				...rules[1]!,
				mode: 'card_hold',
			},
			4,
		)
		expect(noShowFee({ snapshot: holdSnap, capturedMinor: 0 })).toEqual({
			amountToChargeMinor: 10_000,
			amountRetainedMinor: 0,
		})
		expect(noShowFee({ snapshot: snap, capturedMinor: 15_000 })).toEqual({
			amountToChargeMinor: 0,
			amountRetainedMinor: 15_000,
		})
	})

	it('computes platformFeeMinor, proportionalFeeRefund, and currencyMinimum (VAL-PAY-051)', () => {
		// floor(gross * bp / 10_000)
		expect(platformFeeMinor(10_000, 250)).toBe(250) // 2.5% of $100.00 = $2.50
		expect(platformFeeMinor(999, 250)).toBe(24) // floor(24.975) = 24
		expect(platformFeeMinor(10_000, 0)).toBe(0)

		// Proportional fee refund on partial and full refunds
		expect(proportionalFeeRefund(250, 10_000, 10_000)).toBe(250)
		expect(proportionalFeeRefund(250, 5_000, 10_000)).toBe(125)
		expect(proportionalFeeRefund(250, 0, 10_000)).toBe(0)

		// Currency minimums
		expect(currencyMinimum('USD')).toBe(50)
		expect(currencyMinimum('SAR')).toBe(200)
		expect(currencyMinimum('GBP')).toBe(30)
		expect(currencyMinimum('EUR')).toBe(50)
	})
})
