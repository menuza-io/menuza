import { z } from 'zod'

/**
 * Job postings are public content: a title, a role description, a pay range and
 * a few screening questions. They live in the control plane (ADR 047, decision
 * 8) because the careers pages on Sites render them server side. Nothing here
 * may hold a person's data. Applicants, their answers and notes live in the
 * regional tenant database and only ever refer to a posting by its opaque id.
 */

export const JOB_POSTING_STATUSES = [
	'draft',
	'published',
	'closed',
	'expired',
] as const
export type JobPostingStatus = (typeof JOB_POSTING_STATUSES)[number]

export const JOB_EMPLOYMENT_TYPES = [
	'full_time',
	'part_time',
	'seasonal',
	'temporary',
	'contract',
	'internship',
] as const
export type JobEmploymentType = (typeof JOB_EMPLOYMENT_TYPES)[number]

/** `none` means the posting shows no pay at all. */
export const JOB_PAY_TYPES = [
	'none',
	'hourly',
	'weekly',
	'monthly',
	'yearly',
] as const
export type JobPayType = (typeof JOB_PAY_TYPES)[number]

export const SCREENER_CATEGORIES = [
	'availability',
	'experience',
	'transport',
	'work_eligibility',
	'certification',
	'language',
	'other',
] as const
export type ScreenerCategory = (typeof SCREENER_CATEGORIES)[number]

export const JOB_POSTING_LIMITS = {
	title: 120,
	positionName: 80,
	descriptionHtml: 20_000,
	/** Smallest description (plain text) that can be published. */
	descriptionMinText: 30,
	questions: 10,
	prompt: 200,
	openAnswerDefault: 500,
	openAnswerMax: 2_000,
	/** Minor units. 1,000,000.00 is far beyond any hourly wage. */
	payMaxMinor: 100_000_000,
	slug: 80,
} as const

/** The evergreen posting every organization is offered by default. */
export const GENERAL_APPLICATION_SLUG = 'general-application'

export const JOB_POSTING_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const questionId = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.regex(/^[A-Za-z0-9_-]+$/)

const prompt = z.string().trim().min(1).max(JOB_POSTING_LIMITS.prompt)

export const yesNoQuestionSchema = z.object({
	id: questionId,
	kind: z.literal('yes_no'),
	prompt,
	category: z.enum(SCREENER_CATEGORIES).default('other'),
	/**
	 * A dealbreaker flags an applicant whose answer differs from
	 * `requiredAnswer`. It never rejects anyone by itself: the manager decides.
	 */
	dealbreaker: z.boolean().default(false),
	requiredAnswer: z.enum(['yes', 'no']).default('yes'),
})

export const openQuestionSchema = z.object({
	id: questionId,
	kind: z.literal('open'),
	prompt,
	required: z.boolean().default(false),
	maxLength: z
		.number()
		.int()
		.min(50)
		.max(JOB_POSTING_LIMITS.openAnswerMax)
		.default(JOB_POSTING_LIMITS.openAnswerDefault),
})

export const screenerQuestionSchema = z.discriminatedUnion('kind', [
	yesNoQuestionSchema,
	openQuestionSchema,
])

export type YesNoQuestion = z.infer<typeof yesNoQuestionSchema>
export type OpenQuestion = z.infer<typeof openQuestionSchema>
export type ScreenerQuestion = z.infer<typeof screenerQuestionSchema>

export const screenerQuestionsSchema = z
	.array(screenerQuestionSchema)
	.max(JOB_POSTING_LIMITS.questions)
	.superRefine((questions, ctx) => {
		const seen = new Set<string>()
		questions.forEach((question, index) => {
			if (seen.has(question.id)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [index, 'id'],
					message: 'Duplicate question id',
				})
			}
			seen.add(question.id)
		})
	})

/**
 * Other-language copy of the parts a job seeker reads. The default language
 * lives in the posting's own fields; this holds only the extra locales, keyed
 * by locale code, so a posting without translations is just its default copy.
 */
export const jobPostingTranslationSchema = z.object({
	title: z.string().trim().max(JOB_POSTING_LIMITS.title).optional(),
	descriptionHtml: z
		.string()
		.max(JOB_POSTING_LIMITS.descriptionHtml * 2)
		.optional(),
	/** Question prompts by question id. */
	prompts: z.record(questionId, prompt.or(z.literal(''))).optional(),
})
export const jobPostingTranslationsSchema = z
	.record(
		z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/),
		jobPostingTranslationSchema,
	)
	.refine((value) => Object.keys(value).length <= 12)
