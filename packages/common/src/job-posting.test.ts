import { describe, expect, it } from 'vitest'
import {
	buildJobPostingJsonLd,
	canTransitionJobPosting,
	closesOnToDate,
	effectiveJobPostingStatus,
	GENERAL_APPLICATION_DEFAULTS,
	getJobPostingPublishErrors,
	getPayRange,
	htmlToPlainText,
	isValidJobPostingSlug,
	localizeJobPosting,
	jobPostingContentSchema,
	normalizePay,
	parseJobPostingTranslations,
	parseScreenerQuestions,
	screenerQuestionsSchema,
	serializeJsonLd,
	slugifyJobTitle,
	stripMarkup,
	toPublicQuestion,
	uniqueJobPostingSlug,
	type PublicJobPosting,
} from './job-posting.ts'

const NOW = new Date('2026-10-13T12:00:00Z')

const base = {
	title: 'Line cook',
	positionName: 'Cook',
	employmentType: 'full_time' as const,
	descriptionHtml: '<p>Work the counter during busy hours.</p>',
}

describe('jobPostingContentSchema', () => {
	it('accepts a minimal posting and fills defaults', () => {
		const parsed = jobPostingContentSchema.parse(base)
		expect(parsed.payType).toBe('none')
		expect(parsed.questions).toEqual([])
		expect(parsed.closesOn).toBeNull()
		expect(parsed.locationId).toBeNull()
		expect(parsed.locationIds).toEqual([])
	})

	it('rejects a short title, an unknown employment type and a bad date', () => {
		expect(
			jobPostingContentSchema.safeParse({ ...base, title: 'ab' }).success,
		).toBe(false)
		expect(
			jobPostingContentSchema.safeParse({ ...base, employmentType: 'gig' })
				.success,
		).toBe(false)
		expect(
			jobPostingContentSchema.safeParse({ ...base, closesOn: '13/10/2026' })
				.success,
		).toBe(false)
	})

	it('requires pay figures when pay is shown and orders the range', () => {
		const none = jobPostingContentSchema.safeParse({
			...base,
			payType: 'hourly',
		})
		expect(none.success).toBe(false)
		const inverted = jobPostingContentSchema.safeParse({
			...base,
			payType: 'hourly',
			payMinMinor: 2500,
			payMaxMinor: 1500,
		})
		expect(inverted.success).toBe(false)
		expect(
			jobPostingContentSchema.safeParse({
				...base,
				payType: 'hourly',
				payMinMinor: 1500,
				payMaxMinor: 2500,
			}).success,
		).toBe(true)
	})

	it('rejects non-integer, negative and absurd pay, and unknown currencies', () => {
		for (const payMinMinor of [15.5, -1, 1e12]) {
			expect(
				jobPostingContentSchema.safeParse({
					...base,
					payType: 'hourly',
					payMinMinor,
				}).success,
			).toBe(false)
		}
		expect(
			jobPostingContentSchema.safeParse({ ...base, currency: 'usd' }).success,
		).toBe(false)
	})
})

describe('normalizePay', () => {
	it('drops amounts when no pay is shown', () => {
		expect(
			normalizePay({ payType: 'none', payMinMinor: 100, payMaxMinor: 200 }),
		).toEqual({ payType: 'none', payMinMinor: null, payMaxMinor: null })
	})

	it('treats a single figure as a fixed rate', () => {
		expect(
			normalizePay({ payType: 'hourly', payMinMinor: 1800, payMaxMinor: null }),
		).toEqual({ payType: 'hourly', payMinMinor: 1800, payMaxMinor: 1800 })
		expect(
			normalizePay({ payType: 'hourly', payMinMinor: null, payMaxMinor: 2000 }),
		).toEqual({ payType: 'hourly', payMinMinor: 2000, payMaxMinor: 2000 })
	})
})

