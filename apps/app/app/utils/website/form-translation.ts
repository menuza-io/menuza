import { type PublicFormField } from '@repo/common/public-form'
import {
	parseLocalizedString,
	serializeLocalizedString,
	type LocalizedString,
} from '@repo/common/site-locales'

import { describeLocalizedValue, type TranslateItem } from './translation.ts'

export type FormTranslationField = TranslateItem & {
	path: string
}

type WebsiteFormShape = {
	name: string
	description: string | null
	submitLabel: string
	successMessage: string
	fields: PublicFormField[]
}

function toFormTranslateItem(
	id: string,
	raw: LocalizedString | string | null | undefined,
	defaultLocale: string,
	activeLocale: string,
): TranslateItem | null {
	const described = describeLocalizedValue(raw, defaultLocale, activeLocale)
	if (!described) return null
	return { id, ...described, allowHtml: false }
}

export function collectFormTranslationFields(
	form: WebsiteFormShape,
	defaultLocale: string,
	activeLocale: string,
): FormTranslationField[] {
	const fields: FormTranslationField[] = []

	const push = (id: string, path: string, raw: string | null | undefined) => {
		const item = toFormTranslateItem(id, raw, defaultLocale, activeLocale)
		if (!item) return
		fields.push({ ...item, path })
	}

	push('form:name', 'name', form.name)
	push('form:description', 'description', form.description)
	push('form:submitLabel', 'submitLabel', form.submitLabel)
	push('form:successMessage', 'successMessage', form.successMessage)

	for (const field of form.fields) {
		push(`field:${field.id}:label`, `fields.${field.id}.label`, field.label)
		if (field.options) {
			for (const [index, option] of field.options.entries()) {
				push(
					`field:${field.id}:option:${index}`,
					`fields.${field.id}.options.${index}`,
					option,
				)
			}
		}
	}

	return fields
}

export function collectFieldTranslationFields(
	field: PublicFormField,
	defaultLocale: string,
	activeLocale: string,
): FormTranslationField[] {
	return collectFormTranslationFields(
		{
			name: '',
			description: null,
			submitLabel: '',
			successMessage: '',
			fields: [field],
		},
		defaultLocale,
		activeLocale,
	)
}

function applyLocalizedValue(
	current: string,
	translated: string,
	activeLocale: string,
	defaultLocale: string,
): string {
	const map = parseLocalizedString(current, defaultLocale)
	map[activeLocale] = translated
	return serializeLocalizedString(map)
}

export function applyFormTranslations(
	form: WebsiteFormShape,
	translations: Array<{ id: string; text: string }>,
	activeLocale: string,
	defaultLocale: string,
): WebsiteFormShape {
	const textById = new Map(translations.map((item) => [item.id, item.text]))
	const next: WebsiteFormShape = {
		...form,
		fields: form.fields.map((field) => ({ ...field })),
	}

	for (const [id, text] of textById) {
		if (id === 'form:name') {
			next.name = applyLocalizedValue(
				form.name,
				text,
				activeLocale,
				defaultLocale,
			)
		} else if (id === 'form:description') {
			next.description = applyLocalizedValue(
				form.description ?? '',
				text,
				activeLocale,
				defaultLocale,
			)
		} else if (id === 'form:submitLabel') {
			next.submitLabel = applyLocalizedValue(
				form.submitLabel,
				text,
				activeLocale,
				defaultLocale,
			)
		} else if (id === 'form:successMessage') {
			next.successMessage = applyLocalizedValue(
				form.successMessage,
				text,
				activeLocale,
				defaultLocale,
			)
		} else if (id.startsWith('field:') && id.includes(':label')) {
			const fieldId = id.split(':')[1]
			const field = next.fields.find((item) => item.id === fieldId)
			if (!field) continue
			field.label = applyLocalizedValue(
				field.label,
				text,
				activeLocale,
				defaultLocale,
			)
		} else if (id.startsWith('field:') && id.includes(':option:')) {
			const [, fieldId, , optionIndex] = id.split(':')
			const field = next.fields.find((item) => item.id === fieldId)
			const index = Number.parseInt(optionIndex ?? '', 10)
			if (!field?.options || Number.isNaN(index)) continue
			field.options = field.options.map((option, itemIndex) =>
				itemIndex === index
					? applyLocalizedValue(option, text, activeLocale, defaultLocale)
					: option,
			)
		}
	}

	return next
}