export type JobPostingTranslation = z.infer<typeof jobPostingTranslationSchema>
export type JobPostingTranslations = z.infer<
	typeof jobPostingTranslationsSchema
>

/** Reads stored JSON defensively: bad rows read as no translations. */
export function parseJobPostingTranslations(
	value: unknown,
): JobPostingTranslations {
	const parsed = jobPostingTranslationsSchema.safeParse(value ?? {})
	return parsed.success ? parsed.data : {}
}

/** Translations for `locale`: the exact code, else its language ("ar-SA" → "ar"). */
function translationFor(
	translations: JobPostingTranslations,
	locale: string | null | undefined,
): JobPostingTranslation | undefined {
	if (!locale) return undefined
	return translations[locale] ?? translations[locale.split('-')[0] ?? '']
}

/**
 * A posting as a visitor reading `locale` should see it. Anything not
 * translated falls back to the default copy, so a half-translated posting never
 * shows a blank.
 */
export function localizeJobPosting<
	T extends {
		title: string
		descriptionHtml: string
		questions: ScreenerQuestion[]
	},
>(
	posting: T,
	translations: JobPostingTranslations,
	locale: string | null | undefined,
	defaultLocale: string,
): T {
	const language = locale?.split('-')[0]
	if (
		!locale ||
		locale === defaultLocale ||
		language === defaultLocale.split('-')[0]
	) {
		return posting
	}
	const translation = translationFor(translations, locale)
	if (!translation) return posting
	return {
		...posting,
		title: translation.title?.trim() || posting.title,
		descriptionHtml: translation.descriptionHtml?.trim()
			? translation.descriptionHtml
			: posting.descriptionHtml,
		questions: posting.questions.map((question) => ({
			...question,
			prompt: translation.prompts?.[question.id]?.trim() || question.prompt,
		})),
	}
}

/** Reads stored JSON defensively: bad rows read as no questions, never throw. */
export function parseScreenerQuestions(value: unknown): ScreenerQuestion[] {
	const parsed = screenerQuestionsSchema.safeParse(value)
	return parsed.success ? parsed.data : []
}

/**
 * What a job seeker is allowed to see of a question. Which answer is the
 * dealbreaker stays private so nobody can read the "right" answers off the
 * page.
 */
export type PublicScreenerQuestion =
	| {
			id: string
			kind: 'yes_no'
			prompt: string
			category: ScreenerCategory
	  }
	| {
			id: string
			kind: 'open'
			prompt: string
			required: boolean
			maxLength: number
	  }

export function toPublicQuestion(
	question: ScreenerQuestion,
): PublicScreenerQuestion {
	if (question.kind === 'yes_no') {
		return {
			id: question.id,
			kind: 'yes_no',
			prompt: question.prompt,
			category: question.category,
		}
	}
	return {
		id: question.id,
		kind: 'open',
		prompt: question.prompt,
		required: question.required,
		maxLength: question.maxLength,
	}
}

/** ISO 4217 code, upper case. */
const currencySchema = z.string().regex(/^[A-Z]{3}$/)

const payAmount = z.number().int().min(0).max(JOB_POSTING_LIMITS.payMaxMinor)

/**
 * The editable fields of a posting, as the editor submits them. Status and
 * timestamps are never accepted from a form: they change only through the
 * publish, close and reopen actions.
 */
export const jobPostingContentSchema = z
	.object({
		title: z.string().trim().min(3).max(JOB_POSTING_LIMITS.title),
		positionName: z.string().trim().min(2).max(JOB_POSTING_LIMITS.positionName),
		employmentType: z.enum(JOB_EMPLOYMENT_TYPES),
		payType: z.enum(JOB_PAY_TYPES).default('none'),
		payMinMinor: payAmount.nullable().default(null),
		payMaxMinor: payAmount.nullable().default(null),
		currency: currencySchema.default('USD'),
		descriptionHtml: z.string().max(JOB_POSTING_LIMITS.descriptionHtml * 2),
		questions: screenerQuestionsSchema.default([]),
		/** Other-language copy of the title, description and question prompts. */
		translations: jobPostingTranslationsSchema.default({}),
		/** Last day the posting is open, `YYYY-MM-DD`; `null` means no end. */
		closesOn: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.nullable()
			.default(null),
	})
	.superRefine((value, ctx) => {
		if (value.payType === 'none') return
		const { payMinMinor: min, payMaxMinor: max } = value
		if (min === null && max === null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['payMinMinor'],
				message: 'pay_required',
			})
			return
		}
		if (min !== null && max !== null && min > max) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['payMaxMinor'],
				message: 'pay_range',
			})
		}
	})

