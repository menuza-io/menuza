import { describe, expect, it } from 'vitest'
import {
	computeTranslationStatus,
	filterTranslationGaps,
	namesLeftBlank,
	type TranslatableRecord,
} from './translation-status.ts'

const config = { locales: ['en', 'ar'], defaultLocale: 'en' }

const records: TranslatableRecord[] = [
	{
		kind: 'item',
		id: 'i1',
		name: '{"en":"Shawarma"}',
		description: '{"en":"Wrap","ar":"لفافة"}',
	},
	{
		kind: 'item',
		id: 'i2',
		name: '{"en":"Falafel","ar":"فلافل"}',
		description: '{"en":"Fried"}',
	},
	{
		kind: 'item',
		id: 'i3',
		name: '{"en":"Tea","ar":"شاي"}',
		description: null,
	},
	{ kind: 'option', id: 'o1', name: 'Extra cheese' },
	{ kind: 'modifier_group', id: 'g1', name: '{"ar":"الصلصة"}' },
	{
		kind: 'category',
		id: 'c1',
		name: '{"en":"Mains","ar":"أطباق"}',
		description: '',
	},
]

describe('translation status (#410)', () => {
	it('lists a dish with no Arabic name as missing', () => {
		const { gaps } = computeTranslationStatus(records, config)
		const missingArabicNames = filterTranslationGaps(gaps, {
			locale: 'ar',
			field: 'name',
		})
		expect(missingArabicNames.map((gap) => gap.id)).toEqual(['i1', 'o1'])
		expect(missingArabicNames[0]).toMatchObject({
			kind: 'item',
			label: 'Shawarma',
		})
	})

	it('counts names and descriptions separately', () => {
		const { locales } = computeTranslationStatus(records, config)
		const ar = locales.find((summary) => summary.locale === 'ar')!
		expect(ar).toEqual({
			locale: 'ar',
			missingNames: 2,
			missingDescriptions: 1,
			names: 6,
			descriptions: 2,
		})
		const en = locales.find((summary) => summary.locale === 'en')!
		// The group has only an Arabic name; no description is missing in English.
		expect(en).toEqual({
			locale: 'en',
			missingNames: 1,
			missingDescriptions: 0,
			names: 6,
			descriptions: 2,
		})
	})

	it('filters by kind', () => {
		const { gaps } = computeTranslationStatus(records, config)
		expect(filterTranslationGaps(gaps, { kind: 'modifier_group' })).toEqual([
			{
				kind: 'modifier_group',
				id: 'g1',
				field: 'name',
				locale: 'en',
				label: 'الصلصة',
			},
		])
	})

	it('finds names that removing a language would leave empty', () => {
		expect(
			namesLeftBlank(records, { nextLocales: ['en'], defaultLocale: 'en' }),
		).toEqual([{ kind: 'modifier_group', id: 'g1', label: 'الصلصة' }])
		expect(
			namesLeftBlank(records, { nextLocales: ['ar'], defaultLocale: 'ar' }).map(
				(r) => r.id,
			),
		).toEqual(['i1'])
		// Plain-text names show in every language.
		expect(
			namesLeftBlank([{ kind: 'option', id: 'o', name: 'Plain' }], {
				nextLocales: ['fr'],
				defaultLocale: 'fr',
			}),
		).toEqual([])
		expect(
			namesLeftBlank(records, {
				nextLocales: ['en', 'ar'],
				defaultLocale: 'en',
			}),
		).toEqual([])
	})
})
