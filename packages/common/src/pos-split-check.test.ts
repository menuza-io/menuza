import { describe, expect, it } from 'vitest'
import { computePosServiceCharge } from './service-fee.ts'
import { splitCheckByItem } from './pos-split-check.ts'

describe('Station service charge and auto-gratuity (#397)', () => {
	const settings = {
		enabled: true,
		label: 'Service charge',
		taxable: true,
		byOrderType: {
			dine_in: { percentBp: 1200, minPartySize: null },
			takeaway: { percentBp: 0, minPartySize: null },
		},
	}

	it('applies 12% dine-in service charge with VAT', () => {
		const res = computePosServiceCharge({
			settings,
			orderType: 'dine_in',
			baseCents: 10000,
			taxRatePercent: 15,
			taxInclusive: false,
		})
		expect(res.applied).toBe(true)
		expect(res.amountCents).toBe(1200)
		expect(res.taxCents).toBe(180)
	})

	it('triggers automatic gratuity only when party size meets threshold (e.g. 6)', () => {
		const autoGratSettings = {
			enabled: true,
			label: 'Auto-gratuity',
			taxable: false,
			byOrderType: {
				dine_in: { percentBp: 1800, minPartySize: 6 },
			},
		}
		const small = computePosServiceCharge({
			settings: autoGratSettings,
			orderType: 'dine_in',
			baseCents: 10000,
			partySize: 4,
			taxRatePercent: 8,
			taxInclusive: false,
		})
		expect(small.applied).toBe(false)
		expect(small.amountCents).toBe(0)

		const large = computePosServiceCharge({
			settings: autoGratSettings,
			orderType: 'dine_in',
			baseCents: 10000,
			partySize: 6,
			taxRatePercent: 8,
			taxInclusive: false,
		})
		expect(large.applied).toBe(true)
		expect(large.autoGratuity).toBe(true)
		expect(large.amountCents).toBe(1800)
		expect(large.taxCents).toBe(0)
	})

	it('never applies twice to a QR tab that already carries a service fee, or when removed', () => {
		const qr = computePosServiceCharge({
			settings,
			orderType: 'dine_in',
			baseCents: 10000,
			taxRatePercent: 15,
			taxInclusive: false,
			alreadyChargedOnQrTab: true,
		})
		expect(qr.applied).toBe(false)
		expect(qr.amountCents).toBe(0)

		const removed = computePosServiceCharge({
			settings,
			orderType: 'dine_in',
			baseCents: 10000,
			taxRatePercent: 15,
			taxInclusive: false,
			removed: true,
		})
		expect(removed.applied).toBe(false)
		expect(removed.amountCents).toBe(0)
	})
})

describe('Station split check by item (#289)', () => {
	it('splits dishes across checks, divides a shared dish with remainder on first check, and sums to exact order total', () => {
		const plan = splitCheckByItem({
			lines: [
				{
					id: 'l1',
					name: 'Steak',
					quantity: 1,
					totalCents: 2500,
					taxableCents: 2500,
				},
				{
					id: 'l2',
					name: 'Pasta',
					quantity: 1,
					totalCents: 1800,
					taxableCents: 1800,
				},
				// Shared appetizer: $10.00 split 3 ways -> 334, 333, 333 (remainder on first check)
				{
					id: 'l3',
					name: 'Nachos',
					quantity: 1,
					totalCents: 1000,
					taxableCents: 1000,
				},
			],
			checks: [
				{
					checkNumber: 1,
					assignments: [
						{ lineId: 'l1', shareNum: 1, shareDen: 1 },
						{ lineId: 'l3', shareNum: 1, shareDen: 3 },
					],
					tipCents: 500,
					loyaltyCustomerId: 'cust-1',
				},
				{
					checkNumber: 2,
					assignments: [
						{ lineId: 'l2', shareNum: 1, shareDen: 1 },
						{ lineId: 'l3', shareNum: 1, shareDen: 3 },
					],
					tipCents: 300,
					loyaltyCustomerId: 'cust-2',
				},
				{
					checkNumber: 3,
					assignments: [{ lineId: 'l3', shareNum: 1, shareDen: 3 }],
					tipCents: 100,
				},
			],
			orderDiscountCents: 500,
			taxRatePercent: 8.25,
			taxInclusive: false,
			serviceChargeCents: 576,
			serviceChargeTaxCents: 48,
		})

		// Shared dish remainder went to first check (334 vs 333 vs 333)
		const c1Nachos = plan.checks[0]!.items.find((i) => i.lineId === 'l3')
		const c2Nachos = plan.checks[1]!.items.find((i) => i.lineId === 'l3')
		const c3Nachos = plan.checks[2]!.items.find((i) => i.lineId === 'l3')
		expect(c1Nachos?.amountCents).toBe(334)
		expect(c2Nachos?.amountCents).toBe(333)
		expect(c3Nachos?.amountCents).toBe(333)

		// Each receipt lists ONLY its own items
		expect(plan.checks[0]!.items.map((i) => i.name)).toEqual([
			'Steak',
			'Nachos',
		])
		expect(plan.checks[1]!.items.map((i) => i.name)).toEqual([
			'Pasta',
			'Nachos',
		])
		expect(plan.checks[2]!.items.map((i) => i.name)).toEqual(['Nachos'])

		// Per-check loyalty preserved
		expect(plan.checks[0]!.loyaltyCustomerId).toBe('cust-1')
		expect(plan.checks[1]!.loyaltyCustomerId).toBe('cust-2')
		expect(plan.checks[2]!.loyaltyCustomerId).toBeNull()

		// Sum of checks ALWAYS equals order total + tips to the exact cent!
		const sumWithoutTips = plan.checks.reduce(
			(s, c) => s + (c.totalCents - c.tipCents),
			0,
		)
		expect(sumWithoutTips).toBe(plan.orderTotalWithoutTipCents)
		expect(plan.grandTotalWithTipsCents).toBe(
			plan.orderTotalWithoutTipCents + 900,
		)
	})
})
