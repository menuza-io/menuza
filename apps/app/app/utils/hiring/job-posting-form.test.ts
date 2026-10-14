import { describe, expect, it } from 'vitest'
import {
	emptyPostingForm,
	firstInvalidStep,
	formFromPosting,
	moveQuestion,
	newOpenQuestion,
	newYesNoQuestion,
	publishBlockers,
	toPayload,
	validateStep,
} from './job-posting-form.ts'

const base = () => ({
	...emptyPostingForm({ currency: 'USD' }),
	title: 'Line cook',
	positionName: 'Cook',
	descriptionHtml: '<p>Cook on the line during busy dinner service.</p>',
})

describe('toPayload', () => {
	it('turns money into minor units', () => {
		const payload = toPayload({
			...base(),
			payType: 'hourly',
			payMin: '18.50',
			payMax: '22',
		})
		expect(payload).toMatchObject({
			payMinMinor: 1850,
			payMaxMinor: 2200,
		})
	})

	it('sends no amounts when pay is not shown, even if the fields hold text', () => {
		const payload = toPayload({ ...base(), payMin: '10', payMax: '20' })
		expect(payload.payMinMinor).toBeNull()
		expect(payload.payMaxMinor).toBeNull()
	})

	it('keeps an empty closing date as null', () => {
		expect(toPayload(base()).closesOn).toBeNull()
	})
})

describe('formFromPosting', () => {
	it('round-trips through the payload', () => {
		const form = {
			...base(),
			payType: 'monthly' as const,
			payMin: '4000.00',
			payMax: '5000.00',
			closesOn: '2026-12-01',
		}
		const payload = toPayload(form)
		expect(
			formFromPosting({
				...payload,
				employmentType: payload.employmentType,
				payType: payload.payType,
			}),
		).toEqual(form)
	})
})

describe('validateStep', () => {
	it('needs a title and a position', () => {
		expect(validateStep(emptyPostingForm({ currency: 'USD' }), 'role')).toEqual(
			{
				title: 'title_required',
				positionName: 'position_required',
			},
		)
		expect(validateStep({ ...base(), title: 'ab' }, 'role')).toEqual({
			title: 'title_short',
		})
		expect(validateStep(base(), 'role')).toEqual({})
	})

	it('checks pay only when it is shown', () => {
		expect(validateStep({ ...base(), payMin: 'abc' }, 'pay')).toEqual({})
		const hourly = { ...base(), payType: 'hourly' as const }
		expect(validateStep(hourly, 'pay')).toEqual({ payMin: 'pay_required' })
		expect(validateStep({ ...hourly, payMin: '1.234' }, 'pay')).toEqual({
			payMin: 'pay_invalid',
		})
		expect(
			validateStep({ ...hourly, payMin: '25', payMax: '15' }, 'pay'),
		).toEqual({ payMax: 'pay_range' })
		expect(validateStep({ ...hourly, payMin: '15' }, 'pay')).toEqual({})
		expect(validateStep({ ...hourly, payMax: '15' }, 'pay')).toEqual({})
	})

	it('rejects a closing date in the past, but never for the general application', () => {
		const form = { ...base(), closesOn: '2026-01-01' }
		expect(validateStep(form, 'pay', { today: '2026-10-13' })).toEqual({
			closesOn: 'closes_on_past',
		})
		expect(
			validateStep(form, 'pay', { today: '2026-10-13', general: true }),
		).toEqual({})
		expect(validateStep({ ...base(), closesOn: 'soon' }, 'pay')).toEqual({
			closesOn: 'closes_on_invalid',
		})
	})

	it('needs a prompt on every question', () => {
		const question = newYesNoQuestion([])
		expect(
			validateStep({ ...base(), questions: [question] }, 'screener'),
		).toEqual({ [`question:${question.id}`]: 'prompt_required' })
	})
})

describe('publishBlockers', () => {
	it('names what blocks going live and the step that fixes it', () => {
		const form = {
			...base(),
			descriptionHtml: '<p>Hi</p>',
			closesOn: '2026-01-01',
		}
		expect(publishBlockers(form, { today: '2026-10-13' })).toEqual([
			{ code: 'description', step: 'role' },
			{ code: 'closes_on_past', step: 'pay' },
		])
		expect(publishBlockers(base(), { today: '2026-10-13' })).toEqual([])
	})
})

describe('firstInvalidStep', () => {
	it('finds the earliest step with a problem', () => {
		expect(firstInvalidStep(base())).toBeNull()
		expect(firstInvalidStep({ ...base(), payType: 'hourly' as const })).toBe(
			'pay',
		)
		expect(firstInvalidStep({ ...base(), title: '' })).toBe('role')
	})
})

describe('questions', () => {
	it('hands out unique ids', () => {
		const first = newYesNoQuestion([])
		const second = newOpenQuestion([first])
		expect(first.id).not.toBe(second.id)
	})

	it('moves within bounds only', () => {
		expect(moveQuestion([1, 2, 3], 0, 1)).toEqual([2, 1, 3])
		expect(moveQuestion([1, 2, 3], 0, -1)).toEqual([1, 2, 3])
		expect(moveQuestion([1, 2, 3], 2, 3)).toEqual([1, 2, 3])
	})
})
