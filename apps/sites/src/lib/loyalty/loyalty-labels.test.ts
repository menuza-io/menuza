import { type I18n, type MessageDescriptor } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { buildLoyaltyLabels } from './labels.ts'
import { catalogLoyaltyLabels, readCatalog } from './test-labels.ts'

const LOCALES = ['en', 'ar', 'es', 'fr', 'de', 'zh'] as const

/** Records every source message the label builder asks for. */
function collectSources() {
	const sources = new Set<string>()
	const recorder = {
		locale: 'en',
		_: (descriptor: MessageDescriptor) => {
			sources.add(String(descriptor.message))
			return String(descriptor.message)
		},
	} as unknown as I18n
	const labels = buildLoyaltyLabels(recorder)
	return { labels, sources: [...sources] }
}

/**
 * `{name}` placeholders, sorted and once each, so a translation keeps every
 * value slot (a plural form may leave out the number, like Arabic "نقطتان").
 */
function placeholders(text: string) {
	return [
		...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1])),
	].sort()
}

describe('loyalty labels', () => {
	const { labels, sources } = collectSources()

	it('has a non-empty English string for every key', () => {
		for (const [key, value] of Object.entries(labels)) {
			expect({ key, value }).not.toEqual({ key, value: '' })
		}
		expect(Object.keys(labels).length).toBeGreaterThan(100)
	})

	for (const locale of LOCALES) {
		it(`has a translation with the same placeholders for every loyalty string in ${locale}`, () => {
			const catalog = readCatalog(locale)
			const missing = sources.filter((source) => {
				const value = catalog.get(source)
				return locale === 'en' ? value === undefined : !value
			})
			expect(missing).toEqual([])
			if (locale === 'en') return
			const broken = sources.filter(
				(source) =>
					placeholders(catalog.get(source) ?? '').join() !==
					placeholders(source).join(),
			)
			expect(broken).toEqual([])
		})

		it(`has every plural form ${locale} uses for points and stars`, () => {
			const localized = catalogLoyaltyLabels(locale)
			const categories = new Intl.PluralRules(locale).resolvedOptions()
				.pluralCategories
			for (const forms of [localized.points, localized.stars]) {
				for (const category of categories) {
					expect({ category, form: forms[category] }).toEqual({
						category,
						form: expect.stringMatching(/\S/),
					})
				}
				expect(forms.other).toContain('{count}')
				expect(Object.values(forms).join()).not.toMatch(/plural|\{n\b/)
			}
		})
	}
})
