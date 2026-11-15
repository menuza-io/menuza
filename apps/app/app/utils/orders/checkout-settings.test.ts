import { defaultTipSettings } from '@repo/common/location-types'
import { describe, expect, it } from 'vitest'
import {
	emptyFeeForm,
	feeFormFromSettings,
	parseCheckoutSettingsFields,
	serviceFeeFromForm,
	tipFormFromSettings,
	tipSettingsFromForm,
	type FeeFormValues,
	type TipFormValues,
} from './checkout-settings.ts'

const tipForm = (): TipFormValues => tipFormFromSettings(defaultTipSettings('USD'), 'USD')
const feeForm = (patch: Partial<FeeFormValues> = {}): FeeFormValues => ({
	...emptyFeeForm('USD'),
	enabled: true,
	...patch,
})

describe('tip settings form', () => {
	it('round-trips the default settings', () => {
		const result = tipSettingsFromForm(tipForm(), 'USD')
		expect(result).toEqual({ ok: true, settings: defaultTipSettings('USD') })
	})

	it('reads percent and fixed choices, typed with Arabic digits', () => {
		const form = tipForm()
		form.delivery = {
			choices: [
				{ kind: 'percent', value: '١٢' },
				{ kind: 'amount', value: '٢٫٥٠' },
			],
			defaultIndex: '1',
			allowCustom: true,
		}
		const result = tipSettingsFromForm(form, 'USD')
		expect(result.ok && result.settings.delivery).toEqual({
			choices: [{ percent: 12 }, { amountMinor: 250 }],
			defaultIndex: 1,
			allowCustom: true,
		})
	})

	it('allows no preselected tip', () => {
		const form = tipForm()
		form.pickup.defaultIndex = ''
		const result = tipSettingsFromForm(form, 'USD')
		expect(result.ok && result.settings.pickup.defaultIndex).toBeNull()
	})

	it('names the field it refuses, without echoing the value', () => {
		const form = tipForm()
		form.pickup.choices[2] = { kind: 'percent', value: '99' }
		expect(tipSettingsFromForm(form, 'USD')).toEqual({
			ok: false,
			issue: { section: 'tips', field: 'pickup.choice.2', code: 'invalid_percent' },
		})
		const amount = tipForm()
		amount.delivery.choices[0] = { kind: 'amount', value: 'abc' }
		expect(tipSettingsFromForm(amount, 'USD')).toMatchObject({
			ok: false,
			issue: { field: 'delivery.choice.0', code: 'invalid_amount' },
		})
	})

	it('refuses repeats, five choices, a default outside the list and an empty list', () => {
		const repeat = tipForm()
		repeat.qrTab.choices = [
			{ kind: 'percent', value: '10' },
			{ kind: 'percent', value: '10' },
		]
		repeat.qrTab.defaultIndex = ''
		expect(tipSettingsFromForm(repeat, 'USD')).toMatchObject({
			issue: { code: 'duplicate' },
		})
		const five = tipForm()
		five.pickup.choices = ['5', '8', '10', '12', '15'].map((value) => ({
			kind: 'percent' as const,
			value,
		}))
		five.pickup.defaultIndex = ''
		expect(tipSettingsFromForm(five, 'USD')).toMatchObject({
			issue: { code: 'too_large' },
		})
		const outside = tipForm()
		outside.pickup.defaultIndex = '7'
		expect(tipSettingsFromForm(outside, 'USD')).toMatchObject({
			issue: { field: 'pickup.default', code: 'invalid_choice' },
		})
		const empty = tipForm()
		empty.pickup = { choices: [], defaultIndex: '', allowCustom: false }
		expect(tipSettingsFromForm(empty, 'USD')).toMatchObject({
			issue: { code: 'required' },
		})
		empty.pickup.allowCustom = true
		expect(tipSettingsFromForm(empty, 'USD').ok).toBe(true)
	})
})