describe('screener questions', () => {
	const yesNo = {
		id: 'weekends',
		kind: 'yes_no',
		prompt: 'Can you work weekends?',
		category: 'availability',
		dealbreaker: true,
		requiredAnswer: 'yes',
	}
	const open = { id: 'about', kind: 'open', prompt: 'Tell us about you' }

	it('accepts yes/no dealbreakers and open questions with defaults', () => {
		const parsed = screenerQuestionsSchema.parse([yesNo, open])
		expect(parsed[1]).toMatchObject({
			kind: 'open',
			required: false,
			maxLength: 500,
		})
	})

	it('rejects duplicate ids, unknown kinds, empty prompts and too many questions', () => {
		expect(screenerQuestionsSchema.safeParse([yesNo, yesNo]).success).toBe(
			false,
		)
		expect(
			screenerQuestionsSchema.safeParse([{ ...yesNo, kind: 'file' }]).success,
		).toBe(false)
		expect(
			screenerQuestionsSchema.safeParse([{ ...yesNo, prompt: '   ' }]).success,
		).toBe(false)
		const many = Array.from({ length: 11 }, (ignored, i) => ({
			...open,
			id: `q${i}`,
		}))
		expect(screenerQuestionsSchema.safeParse(many).success).toBe(false)
	})

	it('rejects ids that could break out of a form field name', () => {
		expect(
			screenerQuestionsSchema.safeParse([{ ...open, id: 'a b<script>' }])
				.success,
		).toBe(false)
	})

	it('never reveals the dealbreaker or the required answer publicly', () => {
		const [question] = screenerQuestionsSchema.parse([yesNo])
		const publicQuestion = toPublicQuestion(question!)
		expect(publicQuestion).toEqual({
			id: 'weekends',
			kind: 'yes_no',
			prompt: 'Can you work weekends?',
			category: 'availability',
		})
		expect(JSON.stringify(publicQuestion)).not.toMatch(
			/dealbreaker|requiredAnswer/,
		)
	})

	it('reads corrupt stored JSON as no questions instead of throwing', () => {
		expect(parseScreenerQuestions('nope')).toEqual([])
		expect(parseScreenerQuestions([{ kind: 'yes_no' }])).toEqual([])
		expect(parseScreenerQuestions(null)).toEqual([])
	})

	it('ships a valid general application', () => {
		expect(
			screenerQuestionsSchema.safeParse(GENERAL_APPLICATION_DEFAULTS.questions)
				.success,
		).toBe(true)
	})
})

describe('publishing rules', () => {
	const posting = {
		...base,
		payType: 'none' as const,
		payMinMinor: null,
		payMaxMinor: null,
		expiresAt: null,
	}

	it('allows a complete posting', () => {
		expect(getJobPostingPublishErrors(posting, NOW)).toEqual([])
	})

	it('names every problem', () => {
		expect(
			getJobPostingPublishErrors(
				{
					...posting,
					title: 'x',
					descriptionHtml: '<p> </p>',
					payType: 'hourly',
					expiresAt: new Date('2026-10-01T00:00:00Z'),
				},
				NOW,
			),
		).toEqual(['title', 'description', 'pay', 'closes_on_past'])
	})

	it('does not count markup toward the description length', () => {
		expect(
			getJobPostingPublishErrors(
				{ ...posting, descriptionHtml: '<p><strong></strong></p><br/>' },
				NOW,
			),
		).toContain('description')
	})
})