export type JobPostingContent = z.infer<typeof jobPostingContentSchema>
export type JobPostingContentInput = z.input<typeof jobPostingContentSchema>

/** A posting with no pay stores no amounts, whatever the form sent. */
export function normalizePay<
	T extends {
		payType: JobPayType
		payMinMinor: number | null
		payMaxMinor: number | null
	},
>(value: T): T {
	if (value.payType === 'none') {
		return { ...value, payMinMinor: null, payMaxMinor: null }
	}
	// A single figure is a fixed rate: keep it in both ends of the range.
	const min = value.payMinMinor ?? value.payMaxMinor
	const max = value.payMaxMinor ?? value.payMinMinor
	return { ...value, payMinMinor: min, payMaxMinor: max }
}

/** The end of the chosen day (UTC), the instant a posting stops being open. */
export function closesOnToDate(closesOn: string | null): Date | null {
	if (!closesOn) return null
	const date = new Date(`${closesOn}T23:59:59.999Z`)
	return Number.isNaN(date.getTime()) ? null : date
}

export function dateToClosesOn(date: Date | null | undefined): string | null {
	if (!date || Number.isNaN(date.getTime())) return null
	return date.toISOString().slice(0, 10)
}

/** Plain text of an HTML fragment, for length checks and summaries. */
export function htmlToPlainText(html: string): string {
	return html
		.replace(/<\s*br\s*\/?>/gi, ' ')
		.replace(/<\/(p|li|h[1-6]|ul|ol)>/gi, ' ')
		.replace(/<[^>]*>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim()
}

export type JobPostingPublishError =
	'title' | 'description' | 'pay' | 'closes_on_past'

/**
 * Why a posting cannot go live yet. A draft may be saved half done; going live
 * needs a real description and, when pay is shown, a usable range.
 */
export function getJobPostingPublishErrors(
	posting: {
		title: string
		descriptionHtml: string
		payType: JobPayType
		payMinMinor: number | null
		payMaxMinor: number | null
		expiresAt: Date | null
	},
	now: Date = new Date(),
): JobPostingPublishError[] {
	const errors: JobPostingPublishError[] = []
	if (posting.title.trim().length < 3) errors.push('title')
	if (
		htmlToPlainText(posting.descriptionHtml).length <
		JOB_POSTING_LIMITS.descriptionMinText
	) {
		errors.push('description')
	}
	if (
		posting.payType !== 'none' &&
		posting.payMinMinor === null &&
		posting.payMaxMinor === null
	) {
		errors.push('pay')
	}
	if (posting.expiresAt && posting.expiresAt.getTime() <= now.getTime()) {
		errors.push('closes_on_past')
	}
	return errors
}

/**
 * Lifecycle. A draft publishes. A live posting closes by hand or expires by
 * itself. A closed or expired posting can be reopened (the editor asks for a
 * new closing date when the old one has passed). Drafts are never closed.
 */
export const JOB_POSTING_TRANSITIONS: Record<
	JobPostingStatus,
	readonly JobPostingStatus[]
> = {
	draft: ['published'],
	published: ['closed', 'expired'],
	closed: ['published'],
	expired: ['published'],
}

export function canTransitionJobPosting(
	from: JobPostingStatus,
	to: JobPostingStatus,
): boolean {
	return JOB_POSTING_TRANSITIONS[from].includes(to)
}

/** A published posting whose end date has passed is expired, job or not. */
export function effectiveJobPostingStatus(
	posting: { status: string; expiresAt: Date | null },
	now: Date = new Date(),
): JobPostingStatus {
	const status = (JOB_POSTING_STATUSES as readonly string[]).includes(
		posting.status,
	)
		? (posting.status as JobPostingStatus)
		: 'draft'
	if (
		status === 'published' &&
		posting.expiresAt &&
		posting.expiresAt.getTime() <= now.getTime()
	) {
		return 'expired'
	}
	return status
}

export function isJobPostingLive(
	posting: { status: string; expiresAt: Date | null },
	now: Date = new Date(),
): boolean {
	return effectiveJobPostingStatus(posting, now) === 'published'
}

/** `Line cook!` becomes `line-cook`. Non-Latin titles fall back to `job`. */
export function slugifyJobTitle(title: string): string {
	const slug = title
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, JOB_POSTING_LIMITS.slug)
		.replace(/-+$/g, '')
	return slug || 'job'
}

