import { describe, expect, it } from 'vitest'

import {
	brokenConditionFieldIds,
	clearBrokenConditions,
	publicFormFieldSchema,
	publicFormFieldsSchema,
	publicFormKvKey,
	toPublicFormProjection,
	visibleFields,
} from './public-form'
import {
	composeAddress,
	validateFormSubmission,
} from './public-form-submission'

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

describe('publicFormFieldSchema labels', () => {
	const field = { id: 'name', type: 'name' as const, required: true }

	it('accepts plain and localized labels', () => {
		expect(
			publicFormFieldSchema.safeParse({ ...field, label: 'Name' }).success,
		).toBe(true)
		expect(
			publicFormFieldSchema.safeParse({ ...field, label: '{"en":"Name"}' })
				.success,
		).toBe(true)
	})

	it('rejects a cleared localized label', () => {
		for (const label of ['{"en":""}', '{"en":"  "}', '{}', '']) {
			expect(publicFormFieldSchema.safeParse({ ...field, label }).success).toBe(
				false,
			)
		}
	})
})

const cateringFields = [
	{
		id: 'fulfilment',
		label: 'Delivery or pickup',
		type: 'single_choice' as const,
		required: true,
		options: ['Delivery', 'Pickup'],
	},
	{
		id: 'address',
		label: 'Address',
		type: 'address' as const,
		required: true,
		showWhen: { fieldId: 'fulfilment', values: ['Delivery'] },
	},
	{
		id: 'gate',
		label: 'Gate code',
		type: 'text' as const,
		required: true,
		showWhen: { fieldId: 'address', values: ['x'] },
	},
]

describe('conditional fields (#357)', () => {
	it('shows a field only for the chosen answers, through chains', () => {
		const fields = [
			cateringFields[0]!,
			cateringFields[1]!,
			{
				id: 'floor',
				label: 'Floor',
				type: 'text' as const,
				required: false,
				showWhen: { fieldId: 'fulfilment', values: ['Delivery'] },
			},
		]
		expect(
			visibleFields(fields, { fulfilment: 'Delivery' }).map((f) => f.id),
		).toEqual(['fulfilment', 'address', 'floor'])
		expect(
			visibleFields(fields, { fulfilment: 'Pickup' }).map((f) => f.id),
		).toEqual(['fulfilment'])
		expect(visibleFields(fields, {}).map((f) => f.id)).toEqual(['fulfilment'])
	})

	it('hides the dependants of a hidden field (chain)', () => {
		const chain = [
			cateringFields[0]!,
			{
				id: 'b',
				label: 'B',
				type: 'single_choice' as const,
				required: false,
				options: ['yes'],
				showWhen: { fieldId: 'fulfilment', values: ['Delivery'] },
			},
			{
				id: 'c',
				label: 'C',
				type: 'text' as const,
				required: false,
				showWhen: { fieldId: 'b', values: ['yes'] },
			},
		]
		expect(
			visibleFields(chain, { fulfilment: 'Pickup', b: 'yes' }).map((f) => f.id),
		).toEqual(['fulfilment'])
		expect(
			visibleFields(chain, { fulfilment: 'Delivery', b: 'yes' }).map(
				(f) => f.id,
			),
		).toEqual(['fulfilment', 'b', 'c'])
	})

	it('matches localized options in any language', () => {
		const fields = [
			{
				id: 'kind',
				label: 'Kind',
				type: 'single_choice' as const,
				required: false,
				options: ['{"en":"Delivery","ar":"توصيل"}'],
			},
			{
				id: 'more',
				label: 'More',
				type: 'text' as const,
				required: false,
				showWhen: {
					fieldId: 'kind',
					values: ['{"en":"Delivery","ar":"توصيل"}'],
				},
			},
		]
		expect(visibleFields(fields, { kind: 'توصيل' })).toHaveLength(2)
	})

	it('only allows a condition on a single-choice field placed above', () => {
		const below = [
			{
				...cateringFields[1]!,
				showWhen: { fieldId: 'fulfilment', values: ['Delivery'] },
			},
			cateringFields[0]!,
		]
		expect(brokenConditionFieldIds(below)).toEqual(['address'])
		expect(publicFormFieldsSchema.safeParse(below).success).toBe(false)
		const notChoice = [
			{ id: 'n', label: 'N', type: 'text' as const, required: false },
			{
				id: 'm',
				label: 'M',
				type: 'text' as const,
				required: false,
				showWhen: { fieldId: 'n', values: ['x'] },
			},
		]
		expect(brokenConditionFieldIds(notChoice)).toEqual(['m'])
		// A self-reference or a loop can never point upward.
		const loop = [
			{
				...cateringFields[0]!,
				showWhen: { fieldId: 'address', values: ['x'] },
			},
			cateringFields[1]!,
		]
		expect(publicFormFieldsSchema.safeParse(loop).success).toBe(false)
		expect(
			publicFormFieldsSchema.safeParse(cateringFields.slice(0, 2)).success,
		).toBe(true)
	})

	it('clears broken conditions and names them', () => {
		const result = clearBrokenConditions([
			cateringFields[1]!,
			cateringFields[0]!,
		])
		expect(result.cleared).toEqual(['address'])
		expect(result.fields[0]!.showWhen).toBeUndefined()
	})
})

