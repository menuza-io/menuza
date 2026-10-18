import { describe, expect, it } from 'vitest'
import { type PolicyDto } from '#app/utils/reservations/policies-api.ts'
import {
	emptyPolicyForm,
	minorToInput,
	policyFormToBody,
	policyIssueFields,
	policyToForm,
} from '#app/utils/reservations/policies-view.ts'

const base = { ...emptyPolicyForm('deposit'), name: 'Dinner deposit' }

describe('policyFormToBody', () => {
	it('turns typed money into minor units and hours into minutes', () => {
		const result = policyFormToBody(
			{
				...base,
				amount: '25',
				noShowFee: '40.50',
				lateCancelFee: '10',
				feeCap: '100',
				freeCancelHours: '48',
				terms: { en: '  No refunds after the deadline.  ', ar: '   ' },
			},
			'USD',
		)
		expect(result).toEqual({
			ok: true,
			body: {
				name: 'Dinner deposit',
				kind: 'deposit',
				amountMinor: 2500,
				perCover: true,
				freeCancelUntilMin: 2880,
				lateCancelFeeMinor: 1000,
				noShowFeeMinor: 4050,
				feePerCover: false,
				feeCapMinor: 10000,
				refundRule: 'full_before_window',
				partialRefundBp: null,
				appliesPartyMin: null,
				termsI18n: { en: 'No refunds after the deadline.' },
			},
		})
	})

	it('uses the currency decimals (SAR has 2, JPY none)', () => {
		const sar = policyFormToBody({ ...base, amount: '250.00' }, 'SAR')
		expect(sar.ok && sar.body.amountMinor).toBe(25000)
		const jpy = policyFormToBody({ ...base, amount: '2500' }, 'JPY')
		expect(jpy.ok && jpy.body.amountMinor).toBe(2500)
		expect(policyFormToBody({ ...base, amount: '2500.5' }, 'JPY').ok).toBe(
			false,
		)
	})

	it('requires a name and a positive amount for a deposit or prepayment', () => {
		const result = policyFormToBody({ ...base, name: ' ', amount: '' }, 'USD')
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(Object.keys(result.errors).sort()).toEqual(['amount', 'name'])
		}
		expect(policyFormToBody({ ...base, amount: '0' }, 'USD').ok).toBe(false)
	})

	it('needs a percentage for a partial refund and drops it otherwise', () => {
		const partial = policyFormToBody(
			{
				...base,
				amount: '10',
				refundRule: 'partial',
				partialRefundPercent: '33.5',
			},
			'USD',
		)
		expect(partial.ok && partial.body.partialRefundBp).toBe(3350)
		expect(
			policyFormToBody(
				{
					...base,
					amount: '10',
					refundRule: 'partial',
					partialRefundPercent: '0',
				},
				'USD',
			).ok,
		).toBe(false)
		const full = policyFormToBody(
			{ ...base, amount: '10', partialRefundPercent: '33' },
			'USD',
		)
		expect(full.ok && full.body.partialRefundBp).toBeNull()
	})

	it('a card guarantee has no amount, refund rule or per-guest charge', () => {
		const result = policyFormToBody(
			{
				...base,
				kind: 'card_guarantee',
				amount: 'nonsense',
				perCover: true,
				refundRule: 'none',
				noShowFee: '30',
			},
			'USD',
		)
		expect(result).toMatchObject({
			ok: true,
			body: {
				amountMinor: 0,
				perCover: false,
				refundRule: 'full_before_window',
				noShowFeeMinor: 3000,
			},
		})
	})

	it('a policy of kind none carries no money at all', () => {
		const result = policyFormToBody(
			{
				...base,
				kind: 'none',
				noShowFee: '30',
				lateCancelFee: '5',
				feeCap: '9',
			},
			'USD',
		)
		expect(result).toMatchObject({
			ok: true,
			body: {
				amountMinor: 0,
				noShowFeeMinor: 0,
				lateCancelFeeMinor: 0,
				feeCapMinor: null,
			},
		})
	})

	it('rejects a window outside 0 to 720 hours and a bad party size', () => {
		expect(
			policyFormToBody({ ...base, amount: '5', freeCancelHours: '721' }, 'USD')
				.ok,
		).toBe(false)
		expect(
			policyFormToBody({ ...base, amount: '5', freeCancelHours: '-1' }, 'USD')
				.ok,
		).toBe(false)
		expect(
			policyFormToBody({ ...base, amount: '5', appliesPartyMin: '100' }, 'USD')
				.ok,
		).toBe(false)
		const ok = policyFormToBody(
			{ ...base, amount: '5', freeCancelHours: '1.5', appliesPartyMin: '6' },
			'USD',
		)
		expect(ok.ok && ok.body.freeCancelUntilMin).toBe(90)
		expect(ok.ok && ok.body.appliesPartyMin).toBe(6)
	})
})

describe('policyToForm', () => {
	const policy: PolicyDto = {
		id: 'pol_1',
		locationId: 'loc_1',
		name: 'Chef table',
		kind: 'prepay',
		amountMinor: 7500,
		perCover: true,
		currency: 'USD',
		freeCancelUntilMin: 1440,
		lateCancelFeeMinor: 0,
		noShowFeeMinor: 2500,
		feePerCover: true,
		feeCapMinor: null,
		refundRule: 'partial',
		partialRefundBp: 5000,
		appliesPartyMin: 4,
		termsI18n: { en: 'Terms', ar: 'الشروط' },
		termsVersion: 3,
		archived: false,
		version: 2,
	}

	it('round-trips through the form unchanged', () => {
		const form = policyToForm(policy, 'USD')
		expect(form.amount).toBe('75.00')
		expect(form.freeCancelHours).toBe('24')
		expect(form.partialRefundPercent).toBe('50')
		const back = policyFormToBody(form, 'USD')
		expect(back).toMatchObject({
			ok: true,
			body: {
				amountMinor: 7500,
				freeCancelUntilMin: 1440,
				noShowFeeMinor: 2500,
				partialRefundBp: 5000,
				appliesPartyMin: 4,
				termsI18n: { en: 'Terms', ar: 'الشروط' },
			},
		})
	})

	it('shows empty money as empty text', () => {
		expect(minorToInput(0, 'USD')).toBe('')
		expect(minorToInput(null, 'USD')).toBe('')
		expect(minorToInput(12345, 'USD')).toBe('123.45')
	})
})

describe('policyIssueFields', () => {
	it('maps the region issue paths onto form fields without values', () => {
		expect(
			policyIssueFields({
				body: {
					issues: [
						{ path: 'amountMinor', code: 'required' },
						{ path: 'partialRefundBp', code: 'required' },
						{ path: 'somethingElse', code: 'x' },
					],
				},
			}),
		).toEqual(['amount', 'partialRefundPercent'])
		expect(policyIssueFields(new Error('x'))).toEqual([])
	})
})