describe('status', () => {
	it('allows only the lifecycle moves', () => {
		expect(canTransitionJobPosting('draft', 'published')).toBe(true)
		expect(canTransitionJobPosting('draft', 'closed')).toBe(false)
		expect(canTransitionJobPosting('published', 'closed')).toBe(true)
		expect(canTransitionJobPosting('closed', 'published')).toBe(true)
		expect(canTransitionJobPosting('expired', 'closed')).toBe(false)
		expect(canTransitionJobPosting('published', 'draft')).toBe(false)
	})

	it('reads a published posting past its end date as expired', () => {
		const past = new Date('2026-10-12T00:00:00Z')
		expect(
			effectiveJobPostingStatus({ status: 'published', expiresAt: past }, NOW),
		).toBe('expired')
		expect(
			effectiveJobPostingStatus({ status: 'published', expiresAt: null }, NOW),
		).toBe('published')
		expect(
			effectiveJobPostingStatus({ status: 'closed', expiresAt: past }, NOW),
		).toBe('closed')
		expect(
			effectiveJobPostingStatus({ status: 'bogus', expiresAt: null }, NOW),
		).toBe('draft')
	})

	it('closes at the end of the chosen day', () => {
		expect(closesOnToDate('2026-10-31')?.toISOString()).toBe(
			'2026-10-31T23:59:59.999Z',
		)
		expect(closesOnToDate(null)).toBeNull()
		expect(closesOnToDate('2026-13-45')).toBeNull()
	})
})

describe('slugs', () => {
	it('builds ascii slugs and falls back for other scripts', () => {
		expect(slugifyJobTitle('Line Cook (Evenings)!')).toBe('line-cook-evenings')
		expect(slugifyJobTitle('Café Barista')).toBe('cafe-barista')
		expect(slugifyJobTitle('طباخ')).toBe('job')
		expect(slugifyJobTitle('   ')).toBe('job')
	})

	it('suffixes a taken slug', () => {
		expect(uniqueJobPostingSlug('Line cook', new Set())).toBe('line-cook')
		expect(
			uniqueJobPostingSlug('Line cook', new Set(['line-cook', 'line-cook-2'])),
		).toBe('line-cook-3')
	})

	it('validates slugs strictly', () => {
		expect(isValidJobPostingSlug('line-cook')).toBe(true)
		for (const bad of ['', 'Line', 'a--b', '-a', 'a/b', '../x', 'a b'])
			expect(isValidJobPostingSlug(bad)).toBe(false)
	})
})

describe('text helpers', () => {
	it('strips markup and control characters from plain text', () => {
		expect(stripMarkup('<b>Cook</b>\u0000 now')).toBe('Cook now')
	})

	it('reads plain text out of html', () => {
		expect(
			htmlToPlainText('<p>Hello&nbsp;<b>world</b></p><ul><li>a</li></ul>'),
		).toBe('Hello world a')
	})
})

