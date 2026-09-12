import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { type PublicFormField } from '@repo/common/public-form'
import { type IconName } from '@repo/ui/icon'
import { useMemo } from 'react'

export type FieldType = PublicFormField['type']

export const DEFAULT_CHOICE_OPTIONS = ['Option 1', 'Option 2']

export function nextChoiceOption(count: number) {
	return `Option ${count + 1}`
}

type FieldTypeMetaSource = {
	label: MessageDescriptor
	icon: IconName
	description: MessageDescriptor
	defaultLabel: MessageDescriptor
}

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMetaSource> = {
	name: {
		label: msg`Name`,
		icon: 'user',
		description: msg`Collect a person’s name.`,
		defaultLabel: msg`Name`,
	},
	text: {
		label: msg`Text field`,
		icon: 'file-text',
		description: msg`Collect a short written answer.`,
		defaultLabel: msg`Text field`,
	},
	email: {
		label: msg`Email`,
		icon: 'mail',
		description: msg`Collect a valid email address.`,
		defaultLabel: msg`Email`,
	},
	single_choice: {
		label: msg`Single choice`,
		icon: 'circle',
		description: msg`Let people select one option.`,
		defaultLabel: msg`Single choice`,
	},
	tel: {
		label: msg`Phone number`,
		icon: 'smartphone',
		description: msg`Collect a phone number.`,
		defaultLabel: msg`Phone number`,
	},
	multiple_choice: {
		label: msg`Multiple choice`,
		icon: 'circle-check',
		description: msg`Let people select several options.`,
		defaultLabel: msg`Multiple choice`,
	},
	heading: {
		label: msg`Heading`,
		icon: 'file-text',
		description: msg`Add a title between fields.`,
		defaultLabel: msg`Heading`,
	},
	datetime: {
		label: msg`Date & time`,
		icon: 'calendar',
		description: msg`Collect a date and time.`,
		defaultLabel: msg`Date & time`,
	},
	paragraph: {
		label: msg`Paragraph`,
		icon: 'message-square',
		description: msg`Add supporting information.`,
		defaultLabel: msg`Paragraph`,
	},
	textarea: {
		label: msg`Long text`,
		icon: 'edit',
		description: msg`Collect a longer written answer.`,
		defaultLabel: msg`Long text`,
	},
}

export type ResolvedFieldTypeMeta = {
	label: string
	icon: IconName
	description: string
	defaultLabel: string
}

export function resolveFieldTypes(
	translate: (descriptor: MessageDescriptor) => string,
) {
	const FIELD_TYPES = Object.fromEntries(
		Object.entries(FIELD_TYPE_META).map(([type, meta]) => [
			type,
			{
				label: translate(meta.label),
				icon: meta.icon,
				description: translate(meta.description),
				defaultLabel: translate(meta.defaultLabel),
			},
		]),
	) as Record<FieldType, ResolvedFieldTypeMeta>

	const ADDABLE_FIELD_TYPES = (Object.keys(FIELD_TYPES) as FieldType[]).map(
		(type) => ({
			type,
			...FIELD_TYPES[type],
		}),
	)

	return { FIELD_TYPES, ADDABLE_FIELD_TYPES }
}

export function useFieldTypes() {
	const { _ } = useLingui()
	return useMemo(() => resolveFieldTypes(_), [_])
}

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
