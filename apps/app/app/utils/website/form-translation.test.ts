import { describe, expect, it } from 'vitest'

import {
	applyFormTranslations,
	collectFormTranslationFields,
} from './form-translation.ts'

const form = {
	name: 'Contact',
	description: 'Reach out to us.',
	fields: [
		{
			id: 'email',
			label: 'Email',
			type: 'email' as const,
			required: true,
		},
		{
			id: 'plan',
			label: 'Plan',
			type: 'single_choice' as const,
			required: false,
			options: ['Basic', 'Pro'],
		},
	],
	submitLabel: 'Submit',
	successMessage: 'Thanks!',
}

describe('form translation', () => {
	it('collects form-level and field-level strings', () => {
		const fields = collectFormTranslationFields(form, 'en', 'ar')
		expect(fields.map((field) => field.id)).toEqual([
			'form:name',
			'form:description',
			'form:submitLabel',
			'form:successMessage',
			'field:email:label',
			'field:plan:label',
			'field:plan:option:0',
			'field:plan:option:1',
		])
	})

	it('applies translated values into localized JSON', () => {
		const next = applyFormTranslations(
			form,
			[{ id: 'form:name', text: 'اتصل بنا' }],
			'ar',
			'en',
		)
		expect(JSON.parse(next.name)).toEqual({ en: 'Contact', ar: 'اتصل بنا' })
	})

	it('applies translated choice options', () => {
		const next = applyFormTranslations(
			form,
			[{ id: 'field:plan:option:1', text: 'احترافي' }],
			'ar',
			'en',
		)
		expect(JSON.parse(next.fields[1]!.options![1]!)).toEqual({
			en: 'Pro',
			ar: 'احترافي',
		})
	})
})
