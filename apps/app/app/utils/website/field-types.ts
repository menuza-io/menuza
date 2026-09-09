import { type PublicFormField } from '@repo/common/public-form'
import { type IconName } from '@repo/ui/icon'

export type FieldType = PublicFormField['type']

export const DEFAULT_CHOICE_OPTIONS = ['Option 1', 'Option 2']

export function nextChoiceOption(count: number) {
	return `Option ${count + 1}`
}

export const FIELD_TYPES: Record<
	FieldType,
	{
		label: string
		icon: IconName
		description: string
		defaultLabel: string
	}
> = {
	name: {
		label: 'Name',
		icon: 'user',
		description: 'Collect a person’s name.',
		defaultLabel: 'Name',
	},
	text: {
		label: 'Text field',
		icon: 'file-text',
		description: 'Collect a short written answer.',
		defaultLabel: 'Text field',
	},
	email: {
		label: 'Email',
		icon: 'mail',
		description: 'Collect a valid email address.',
		defaultLabel: 'Email',
	},
	single_choice: {
		label: 'Single choice',
		icon: 'circle',
		description: 'Let people select one option.',
		defaultLabel: 'Single choice',
	},
	tel: {
		label: 'Phone number',
		icon: 'smartphone',
		description: 'Collect a phone number.',
		defaultLabel: 'Phone number',
	},
	multiple_choice: {
		label: 'Multiple choice',
		icon: 'circle-check',
		description: 'Let people select several options.',
		defaultLabel: 'Multiple choice',
	},
	heading: {
		label: 'Heading',
		icon: 'file-text',
		description: 'Add a title between fields.',
		defaultLabel: 'Heading',
	},
	datetime: {
		label: 'Date & time',
		icon: 'calendar',
		description: 'Collect a date and time.',
		defaultLabel: 'Date & time',
	},
	paragraph: {
		label: 'Paragraph',
		icon: 'message-square',
		description: 'Add supporting information.',
		defaultLabel: 'Paragraph',
	},
	textarea: {
		label: 'Long text',
		icon: 'edit',
		description: 'Collect a longer written answer.',
		defaultLabel: 'Long text',
	},
}

export const ADDABLE_FIELD_TYPES = (
	Object.keys(FIELD_TYPES) as FieldType[]
).map((type) => ({
	type,
	...FIELD_TYPES[type],
}))

export function uniqueFieldId(label: string, fields: PublicFormField[]) {
	const base =
		label
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '') || 'field'
	let id = base
	let suffix = 2
	while (fields.some((field) => field.id === id)) id = `${base}-${suffix++}`
	return id
}

export function createField(
	type: FieldType,
	label: string,
	fields: PublicFormField[],
): PublicFormField {
	return {
		id: uniqueFieldId(label, fields),
		label,
		type,
		required: false,
		...(type === 'single_choice' || type === 'multiple_choice'
			? { options: [...DEFAULT_CHOICE_OPTIONS] }
			: {}),
	}
}
