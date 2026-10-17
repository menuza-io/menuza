import { type MessageDescriptor } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import {
	validateAddJobForm,
	validatePositionForm,
	validateRateChangeForm,
} from './staff-validation.ts'

const translate = (descriptor: MessageDescriptor) =>
	String(descriptor.message ?? descriptor.id)

describe('validatePositionForm', () => {
	it('flags a missing name and a bad rate together', () => {
		expect(
			validatePositionForm({ name: ' ', rate: 'abc' }, translate, {
				canSetRate: true,
			}),
		).toEqual({
			name: 'Enter a name.',
			rate: 'Enter an amount like 15.50.',
		})
	})

	it('accepts an empty rate and ignores the rate without pay access', () => {
		expect(
			validatePositionForm({ name: 'Server', rate: '' }, translate, {
				canSetRate: true,
			}),
		).toEqual({})
		expect(
			validatePositionForm({ name: 'Server', rate: 'abc' }, translate, {
				canSetRate: false,
			}),
		).toEqual({})
	})
})

describe('validateAddJobForm', () => {
	it('flags the position and the amount together', () => {
		expect(
			validateAddJobForm(
				{ positionId: '', payType: 'hourly', amount: 'abc' },
				translate,
				{ canSetPay: true },
			),
		).toEqual({
			positionId: 'Choose a position.',
			amount: 'Enter an amount like 15.50.',
		})
	})

	it('needs a salary amount but not an hourly one', () => {
		expect(
			validateAddJobForm(
				{ positionId: 'p1', payType: 'salary', amount: '' },
				translate,
				{ canSetPay: true },
			),
		).toEqual({ amount: 'Enter the yearly salary.' })
		expect(
			validateAddJobForm(
				{ positionId: 'p1', payType: 'hourly', amount: '' },
				translate,
				{ canSetPay: true },
			),
		).toEqual({})
	})
})

describe('validateRateChangeForm', () => {
	it('flags the amount and the reason together', () => {
		expect(
			validateRateChangeForm({ amount: '', reason: '' }, translate),
		).toEqual({
			amount: 'Enter an amount like 15.50.',
			reason: 'Add a reason for the change.',
		})
		expect(
			validateRateChangeForm({ amount: '16.00', reason: 'Raise' }, translate),
		).toEqual({})
	})
})
