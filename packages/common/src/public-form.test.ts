import { describe, expect, it } from 'vitest'

import {
	publicFormFieldSchema,
	publicFormKvKey,
	toPublicFormProjection,
} from './public-form'

const form = {
	id: 'form-1',
	name: 'Contact',
	description: 'Send us a message.',
	fields: [
		{
			id: 'email',
			label: 'Email',
			type: 'email' as const,
			required: true,
		},
	],
	submitLabel: 'Send',
	successMessage: 'Received.',
	status: 'published',
	updatedAt: '2026-09-09T12:00:00.000Z',
}

describe('public form projection', () => {
	it('uses an organization-scoped, versioned KV key', () => {
		expect(publicFormKvKey('org-1', 'form-1')).toBe(
			'public-form:v1:org-1:form-1',
		)
	})

	it('keeps only the public form configuration', () => {
		expect(toPublicFormProjection(form)).toEqual({
			id: form.id,
			name: form.name,
			description: form.description,
			fields: form.fields,
			submitLabel: form.submitLabel,
			successMessage: form.successMessage,
			status: 'published',
			revision: form.updatedAt,
		})
	})

	it('does not project an unpublished form', () => {
		expect(toPublicFormProjection({ ...form, status: 'draft' })).toBeNull()
	})

	it('requires choices for choice fields', () => {
		const parsed = publicFormFieldSchema.safeParse({
			id: 'plan',
			label: 'Plan',
			type: 'single_choice',
			required: true,
		})
		expect(parsed.success).toBe(false)
	})

	it('accepts choice fields with options', () => {
		const parsed = publicFormFieldSchema.safeParse({
			id: 'plan',
			label: 'Plan',
			type: 'single_choice',
			required: true,
			options: ['Starter', 'Pro'],
		})
		expect(parsed.success).toBe(true)
	})
})
