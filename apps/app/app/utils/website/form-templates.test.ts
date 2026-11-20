import { publicFormFieldsSchema } from '@repo/common/public-form'
import { validateFormSubmission } from '@repo/common/public-form-submission'
import { parseLocalizedString } from '@repo/common/site-locales'
import { describe, expect, it } from 'vitest'
import {
	buildFormTemplateFields,
	FORM_TEMPLATES,
	FORM_TEMPLATE_IDS,
} from './form-templates.ts'

describe('form templates (#239)', () => {
	it('offers a catering and an event request next to the older templates', () => {
		expect(FORM_TEMPLATES.map((template) => template.id)).toEqual([
			...FORM_TEMPLATE_IDS,
		])
		expect(FORM_TEMPLATE_IDS).toEqual(
			expect.arrayContaining(['catering', 'event']),
		)
	})

	it.each(['catering', 'event'])(
		'%s is a valid form in every site language',
		(id) => {
			for (const locales of [
				['en'],
				['en', 'ar'],
				['ar', 'en', 'es', 'fr', 'de', 'zh'],
			]) {
				const fields = buildFormTemplateFields(id, locales)!
				expect(publicFormFieldsSchema.safeParse(fields).success).toBe(true)
				if (locales.length > 1) {
					const label = parseLocalizedString(fields[0]!.label)
					expect(Object.keys(label).sort()).toEqual([...locales].sort())
				}
			}
		},
	)

	it('the catering form asks for an address only for delivery', () => {
		const fields = buildFormTemplateFields('catering')!
		const base = {
			name: 'Sam',
			phone: '+966500000000',
			email: 'sam@example.com',
			location: 'loc-a',
			date: '2026-12-01T18:00',
			headcount: '26-50',
		}
		// Pickup: the address is hidden, never required, and a value is dropped.
		const pickup = validateFormSubmission(fields, {
			...base,
			fulfilment: 'Pickup',
			address: { street: 'ignored' },
		})
		expect(pickup.ok).toBe(true)
		if (pickup.ok) expect(pickup.values).not.toHaveProperty('address')
		// Delivery needs it.
		expect(
			validateFormSubmission(fields, { ...base, fulfilment: 'Delivery' }),
		).toEqual({ ok: false, error: 'Delivery address is required' })
		const delivery = validateFormSubmission(fields, {
			...base,
			fulfilment: 'Delivery',
			address: { street: '1 Main St', city: 'Riyadh', postcode: '11564' },
		})
		expect(delivery.ok && delivery.values.address).toBe(
			'1 Main St, Riyadh, 11564',
		)
	})

	it('the condition follows a localized option in any language', () => {
		const fields = buildFormTemplateFields('catering', ['en', 'ar'])!
		const base = {
			name: 'Sam',
			phone: '+966500000000',
			email: 'sam@example.com',
			location: 'loc-a',
			date: '2026-12-01T18:00',
			headcount: '10-25',
		}
		// An Arabic-language guest picks the Arabic label of Delivery.
		expect(
			validateFormSubmission(fields, { ...base, fulfilment: 'توصيل' }),
		).toMatchObject({ ok: false })
		expect(
			validateFormSubmission(fields, { ...base, fulfilment: 'استلام' }).ok,
		).toBe(true)
	})

	it('the event form takes a headcount as a bounded number', () => {
		const fields = buildFormTemplateFields('event')!
		const headcount = fields.find((field) => field.id === 'headcount')!
		expect(headcount).toMatchObject({
			type: 'text',
			numeric: true,
			min: 1,
			max: 2000,
		})
	})
})
