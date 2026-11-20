import {
	publicFormDisplayFieldTypes,
	visibleFields,
	type FormAnswers,
	type PublicFormField,
} from '@repo/common/public-form'

/**
 * The browser half of the website form's field rules (#239, #357). The region
 * validates again with the same `@repo/common` code, so nothing here is a
 * security boundary: it decides what a visitor sees and what the browser sends.
 */

export type FormLocation = { id: string; name: string }

/**
 * The locations a Location field offers: the operator's chosen ones (or every
 * one when none were chosen) that are still active. A deactivated location is
 * never in `active`, so it never appears.
 */
export function offeredLocations(
	field: Pick<PublicFormField, 'locationIds'>,
	active: readonly FormLocation[],
): FormLocation[] {
	const chosen = field.locationIds?.length ? new Set(field.locationIds) : null
	return active.filter((location) => !chosen || chosen.has(location.id))
}

/**
 * How a Location field shows: not at all with no location left, as an
 * automatic answer with exactly one (nobody is asked to choose the only
 * place), as a picker otherwise.
 */
export function locationFieldMode(
	offered: readonly FormLocation[],
): 'hidden' | 'single' | 'pick' {
	return offered.length === 0
		? 'hidden'
		: offered.length === 1
			? 'single'
			: 'pick'
}

/** The field ids a visitor sees for the answers given so far. */
export function visibleFieldIds(
	fields: readonly PublicFormField[],
	answers: FormAnswers,
): Set<string> {
	return new Set(visibleFields(fields, answers).map((field) => field.id))
}

/** Single-choice answers, which are all a condition reads. */
export function choiceAnswersFrom(
	fields: readonly PublicFormField[],
	read: (name: string) => string | undefined,
): FormAnswers {
	const answers: FormAnswers = {}
	for (const field of fields) {
		if (field.type !== 'single_choice') continue
		const value = read(field.id)
		if (value) answers[field.id] = value
	}
	return answers
}

export type FormPayload = {
	values: Record<string, string | string[] | Record<string, string>>
	/** The name the guest saw for the location they picked, by field id. */
	locationLabels: Record<string, string>
	/** Location fields with no location to offer (not required then). */
	unavailableFields: string[]
}

/**
 * What the browser sends: only the visible fields (a hidden field's value is
 * not sent at all), an address as its three parts, a location as its id with
 * the name the guest saw.
 */
export function buildFormPayload(
	fields: readonly PublicFormField[],
	input: {
		/** All values of a named input, in order. */
		getAll: (name: string) => string[]
		/** Locations on offer per Location field id. */
		offered: Readonly<Record<string, readonly FormLocation[]>>
	},
): FormPayload {
	const first = (name: string) => input.getAll(name)[0] ?? ''
	const answers = choiceAnswersFrom(fields, (name) => first(name) || undefined)
	const values: FormPayload['values'] = {}
	const locationLabels: Record<string, string> = {}
	const unavailableFields: string[] = []
	for (const field of visibleFields(fields, answers)) {
		if (
			(publicFormDisplayFieldTypes as readonly string[]).includes(field.type)
		) {
			continue
		}
		if (field.type === 'address') {
			values[field.id] = {
				street: first(`${field.id}__street`),
				city: first(`${field.id}__city`),
				postcode: first(`${field.id}__postcode`),
			}
		} else if (field.type === 'location') {
			const offered = input.offered[field.id] ?? []
			if (offered.length === 0) {
				unavailableFields.push(field.id)
				continue
			}
			const id = offered.length === 1 ? offered[0]!.id : first(field.id)
			const picked = offered.find((location) => location.id === id)
			if (!picked) continue
			values[field.id] = picked.id
			locationLabels[field.id] = picked.name
		} else if (field.type === 'multiple_choice') {
			values[field.id] = input.getAll(field.id)
		} else {
			values[field.id] = first(field.id)
		}
	}
	return { values, locationLabels, unavailableFields }
}