describe('service fee form', () => {
	it('reads 3 % with a 2.00 cap', () => {
		const result = serviceFeeFromForm(feeForm({ percent: '3', cap: '2.00' }), 'USD')
		expect(result.ok && result.settings).toMatchObject({
			enabled: true,
			percentBp: 300,
			capMinor: 200,
			fixedMinor: 0,
			label: 'Service fee',
			explanation: null,
		})
	})

	it('reads fractions of a percent and Arabic digits', () => {
		const result = serviceFeeFromForm(
			feeForm({ percent: '٢٫٥', fixed: '٠٫٥٠' }),
			'SAR',
		)
		expect(result.ok && result.settings).toMatchObject({
			percentBp: 250,
			fixedMinor: 50,
		})
	})

	it('refuses more than 10 %, a cap of 0 and a fixed amount over the currency limit', () => {
		expect(serviceFeeFromForm(feeForm({ percent: '10.01' }), 'USD')).toMatchObject({
			ok: false,
			issue: { field: 'percent', code: 'too_large' },
		})
		expect(serviceFeeFromForm(feeForm({ cap: '0' }), 'USD')).toMatchObject({
			ok: false,
			issue: { field: 'cap', code: 'invalid_amount' },
		})
		expect(serviceFeeFromForm(feeForm({ fixed: '25.01' }), 'USD')).toMatchObject({
			ok: false,
			issue: { field: 'fixed', code: 'too_large' },
		})
		expect(serviceFeeFromForm(feeForm({ fixed: '25.01' }), 'SAR').ok).toBe(true)
	})

	it('needs both the small order limit and its fee, or neither', () => {
		expect(
			serviceFeeFromForm(feeForm({ smallOrderBelow: '15' }), 'USD'),
		).toMatchObject({ ok: false, issue: { field: 'smallOrderFee', code: 'required' } })
		const both = serviceFeeFromForm(
			feeForm({ smallOrderBelow: '15', smallOrderFee: '1.00' }),
			'USD',
		)
		expect(both.ok && both.settings).toMatchObject({
			smallOrderBelowMinor: 1500,
			smallOrderFeeMinor: 100,
		})
	})

	it('needs an order type and something to charge while on', () => {
		expect(
			serviceFeeFromForm(feeForm({ pickup: false, delivery: false }), 'USD'),
		).toMatchObject({ ok: false, issue: { field: 'fulfillments' } })
		expect(
			serviceFeeFromForm(feeForm({ percent: '', fixed: '' }), 'USD'),
		).toMatchObject({ ok: false })
		// Off, it may stay empty of charges.
		expect(
			serviceFeeFromForm(feeForm({ enabled: false, percent: '', fixed: '' }), 'USD')
				.ok,
		).toBe(true)
	})

	it('round-trips a saved fee into the form and back', () => {
		const saved = serviceFeeFromForm(
			feeForm({
				percent: '3',
				fixed: '0.25',
				cap: '2',
				explanation: 'Covers card and ordering costs.',
				dineIn: true,
				taxable: true,
				label: 'Online order fee',
			}),
			'USD',
		)
		if (!saved.ok) throw new Error('expected a valid fee')
		const form = feeFormFromSettings(saved.settings, 'USD')
		expect(serviceFeeFromForm(form, 'USD')).toEqual(saved)
	})
})

describe('parseCheckoutSettingsFields', () => {
	const posted = (tips = tipForm(), fee = feeForm({ percent: '3' })) => ({
		checkoutTips: JSON.stringify(tips),
		checkoutFee: JSON.stringify(fee),
	})

	it('writes both groups', () => {
		const result = parseCheckoutSettingsFields(posted(), {
			currency: 'USD',
			serviceFeeEnabled: true,
		})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(JSON.parse(result.patch.tipSettings!)).toEqual(defaultTipSettings('USD'))
		expect(JSON.parse(result.patch.serviceFee!)).toMatchObject({ percentBp: 300 })
	})

	it('never writes the fee while the flag is off', () => {
		const result = parseCheckoutSettingsFields(
			posted(tipForm(), feeForm({ percent: 'junk' })),
			{ currency: 'USD', serviceFeeEnabled: false },
		)
		expect(result.ok && result.patch.serviceFee).toBeUndefined()
	})

	it('leaves a group that was not posted alone', () => {
		expect(
			parseCheckoutSettingsFields({}, { currency: 'USD', serviceFeeEnabled: true }),
		).toEqual({ ok: true, patch: {} })
	})

	it('refuses with the section and field, not the value', () => {
		const bad = tipForm()
		bad.pickup.choices[0] = { kind: 'percent', value: 'secret-looking' }
		const result = parseCheckoutSettingsFields(posted(bad), {
			currency: 'USD',
			serviceFeeEnabled: true,
		})
		expect(result).toMatchObject({
			ok: false,
			issue: { section: 'tips', field: 'pickup.choice.0' },
		})
		expect(JSON.stringify(result)).not.toContain('secret-looking')
		expect(
			parseCheckoutSettingsFields(
				{ checkoutTips: '{not json' },
				{ currency: 'USD', serviceFeeEnabled: true },
			),
		).toMatchObject({ ok: false, issue: { section: 'tips' } })
	})
})