describe('validating a submission (#239, #357)', () => {
	const fields = cateringFields.slice(0, 2)

	it('drops the value of a hidden field and never requires it', () => {
		const result = validateFormSubmission(fields, {
			fulfilment: 'Pickup',
			address: { street: '1 Main St', city: 'Riyadh', postcode: '11564' },
		})
		expect(result).toEqual({ ok: true, values: { fulfilment: 'Pickup' } })
	})

	it('requires a visible required field', () => {
		const result = validateFormSubmission(fields, { fulfilment: 'Delivery' })
		expect(result).toEqual({ ok: false, error: 'Address is required' })
	})

	it('stores an address as one line from its parts', () => {
		const result = validateFormSubmission(fields, {
			fulfilment: 'Delivery',
			address: { street: ' 1 Main St ', city: 'Riyadh', postcode: '11564' },
		})
		expect(result).toEqual({
			ok: true,
			values: { fulfilment: 'Delivery', address: '1 Main St, Riyadh, 11564' },
		})
		expect(composeAddress({ street: 'A', postcode: 'B' })).toBe('A, B')
	})

	it('ignores a condition that points nowhere valid', () => {
		const result = validateFormSubmission(
			[{ ...cateringFields[1]!, showWhen: { fieldId: 'gone', values: ['x'] } }],
			{ address: { street: 's' } },
		)
		expect(result.ok).toBe(true)
	})

	it('checks numbers against min and max', () => {
		const number = [
			{
				id: 'heads',
				label: 'Guests',
				type: 'text' as const,
				required: true,
				numeric: true,
				min: 10,
				max: 500,
			},
		]
		expect(validateFormSubmission(number, { heads: '25' })).toEqual({
			ok: true,
			values: { heads: '25' },
		})
		expect(validateFormSubmission(number, { heads: '5' }).ok).toBe(false)
		expect(validateFormSubmission(number, { heads: '501' }).ok).toBe(false)
		expect(validateFormSubmission(number, { heads: 'many' }).ok).toBe(false)
	})

	it('accepts a location from the chosen list and refuses another', () => {
		const location = [
			{
				id: 'place',
				label: 'Branch',
				type: 'location' as const,
				required: true,
				locationIds: ['loc-a', 'loc-b'],
			},
		]
		expect(validateFormSubmission(location, { place: 'loc-a' }).ok).toBe(true)
		expect(validateFormSubmission(location, { place: 'loc-z' }).ok).toBe(false)
		// The readable name is the answer; the id stays beside it.
		expect(
			validateFormSubmission(
				location,
				{ place: 'loc-b' },
				{ locationLabels: { place: 'Downtown' } },
			),
		).toEqual({
			ok: true,
			values: { place: 'Downtown', 'place:location_id': 'loc-b' },
		})
		expect(validateFormSubmission(location, {}).ok).toBe(false)
	})

	it('lets a form with no active locations left skip the location field', () => {
		const location = [
			{
				id: 'place',
				label: 'Branch',
				type: 'location' as const,
				required: true,
			},
			{ id: 'who', label: 'Who', type: 'text' as const, required: true },
		]
		expect(
			validateFormSubmission(
				location,
				{ who: 'Sam' },
				{ unavailableLocationFields: ['place'] },
			),
		).toEqual({ ok: true, values: { place: '', who: 'Sam' } })
		// The list is honoured for location fields only.
		expect(
			validateFormSubmission(
				location,
				{},
				{ unavailableLocationFields: ['who'] },
			).ok,
		).toBe(false)
	})
})
