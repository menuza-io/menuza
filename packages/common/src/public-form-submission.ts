import { z } from 'zod'

import {
	brokenConditionFieldIds,
	isValidChoice,
	publicFormDisplayFieldTypes,
	visibleFields,
	type FormAnswers,
	type PublicFormField,
} from './public-form.ts'

/**
 * One validator for a public form submission (#357, #239). tenant-api calls it
 * after reading the form definition from the region; Sites uses
 * `visibleFields` from the same module to decide what to show.
 *
 * Rules: only fields visible for the answers given are read. A value sent for
 * a hidden field is dropped (never stored), and a required field that is
 * hidden never blocks the submission.
 */

export const MAX_FORM_VALUE_LENGTH = 5000
export const MAX_ADDRESS_PART_LENGTH = 200

export type FormSubmissionOptions = {
	/**
	 * Location fields the browser could not offer because no active location
	 * is left (#239). Honoured only for location fields: they stop being
	 * required. Any other field id here is ignored.
	 */
	unavailableLocationFields?: readonly string[]
	/**
	 * The name the guest saw for the location they picked, by field id. It is
	 * stored as the answer so managers (and the CSV) read a place name instead
	 * of an id; the id is kept beside it under `locationIdKey(fieldId)`.
	 */
	locationLabels?: Readonly<Record<string, string | undefined>>
}

/** Where a location answer's id is kept next to its readable name. */
export function locationIdKey(fieldId: string) {
	return `${fieldId}:location_id`
}

export type FormSubmissionResult =
	{ ok: true; values: Record<string, string> } | { ok: false; error: string }

function fail(error: string): FormSubmissionResult {
	return { ok: false, error }
}

/** The text of an address answer: street, city and postcode on one line each. */
export function composeAddress(parts: {
	street?: string
	city?: string
	postcode?: string
}): string {
	return [parts.street, parts.city, parts.postcode]
		.map((part) => part?.trim())
		.filter(Boolean)
		.join(', ')
}

function addressParts(raw: unknown) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const record = raw as Record<string, unknown>
	const part = (key: string) =>
		typeof record[key] === 'string' ? (record[key] as string).trim() : ''
	return {
		street: part('street'),
		city: part('city'),
		postcode: part('postcode'),
	}
}

function asSingleAnswer(raw: unknown): string | null {
	if (raw === undefined || raw === null) return ''
	if (Array.isArray(raw)) return null
	if (typeof raw === 'object') return null
	return String(raw).trim()
}

/** Answers that decide visibility, read before any validation. */
function choiceAnswers(
	fields: readonly PublicFormField[],
	raw: Record<string, unknown>,
): FormAnswers {
	const answers: FormAnswers = {}
	for (const field of fields) {
		if (field.type !== 'single_choice') continue
		const value = raw[field.id]
		if (typeof value === 'string') answers[field.id] = value
	}
	return answers
}

export function validateFormSubmission(
	fields: readonly PublicFormField[],
	raw: Record<string, unknown>,
	options: FormSubmissionOptions = {},
): FormSubmissionResult {
	// Defence in depth: a definition with a broken condition is read as if the
	// condition were absent (always visible) rather than hiding the field.
	const broken = new Set(brokenConditionFieldIds(fields))
	const effective = fields.map((field) =>
		broken.has(field.id) ? { ...field, showWhen: undefined } : field,
	)
	const visible = visibleFields(effective, choiceAnswers(effective, raw))
	const unavailable = new Set(options.unavailableLocationFields ?? [])
	const values: Record<string, string> = {}

	for (const field of visible) {
		if (
			(publicFormDisplayFieldTypes as readonly string[]).includes(field.type)
		) {
			continue
		}
		const answer = raw[field.id]

		if (field.type === 'multiple_choice') {
			const selected = Array.isArray(answer)
				? answer
						.map(String)
						.map((choice) => choice.trim())
						.filter(Boolean)
				: typeof answer === 'string'
					? answer
							.split(',')
							.map((choice) => choice.trim())
							.filter(Boolean)
					: []
			if (field.required && selected.length === 0) {
				return fail(`${field.label} is required`)
			}
			if (
				selected.some(
					(choice) =>
						!(field.options ?? []).length ||
						!isValidChoice(choice, field.options ?? []),
				)
			) {
				return fail(`${field.label} contains an invalid choice`)
			}
			const serialized = selected.join(', ')
			if (serialized.length > MAX_FORM_VALUE_LENGTH) {
				return fail('Value is too long')
			}
			values[field.id] = serialized
			continue
		}

		if (field.type === 'address') {
			const parts = addressParts(answer)
			// A plain string is accepted for older clients: stored as typed.
			const text =
				parts !== null
					? composeAddress(parts)
					: typeof answer === 'string'
						? answer.trim()
						: ''
			if (answer !== undefined && answer !== null && parts === null) {
				if (typeof answer !== 'string')
					return fail(`${field.label} is not valid`)
			}
			if (
				parts &&
				Object.values(parts).some(
					(part) => part.length > MAX_ADDRESS_PART_LENGTH,
				)
			) {
				return fail('Value is too long')
			}
			if (field.required && !text) return fail(`${field.label} is required`)
			if (text.length > MAX_FORM_VALUE_LENGTH) return fail('Value is too long')
			values[field.id] = text
			continue
		}

		const value = asSingleAnswer(answer)
		if (value === null) return fail(`${field.label} must be a single value`)

		if (field.type === 'location') {
			if (!value) {
				if (field.required && !unavailable.has(field.id)) {
					return fail(`${field.label} is required`)
				}
				values[field.id] = ''
				continue
			}
			if (value.length > 100) return fail(`${field.label} is not valid`)
			if (
				field.locationIds &&
				field.locationIds.length > 0 &&
				!field.locationIds.includes(value)
			) {
				return fail(`${field.label} contains an invalid choice`)
			}
			const label = options.locationLabels?.[field.id]?.trim().slice(0, 100)
			values[field.id] = label || value
			values[locationIdKey(field.id)] = value
			continue
		}

		if (field.required && !value) return fail(`${field.label} is required`)
		if (value.length > MAX_FORM_VALUE_LENGTH) return fail('Value is too long')
		if (
			field.type === 'email' &&
			value &&
			!z.string().email().safeParse(value).success
		) {
			return fail(`${field.label} must be a valid email`)
		}
		if (
			field.type === 'single_choice' &&
			value &&
			!isValidChoice(value, field.options ?? [])
		) {
			return fail(`${field.label} contains an invalid choice`)
		}
		if (field.type === 'text' && field.numeric && value) {
			const number = Number(value)
			if (!Number.isFinite(number)) {
				return fail(`${field.label} must be a number`)
			}
			if (field.min !== undefined && number < field.min) {
				return fail(`${field.label} must be at least ${field.min}`)
			}
			if (field.max !== undefined && number > field.max) {
				return fail(`${field.label} must be at most ${field.max}`)
			}
		}
		values[field.id] = value
	}
	return { ok: true, values }
}
