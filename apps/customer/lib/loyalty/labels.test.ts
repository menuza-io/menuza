import { LOYALTY_ERROR_CODES } from '@repo/loyalty'
import {
	LOYALTY_ERROR_LABELS,
	LOYALTY_LABELS,
	loyaltyErrorText,
	pluralForms,
	renderLoyaltyLabel,
} from './labels'
import {
	catalogI18n,
	CONTENT_LOCALES,
	readCatalog,
	testI18n,
} from '@/test/loyalty/i18n'

const SOURCES = Object.values(LOYALTY_LABELS).map((descriptor) =>
	String(descriptor.message),
)

/** `{name}` placeholders, sorted and once each (a plural form may leave out the number). */
function placeholders(text: string) {
	return [
		...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1])),
	].sort()
}

describe('loyalty labels', () => {
	it('has a non-empty English source for every key', () => {
		for (const [key, descriptor] of Object.entries(LOYALTY_LABELS)) {
			expect({ key, message: descriptor.message }).not.toEqual({
				key,
				message: '',
			})
		}
		expect(SOURCES.length).toBeGreaterThan(70)
	})

	it('has no duplicate sources beyond the countdown the member code and a till request share', () => {
		// The same wording under codeExpiresIn and approvalExpiresIn is on
		// purpose; the shared catalog entry translates it once.
		const seen = new Set<string>()
		const duplicates = new Set<string>()
		for (const source of SOURCES) {
			if (seen.has(source)) duplicates.add(source)
			seen.add(source)
		}
		expect([...duplicates]).toEqual(['Expires in {time}'])
	})

	for (const locale of CONTENT_LOCALES) {
		it(`has a translation in the app catalog for every loyalty string in ${locale}`, () => {
			const catalog = readCatalog(locale)
			const missing = SOURCES.filter((source) => {
				const value = catalog.get(source)
				return locale === 'en' ? value === undefined : !value
			})
			expect(missing).toEqual([])
			if (locale === 'en') return
			const broken = SOURCES.filter(
				(source) =>
					placeholders(catalog.get(source) ?? '').join() !==
					placeholders(source).join(),
			)
			expect(broken).toEqual([])
		})

		it(`has every plural form ${locale} uses for points and stars`, () => {
			const i18n = catalogI18n(locale)
			const categories = new Intl.PluralRules(locale).resolvedOptions()
				.pluralCategories
			for (const forms of [
				pluralForms(i18n, LOYALTY_LABELS.points),
				pluralForms(i18n, LOYALTY_LABELS.stars),
			]) {
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

	it('renders with values through an i18n', () => {
		expect(
			renderLoyaltyLabel(testI18n('en'), 'nextRewardProgress', {
				amount: '20 points',
				reward: 'Free latte',
			}),
		).toBe('20 points more to unlock Free latte')
		expect(renderLoyaltyLabel(catalogI18n('ar'), 'retry')).not.toBe('Try again')
	})

	it('has no enrollment or terms-acceptance wording left', () => {
		for (const source of SOURCES) {
			expect(source).not.toMatch(/\b(join|joined|joining|enroll|accept)\b/i)
		}
	})

	it('renders an error text for every code', () => {
		const i18n = testI18n('en')
		const codes = [
			...LOYALTY_ERROR_CODES,
			'signed_out',
			'organization_mismatch',
			'organization_not_found',
			'network',
			'invalid_response',
			'unknown',
		] as const
		for (const code of codes) {
			expect({ code, label: LOYALTY_ERROR_LABELS[code] }).toEqual({
				code,
				label: expect.any(String),
			})
			expect({ code, text: loyaltyErrorText(i18n, code) }).toEqual({
				code,
				text: expect.stringMatching(/\S/),
			})
		}
	})
})