/** First free slug: `line-cook`, then `line-cook-2`, `line-cook-3`. */
export function uniqueJobPostingSlug(
	base: string,
	taken: ReadonlySet<string>,
): string {
	const root = slugifyJobTitle(base)
	if (!taken.has(root)) return root
	for (let n = 2; n < 1000; n += 1) {
		const suffix = `-${n}`
		const candidate = `${root.slice(0, JOB_POSTING_LIMITS.slug - suffix.length)}${suffix}`
		if (!taken.has(candidate)) return candidate
	}
	return `${root.slice(0, 60)}-${Date.now().toString(36)}`
}

export function isValidJobPostingSlug(slug: string): boolean {
	return (
		slug.length > 0 &&
		slug.length <= JOB_POSTING_LIMITS.slug &&
		JOB_POSTING_SLUG_PATTERN.test(slug)
	)
}

/**
 * The description every organization is offered by default: a standing posting
 * that collects applications whether or not a role is open.
 */
export const GENERAL_APPLICATION_DEFAULTS = {
	title: 'General application',
	positionName: 'Any role',
	employmentType: 'part_time',
	descriptionHtml:
		'<p>We are always glad to meet people who love food and hospitality. Tell us a little about yourself and when you can work, and we will be in touch when a role opens up that suits you.</p>',
	questions: [
		{
			id: 'availability',
			kind: 'yes_no',
			prompt: 'Are you able to work evenings and weekends?',
			category: 'availability',
			dealbreaker: false,
			requiredAnswer: 'yes',
		},
		{
			id: 'about',
			kind: 'open',
			prompt: 'Tell us a little about your experience.',
			required: false,
			maxLength: JOB_POSTING_LIMITS.openAnswerDefault,
		},
	],
} as const satisfies {
	title: string
	positionName: string
	employmentType: JobEmploymentType
	descriptionHtml: string
	questions: ScreenerQuestion[]
}

/**
 * The same allow-list the App applies when a description is saved and Sites
 * applies again when it renders one, so neither side trusts the other. Links
 * are the only attribute that survives, limited to safe schemes. There are no
 * images, styles or scripts.
 */
export const JOB_DESCRIPTION_ALLOWED_TAGS = [
	'p',
	'br',
	'strong',
	'b',
	'em',
	'i',
	'u',
	'ul',
	'ol',
	'li',
	'h2',
	'h3',
	'a',
] as const

export const JOB_DESCRIPTION_ALLOWED_SCHEMES = [
	'http',
	'https',
	'mailto',
	'tel',
] as const

/**
 * `sanitize-html` options shared by the App (on write) and Sites (on render).
 * Headings above the second level fold into the two sizes the pages style, and
 * every link opens in a new tab with `noopener noreferrer nofollow`.
 */
export const JOB_DESCRIPTION_SANITIZE_OPTIONS = {
	allowedTags: [...JOB_DESCRIPTION_ALLOWED_TAGS],
	allowedAttributes: { a: ['href', 'target', 'rel'] },
	allowedSchemes: [...JOB_DESCRIPTION_ALLOWED_SCHEMES],
	allowProtocolRelative: false,
	transformTags: {
		h1: 'h2',
		h4: 'h3',
		h5: 'h3',
		h6: 'h3',
		a: (tagName: string, attribs: Record<string, string>) => {
			const next: Record<string, string> = {}
			if (attribs.href) next.href = attribs.href
			next.target = '_blank'
			next.rel = 'noopener noreferrer nofollow'
			return { tagName, attribs: next }
		},
	},
}

/** Plain-text fields: no markup survives. */
export function stripMarkup(value: string): string {
	return Array.from(value.replace(/<[^>]*>/g, ''))
		.filter((char) => {
			const code = char.charCodeAt(0)
			return code >= 32 || code === 9 || code === 10 || code === 13
		})
		.join('')
		.trim()
}

// ---------------------------------------------------------------------------
// Public projection (what the careers pages and the public JSON route carry)
// ---------------------------------------------------------------------------

