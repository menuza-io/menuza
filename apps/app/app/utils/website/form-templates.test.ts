import { publicFormFieldsSchema } from '@repo/common/public-form'
import { describe, expect, it } from 'vitest'

import {
	FORM_TEMPLATES,
	getFormTemplate,
	getFormTemplateFields,
} from './form-templates.ts'

describe('website form templates', () => {
	it('has unique template ids and schema-valid field sets', () => {
		expect(new Set(FORM_TEMPLATES.map(({ id }) => id)).size).toBe(
			FORM_TEMPLATES.length,
		)
		for (const template of FORM_TEMPLATES) {
			expect(publicFormFieldsSchema.safeParse(template.fields).success).toBe(
				true,
			)
		}
	})

	it('collects only the initial job application fields', () => {
		const fields = getFormTemplateFields('job-application')!
		expect(fields.map(({ id }) => id)).toEqual([
			'name',
			'email',
			'phone',
			'role',
			'availability',
			'experience',
		])
		expect(fields.find(({ id }) => id === 'email')).toMatchObject({
			type: 'email',
			required: true,
		})
		expect(fields.find(({ id }) => id === 'phone')?.required).toBe(false)
		expect(getFormTemplate('job-application')).toMatchObject({
			submitLabel: 'Send application',
			successMessage: expect.stringContaining('application has been received'),
		})
	})

	it('returns editable fields without changing the shared preset', () => {
		const fields = getFormTemplateFields('job-application')!
		fields[0]!.label = 'Applicant name'
		fields.push({
			id: 'custom',
			label: 'Custom',
			type: 'text',
			required: false,
		})
		expect(getFormTemplateFields('job-application')).toHaveLength(6)
		expect(getFormTemplateFields('job-application')![0]!.label).toBe(
			'Full name',
		)
	})

	it('does not fall back to another template for an unknown id', () => {
		expect(getFormTemplate('unknown')).toBeUndefined()
		expect(getFormTemplateFields('unknown')).toBeUndefined()
	})
})
