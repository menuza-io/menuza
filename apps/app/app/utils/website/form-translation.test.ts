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
		])
	})

	it('applies translated values into localized JSON', () => {
		const next = applyFormTranslations(
			form,
			[{ id: 'form:name', text: 'اتصل بنا' }],
			'ar',
			'en',
		)
		expect(next.name).toBe('{"en":"Contact","ar":"اتصل بنا"}')
	})
})
