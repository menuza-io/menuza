import { describe, expect, it } from 'vitest'
import {
	buildLegalDocument,
	defaultConsentMode,
	diffLines,
	EMPTY_LEGAL_FEATURES,
	LEGAL_COPY,
	LEGAL_KINDS,
	LEGAL_LOCALES,
	legalDocumentText,
	legalRegionFor,
	regionOfCountry,
	type LegalContext,
} from './index.ts'

const SITE_LANGUAGES = ['en', 'ar', 'es', 'fr', 'de', 'zh']

const base: LegalContext = {
	name: 'Acme Kitchen',
	legalName: 'Acme Kitchen LLC',
	email: 'hello@acme.example',
	phone: '+1 555 0100',
	address: '1 Main Street, Springfield',
	region: 'us',
	date: '2026-12-01',
	features: { ...EMPTY_LEGAL_FEATURES },
	trackingTags: [],
	paymentProviders: [],
	refundText: '',
	reservationText: '',
	hasEmbeds: false,
	hasPdfMenu: false,
}

const placeholders = (text: string) =>
	[...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()

describe('legal copy', () => {
	it('exists for every site language', () => {
		expect([...LEGAL_LOCALES].sort()).toEqual([...SITE_LANGUAGES].sort())
	})

	it('has exactly the keys of English, none empty, with the same placeholders', () => {
		const english = LEGAL_COPY.en!
		for (const locale of SITE_LANGUAGES) {
			const copy = LEGAL_COPY[locale]!
			expect(Object.keys(copy).sort(), locale).toEqual(
				Object.keys(english).sort(),
			)
			for (const [key, value] of Object.entries(copy)) {
				expect(value.trim().length, `${locale} ${key}`).toBeGreaterThan(0)
				expect(placeholders(value), `${locale} ${key}`).toEqual(
					placeholders(english[key]!),
				)
			}
		}
	})
})

describe('buildLegalDocument', () => {
	it('builds every kind in every site language with the restaurant’s details', () => {
		for (const locale of SITE_LANGUAGES) {
			for (const kind of LEGAL_KINDS) {
				const result = buildLegalDocument(kind, locale, base)
				expect(result.ok, `${kind} ${locale}`).toBe(true)
				if (!result.ok) continue
				const text = legalDocumentText(result.document)
				expect(result.document.title.length).toBeGreaterThan(0)
				expect(result.document.sections.length).toBeGreaterThan(2)
				// The restaurant's own details are in it, nothing left unfilled.
				expect(text).toContain('hello@acme.example')
				expect(text).not.toMatch(/\{\w+\}/)
				expect(text).toContain('Acme Kitchen')
				for (const section of result.document.sections) {
					expect(section.heading.trim()).not.toBe('')
					expect(section.paragraphs.length).toBeGreaterThan(0)
				}
			}
		}
	})

	it('the contact line carries email, phone and address', () => {
		const result = buildLegalDocument('privacy', 'en', base)
		const text = result.ok ? legalDocumentText(result.document) : ''
		expect(text).toContain('Email: hello@acme.example')
		expect(text).toContain('Phone: +1 555 0100')
		expect(text).toContain('Address: 1 Main Street, Springfield')
		const arabic = buildLegalDocument('privacy', 'ar', base)
		expect(arabic.ok && legalDocumentText(arabic.document)).toContain(
			'البريد الإلكتروني: hello@acme.example',
		)
	})

	it('refuses without an email, and the accessibility statement without a phone', () => {
		expect(buildLegalDocument('privacy', 'en', { ...base, email: '' })).toEqual(
			{
				ok: false,
				missing: ['email'],
			},
		)
		expect(
			buildLegalDocument('accessibility', 'en', { ...base, phone: ' ' }),
		).toEqual({ ok: false, missing: ['phone'] })
		expect(
			buildLegalDocument('accessibility', 'en', {
				...base,
				email: '',
				phone: '',
			}),
		).toEqual({ ok: false, missing: ['email', 'phone'] })
		// Privacy does not need a phone.
		expect(buildLegalDocument('privacy', 'en', { ...base, phone: '' }).ok).toBe(
			true,
		)
	})

	it('adds sections for the features that are on, and none for those that are off', () => {
		const terms = (features: Partial<LegalContext['features']>, extra = {}) => {
			const result = buildLegalDocument('terms', 'en', {
				...base,
				features: { ...base.features, ...features },
				...extra,
			})
			return result.ok ? legalDocumentText(result.document) : ''
		}
		const plain = terms({ reservations: false, loyalty: false })
		expect(plain).not.toContain('Bookings')
		expect(plain).not.toContain('Rewards')
		const withBoth = terms({
			reservations: true,
			reservationDeposits: true,
			loyalty: true,
			giftCards: true,
			delivery: true,
		})
		expect(withBoth).toContain('Bookings')
		expect(withBoth).toContain('deposit or card hold')
		expect(withBoth).toContain('Rewards')
		expect(withBoth).toContain('Gift cards')
		expect(withBoth).toContain('Delivery')
		// Deposits text only with deposits on.
		expect(
			terms({ reservations: true, reservationDeposits: false }),
		).not.toContain('deposit or card hold')
		// The operator's own booking terms are included.
		expect(
			terms(
				{ reservations: true },
				{ reservationText: 'No-show fee: 20 USD.' },
			),
		).toContain('No-show fee: 20 USD.')
	})

	it('refund text says "contact the restaurant" unless set', () => {
		const text = (refundText: string) => {
			const result = buildLegalDocument('terms', 'en', { ...base, refundText })
			return result.ok ? legalDocumentText(result.document) : ''
		}
		expect(text('')).toContain(
			'contact the restaurant: Email: hello@acme.example',
		)
		const custom = text('Refunds within 7 days of purchase.')
		expect(custom).toContain('Refunds within 7 days of purchase.')
		expect(custom).not.toContain('contact the restaurant')
	})

	it('names the tracking tags and processors that are in use', () => {
		const result = buildLegalDocument('cookies', 'en', {
			...base,
			trackingTags: ['meta_pixel', 'google_analytics'],
		})
		const text = result.ok ? legalDocumentText(result.document) : ''
		expect(text).toContain('Meta Pixel, Google Analytics')
		const none = buildLegalDocument('cookies', 'en', base)
		expect(none.ok && legalDocumentText(none.document)).toContain(
			'We do not use analytics or advertising cookies.',
		)
		const privacy = buildLegalDocument('privacy', 'en', {
			...base,
			paymentProviders: ['stripe'],
			trackingTags: ['tiktok_pixel'],
		})
		const privacyText = privacy.ok ? legalDocumentText(privacy.document) : ''
		expect(privacyText).toContain('Stripe')
		expect(privacyText).toContain('TikTok Pixel')
	})

	it('the rights section follows the region', () => {
		const rights = (region: LegalContext['region']) => {
			const result = buildLegalDocument('privacy', 'en', { ...base, region })
			return result.ok ? legalDocumentText(result.document) : ''
		}
		expect(rights('ksa')).toContain('PDPL')
		expect(rights('eu')).toContain('data protection authority')
		expect(rights('uk')).toContain('Information Commissioner')
		expect(rights('us')).toContain('opt out of the sale')
	})

	it('the accessibility statement names WCAG 2.2 AA, a phone and email, and known limits', () => {
		const result = buildLegalDocument('accessibility', 'en', {
			...base,
			hasEmbeds: true,
			hasPdfMenu: true,
		})
		const text = result.ok ? legalDocumentText(result.document) : ''
		expect(text).toContain('WCAG) 2.2, level AA')
		expect(text).toContain('Call us at +1 555 0100 or email hello@acme.example')
		expect(text).toContain('booking or video widgets')
		expect(text).toContain('menu is also offered as a PDF')
		// Without embeds or a PDF menu the limits do not mention them.
		const plain = buildLegalDocument('accessibility', 'en', base)
		const plainText = plain.ok ? legalDocumentText(plain.document) : ''
		expect(plainText).not.toContain('video widgets')
		expect(plainText).not.toContain('PDF')
	})

	it('names the phone and email in every language', () => {
		for (const locale of SITE_LANGUAGES) {
			const result = buildLegalDocument('accessibility', locale, base)
			const text = result.ok ? legalDocumentText(result.document) : ''
			expect(text, locale).toContain('+1 555 0100')
			expect(text, locale).toContain('hello@acme.example')
		}
	})
})

describe('regions and consent defaults', () => {
	it('maps countries to a privacy regime', () => {
		expect(regionOfCountry('de')).toBe('eu')
		expect(regionOfCountry('FR')).toBe('eu')
		expect(regionOfCountry('GB')).toBe('uk')
		expect(regionOfCountry('SA')).toBe('ksa')
		expect(regionOfCountry('US')).toBe('us')
		expect(regionOfCountry('BR')).toBe('other')
		expect(regionOfCountry('')).toBeNull()
	})

	it('works the region out from country, data region, address and language', () => {
		expect(legalRegionFor({ country: 'DE' })).toBe('eu')
		expect(legalRegionFor({ dataRegion: 'ksa' })).toBe('ksa')
		expect(legalRegionFor({ address: '12 King Fahd Rd, Riyadh' })).toBe('ksa')
		expect(
			legalRegionFor({ address: '1 High St, London, United Kingdom' }),
		).toBe('uk')
		expect(legalRegionFor({ defaultLocale: 'fr' })).toBe('eu')
		expect(legalRegionFor({ defaultLocale: 'ar' })).toBe('ksa')
		expect(legalRegionFor({ defaultLocale: 'en', dataRegion: 'us' })).toBe('us')
		expect(legalRegionFor({})).toBe('us')
	})

	it('Required for the EU, UK and KSA, Notice only for the US', () => {
		expect(defaultConsentMode('eu')).toBe('required')
		expect(defaultConsentMode('uk')).toBe('required')
		expect(defaultConsentMode('ksa')).toBe('required')
		expect(defaultConsentMode('us')).toBe('notice')
		expect(defaultConsentMode('other')).toBe('required')
	})
})

describe('diffLines', () => {
	it('marks lines kept, removed and added', () => {
		expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
			{ kind: 'same', text: 'a' },
			{ kind: 'removed', text: 'b' },
			{ kind: 'added', text: 'x' },
			{ kind: 'same', text: 'c' },
		])
		expect(diffLines('same', 'same')).toEqual([{ kind: 'same', text: 'same' }])
		expect(diffLines('', 'new').some((l) => l.kind === 'added')).toBe(true)
	})
})
