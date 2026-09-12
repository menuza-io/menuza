import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type PublicFormField } from '@repo/common/public-form'

export const FORM_TEMPLATE_IDS = [
	'blank',
	'contact',
	'lead',
	'feedback',
] as const

export type FormTemplateId = (typeof FORM_TEMPLATE_IDS)[number]

export type FormTemplate = {
	id: FormTemplateId
	name: MessageDescriptor
	description: MessageDescriptor
	fields: PublicFormField[]
}

export const FORM_TEMPLATES: FormTemplate[] = [
	{
		id: 'blank',
		name: msg`Start from scratch`,
		description: msg`A clean canvas with one field you can shape into anything.`,
		fields: [{ id: 'name', label: 'Name', type: 'name', required: false }],
	},
	{
		id: 'contact',
		name: msg`Contact form`,
		description: msg`Collect a name, email address, and a detailed message.`,
		fields: [
			{ id: 'name', label: 'Name', type: 'name', required: true },
			{ id: 'email', label: 'Email', type: 'email', required: true },
			{ id: 'message', label: 'Message', type: 'textarea', required: true },
		],
	},
	{
		id: 'lead',
		name: msg`Lead capture`,
		description: msg`A short, low-friction form for prospective customers.`,
		fields: [
			{ id: 'name', label: 'Name', type: 'name', required: true },
			{ id: 'email', label: 'Work email', type: 'email', required: true },
			{ id: 'phone', label: 'Phone', type: 'tel', required: false },
		],
	},
	{
		id: 'feedback',
		name: msg`Feedback`,
		description: msg`Give visitors room to share thoughtful feedback.`,
		fields: [
			{ id: 'email', label: 'Email', type: 'email', required: false },
			{
				id: 'feedback',
				label: 'Your feedback',
				type: 'textarea',
				required: true,
			},
		],
	},
]

export function getFormTemplate(id: string) {
	return FORM_TEMPLATES.find((template) => template.id === id)
}

export function getFormTemplateFields(id: string) {
	return getFormTemplate(id)?.fields.map((field) => ({ ...field }))
}