describe('structured data', () => {
	const posting: PublicJobPosting = {
		slug: 'line-cook',
		title: 'Line cook',
		positionName: 'Cook',
		employmentType: 'seasonal',
		payType: 'hourly',
		payMinMinor: 1800,
		payMaxMinor: 2200,
		currency: 'USD',
		descriptionHtml: '<p>Cook.</p>',
		questions: [],
		allLocations: false,
		locations: [
			{
				id: 'loc1',
				name: 'Downtown',
				city: 'Austin',
				region: 'TX',
				postalCode: '78701',
				country: 'United States',
				streetAddress: '1 Main St',
			},
		],
		isGeneral: false,
		datePosted: '2026-10-01T00:00:00.000Z',
		validThrough: '2026-11-01T23:59:59.999Z',
	}
	const input = {
		posting,
		organization: { name: 'Acme Diner', url: 'https://acme.example' },
		url: 'https://acme.example/careers/line-cook',
	}

	it('marks up pay, place and validity', () => {
		const data = buildJobPostingJsonLd(input) as any
		expect(data['@type']).toBe('JobPosting')
		expect(data.employmentType).toBe('TEMPORARY')
		expect(data.validThrough).toBe(posting.validThrough)
		expect(data.baseSalary.value).toEqual({
			'@type': 'QuantitativeValue',
			minValue: 18,
			maxValue: 22,
			unitText: 'HOUR',
		})
		expect(data.jobLocation.address).toMatchObject({
			addressLocality: 'Austin',
			addressCountry: 'US',
		})
	})

	it('claims direct apply only when the page has an application form', () => {
		expect((buildJobPostingJsonLd(input) as any).directApply).toBe(false)
		expect(
			(buildJobPostingJsonLd({ ...input, directApply: true }) as any)
				.directApply,
		).toBe(true)
	})

	it('omits pay, place and expiry the posting does not have', () => {
		const data = buildJobPostingJsonLd({
			...input,
			posting: {
				...posting,
				payType: 'none',
				payMinMinor: null,
				payMaxMinor: null,
				locations: [],
				allLocations: true,
				validThrough: null,
			},
		}) as any
		expect(data.baseSalary).toBeUndefined()
		expect(data.jobLocation).toBeUndefined()
		expect(data.validThrough).toBeUndefined()
	})

	it('lists every place when the job is open at several', () => {
		const data = buildJobPostingJsonLd({
			...input,
			posting: {
				...posting,
				locations: [
					posting.locations[0]!,
					{ ...posting.locations[0]!, id: 'loc2', name: 'Airport' },
				],
			},
		}) as any
		expect(data.jobLocation.map((place: any) => place.name)).toEqual([
			'Downtown',
			'Airport',
		])
	})

	it('uses one value for a fixed rate', () => {
		const range = getPayRange({
			payType: 'monthly',
			payMinMinor: 500000,
			payMaxMinor: 500000,
			currency: 'SAR',
		})
		expect(range).toEqual({
			period: 'monthly',
			min: 5000,
			max: 5000,
			currency: 'SAR',
		})
		const data = buildJobPostingJsonLd({
			...input,
			posting: {
				...posting,
				payType: 'monthly',
				payMinMinor: 500000,
				payMaxMinor: 500000,
				currency: 'SAR',
				locations: [{ ...posting.locations[0]!, country: null }],
			},
		}) as any
		expect(data.baseSalary.value.value).toBe(5000)
		expect(data.jobLocation.address.addressCountry).toBe('SA')
	})

	it('cannot be broken out of a script tag', () => {
		const json = serializeJsonLd({ d: '</script><script>alert(1)</script>' })
		expect(json).not.toContain('</script>')
		expect(json).not.toContain('<')
		expect(JSON.parse(json).d).toBe('</script><script>alert(1)</script>')
	})
})

describe('localizeJobPosting', () => {
	const posting = {
		title: 'Line cook',
		descriptionHtml: '<p>Cook on the line.</p>',
		questions: [
			{
				id: 'a',
				kind: 'open' as const,
				prompt: 'Why us?',
				required: false,
				maxLength: 500,
			},
			{
				id: 'b',
				kind: 'open' as const,
				prompt: 'Anything else?',
				required: false,
				maxLength: 500,
			},
		],
	}
	const translations = {
		ar: { title: 'طباخ', prompts: { a: 'لماذا نحن؟' } },
	}

	it('returns the default copy for the default language', () => {
		expect(localizeJobPosting(posting, translations, 'en', 'en')).toBe(posting)
		expect(localizeJobPosting(posting, translations, null, 'en')).toBe(posting)
	})

	it('uses a translation, matching the language of a regional code', () => {
		const result = localizeJobPosting(posting, translations, 'ar-SA', 'en')
		expect(result.title).toBe('طباخ')
		// Missing parts fall back to the default copy, never blank.
		expect(result.descriptionHtml).toBe(posting.descriptionHtml)
		expect(result.questions.map((q) => q.prompt)).toEqual([
			'لماذا نحن؟',
			'Anything else?',
		])
	})

	it('falls back to the default for a language with no translation', () => {
		expect(localizeJobPosting(posting, translations, 'fr', 'en')).toBe(posting)
	})

	it('reads bad stored translations as none', () => {
		expect(parseJobPostingTranslations('nope')).toEqual({})
		expect(
			parseJobPostingTranslations({ 'not a locale!': { title: 'x' } }),
		).toEqual({})
		expect(parseJobPostingTranslations(null)).toEqual({})
	})
})