export type PublicJobPosting = {
	slug: string
	title: string
	positionName: string
	employmentType: JobEmploymentType
	payType: JobPayType
	payMinMinor: number | null
	payMaxMinor: number | null
	currency: string
	descriptionHtml: string
	questions: PublicScreenerQuestion[]
	isGeneral: boolean
	datePosted: string
	validThrough: string | null
}

export type PublicJobPostingListItem = Omit<
	PublicJobPosting,
	'descriptionHtml' | 'questions'
>

// ---------------------------------------------------------------------------
// Pay display
// ---------------------------------------------------------------------------

/** Whole minor units to a decimal amount (every supported currency uses 2). */
export function minorToAmount(minor: number): number {
	return minor / 100
}

export type PayRangeParts = {
	period: Exclude<JobPayType, 'none'>
	min: number
	max: number
	currency: string
} | null

/** The numbers behind a pay line; the caller formats and translates. */
export function getPayRange(posting: {
	payType: JobPayType
	payMinMinor: number | null
	payMaxMinor: number | null
	currency: string
}): PayRangeParts {
	if (posting.payType === 'none') return null
	const min = posting.payMinMinor ?? posting.payMaxMinor
	const max = posting.payMaxMinor ?? posting.payMinMinor
	if (min === null || max === null) return null
	return {
		period: posting.payType,
		min: minorToAmount(Math.min(min, max)),
		max: minorToAmount(Math.max(min, max)),
		currency: posting.currency,
	}
}

// ---------------------------------------------------------------------------
// Structured data (schema.org JobPosting)
// ---------------------------------------------------------------------------

const SCHEMA_EMPLOYMENT_TYPE: Record<JobEmploymentType, string> = {
	full_time: 'FULL_TIME',
	part_time: 'PART_TIME',
	seasonal: 'TEMPORARY',
	temporary: 'TEMPORARY',
	contract: 'CONTRACTOR',
	internship: 'INTERN',
}

const SCHEMA_PAY_UNIT: Record<Exclude<JobPayType, 'none'>, string> = {
	hourly: 'HOUR',
	weekly: 'WEEK',
	monthly: 'MONTH',
	yearly: 'YEAR',
}

/**
 * schema.org `JobPosting` for search engines. Everything here is already
 * public on the page. The description is the sanitized HTML. Pay is included
 * only when the posting shows it. A vertical that knows where the job is can
 * add the schema.org place of the job to the returned object.
 */
export function buildJobPostingJsonLd(input: {
	posting: PublicJobPosting
	organization: { name: string; url: string; logoUrl?: string | null }
	url: string
	inLanguage?: string
	/**
	 * Whether the page lets a person apply on the page itself. Search engines
	 * show an "apply" affordance for it, so it stays false until the page really
	 * has an application form.
	 */
	directApply?: boolean
}): Record<string, unknown> {
	const { posting, organization } = input
	const data: Record<string, unknown> = {
		'@context': 'https://schema.org',
		'@type': 'JobPosting',
		title: posting.title,
		description: posting.descriptionHtml,
		datePosted: posting.datePosted,
		employmentType: SCHEMA_EMPLOYMENT_TYPE[posting.employmentType],
		directApply: input.directApply === true,
		url: input.url,
		identifier: {
			'@type': 'PropertyValue',
			name: organization.name,
			value: posting.slug,
		},
		hiringOrganization: {
			'@type': 'Organization',
			name: organization.name,
			sameAs: organization.url,
			...(organization.logoUrl ? { logo: organization.logoUrl } : {}),
		},
	}
	if (input.inLanguage) data.inLanguage = input.inLanguage
	if (posting.validThrough) data.validThrough = posting.validThrough

	const range = getPayRange(posting)
	if (range) {
		data.baseSalary = {
			'@type': 'MonetaryAmount',
			currency: range.currency,
			value: {
				'@type': 'QuantitativeValue',
				...(range.min === range.max
					? { value: range.min }
					: { minValue: range.min, maxValue: range.max }),
				unitText: SCHEMA_PAY_UNIT[range.period],
			},
		}
	}

	return data
}

/**
 * JSON for a `<script type="application/ld+json">` element. `<` is escaped so
 * a description can never close the tag early.
 */
export function serializeJsonLd(data: unknown): string {
	return JSON.stringify(data)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029')
}
