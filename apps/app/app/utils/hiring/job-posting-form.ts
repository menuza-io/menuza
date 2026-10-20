import {
	getJobPostingPublishErrors,
	JOB_POSTING_LIMITS,
	type JobEmploymentType,
	type JobPayType,
	type JobPostingPublishError,
	type JobPostingTranslations,
	type ScreenerCategory,
	type ScreenerQuestion,
} from '@repo/common/job-posting'
import { STAFFING_CURRENCIES } from '@repo/staffing'
import {
	minorToInput,
	parseMoneyToMinor,
} from '#app/utils/staffing/staff-format.ts'

/** Currencies a job can show pay in: the ones a hire can be paid in. */
export const JOB_CURRENCIES = STAFFING_CURRENCIES

/** The four steps of the editor, in order. */
export const POSTING_STEPS = ['role', 'pay', 'screener', 'review'] as const
export type PostingStep = (typeof POSTING_STEPS)[number]

/**
 * What the editor holds while a manager types: pay as the text of the field,
 * everything else already typed. `toPayload` turns it into what the server
 * validates again (the server never trusts this shape).
 */
export type PostingForm = {
	title: string
	positionName: string
	employmentType: JobEmploymentType
	descriptionHtml: string
	payType: JobPayType
	payMin: string
	payMax: string
	currency: string
	closesOn: string
	questions: ScreenerQuestion[]
	/** Other-language copy; the default language lives in the fields above. */
	translations: JobPostingTranslations
}

export type PostingFormError =
	| 'title_required'
	| 'title_short'
	| 'position_required'
	| 'pay_required'
	| 'pay_invalid'
	| 'pay_range'
	| 'closes_on_invalid'
	| 'closes_on_past'
	| 'prompt_required'

export type PostingFormErrors = Partial<Record<string, PostingFormError>>

export function emptyPostingForm(defaults: { currency: string }): PostingForm {
	return {
		title: '',
		positionName: '',
		employmentType: 'part_time',
		descriptionHtml: '',
		payType: 'none',
		payMin: '',
		payMax: '',
		currency: defaults.currency,
		closesOn: '',
		questions: [],
		translations: {},
	}
}

export function formFromPosting(posting: {
	title: string
	positionName: string
	employmentType: JobEmploymentType
	descriptionHtml: string
	payType: JobPayType
	payMinMinor: number | null
	payMaxMinor: number | null
	currency: string
	closesOn: string | null
	questions: ScreenerQuestion[]
	translations?: JobPostingTranslations
}): PostingForm {
	return {
		title: posting.title,
		positionName: posting.positionName,
		employmentType: posting.employmentType,
		descriptionHtml: posting.descriptionHtml,
		payType: posting.payType,
		payMin: minorToInput(posting.payMinMinor),
		payMax: minorToInput(posting.payMaxMinor),
		currency: posting.currency,
		closesOn: posting.closesOn ?? '',
		questions: posting.questions,
		translations: posting.translations ?? {},
	}
}

/** The JSON the action receives. Money becomes whole minor units. */
export function toPayload(form: PostingForm) {
	const showsPay = form.payType !== 'none'
	return {
		title: form.title.trim(),
		positionName: form.positionName.trim(),
		employmentType: form.employmentType,
		payType: form.payType,
		payMinMinor: showsPay ? parseMoneyToMinor(form.payMin) : null,
		payMaxMinor: showsPay ? parseMoneyToMinor(form.payMax) : null,
		currency: form.currency,
		descriptionHtml: form.descriptionHtml,
		questions: form.questions,
		translations: form.translations,
		closesOn: form.closesOn || null,
	}
}

export function todayIso(now: Date = new Date()) {
	return now.toISOString().slice(0, 10)
}

/** Problems on one step, keyed by field. Empty means the step is complete. */
export function validateStep(
	form: PostingForm,
	step: PostingStep,
	options: { general?: boolean; today?: string } = {},
): PostingFormErrors {
	const errors: PostingFormErrors = {}
	if (step === 'role') {
		const title = form.title.trim()
		if (!title) errors.title = 'title_required'
		else if (title.length < 3) errors.title = 'title_short'
		if (!form.positionName.trim()) errors.positionName = 'position_required'
	}
	if (step === 'pay') {
		if (form.payType !== 'none') {
			const min = form.payMin.trim()
			const max = form.payMax.trim()
			const minMinor = min ? parseMoneyToMinor(min) : null
			const maxMinor = max ? parseMoneyToMinor(max) : null
			if (!min && !max) errors.payMin = 'pay_required'
			if (min && minMinor === null) errors.payMin = 'pay_invalid'
			if (max && maxMinor === null) errors.payMax = 'pay_invalid'
			if (
				minMinor !== null &&
				maxMinor !== null &&
				minMinor > maxMinor &&
				!errors.payMax
			) {
				errors.payMax = 'pay_range'
			}
		}
		if (!options.general && form.closesOn) {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(form.closesOn)) {
				errors.closesOn = 'closes_on_invalid'
			} else if (form.closesOn < (options.today ?? todayIso())) {
				errors.closesOn = 'closes_on_past'
			}
		}
	}
	if (step === 'screener') {
		form.questions.forEach((question) => {
			if (!question.prompt.trim())
				errors[`question:${question.id}`] = 'prompt_required'
		})
	}
	return errors
}

/** The first step that has a problem, or null when every step is complete. */
export function firstInvalidStep(
	form: PostingForm,
	options: { general?: boolean; today?: string } = {},
): PostingStep | null {
	return (
		(['role', 'pay', 'screener'] as const).find(
			(step) => Object.keys(validateStep(form, step, options)).length > 0,
		) ?? null
	)
}

/** What still blocks going live, mapped to the step that fixes it. */
export function publishBlockers(
	form: PostingForm,
	options: { general?: boolean; today?: string } = {},
): Array<{ code: JobPostingPublishError; step: PostingStep }> {
	const payload = toPayload(form)
	const today = options.today ?? todayIso()
	const codes = getJobPostingPublishErrors(
		{
			title: payload.title,
			descriptionHtml: payload.descriptionHtml,
			payType: payload.payType,
			payMinMinor: payload.payMinMinor,
			payMaxMinor: payload.payMaxMinor,
			expiresAt:
				!options.general && payload.closesOn
					? new Date(`${payload.closesOn}T23:59:59.999Z`)
					: null,
		},
		new Date(`${today}T00:00:00.000Z`),
	)
	const step: Record<JobPostingPublishError, PostingStep> = {
		title: 'role',
		description: 'role',
		pay: 'pay',
		closes_on_past: 'pay',
	}
	return codes.map((code) => ({ code, step: step[code] }))
}

let counter = 0
/** A fresh question id that cannot collide with the ones already there. */
export function nextQuestionId(existing: readonly ScreenerQuestion[]) {
	const taken = new Set(existing.map((question) => question.id))
	for (;;) {
		counter += 1
		const id = `q${counter}`
		if (!taken.has(id)) return id
	}
}

export function newYesNoQuestion(
	existing: readonly ScreenerQuestion[],
	category: ScreenerCategory = 'availability',
): ScreenerQuestion {
	return {
		id: nextQuestionId(existing),
		kind: 'yes_no',
		prompt: '',
		category,
		dealbreaker: false,
		requiredAnswer: 'yes',
	}
}

export function newOpenQuestion(
	existing: readonly ScreenerQuestion[],
): ScreenerQuestion {
	return {
		id: nextQuestionId(existing),
		kind: 'open',
		prompt: '',
		required: false,
		maxLength: JOB_POSTING_LIMITS.openAnswerDefault,
	}
}

/** Moves a question one place up or down; out-of-range moves change nothing. */
export function moveQuestion<T>(list: readonly T[], from: number, to: number) {
	if (to < 0 || to >= list.length || from === to) return [...list]
	const next = [...list]
	const [item] = next.splice(from, 1)
	next.splice(to, 0, item!)
	return next
}

// ---------------------------------------------------------------------------
// Other-language copy
// ---------------------------------------------------------------------------

type LocalizedField = 'title' | 'descriptionHtml'

/** The text of a field as the editor shows it for `locale`. */
export function readLocalized(
	form: PostingForm,
	field: LocalizedField,
	locale: string,
	defaultLocale: string,
): string {
	if (locale === defaultLocale) return form[field]
	return form.translations[locale]?.[field] ?? ''
}

/** Writes a field for `locale`: the default language into the posting itself. */
export function writeLocalized(
	form: PostingForm,
	field: LocalizedField,
	value: string,
	locale: string,
	defaultLocale: string,
): PostingForm {
	if (locale === defaultLocale) return { ...form, [field]: value }
	const current = form.translations[locale] ?? {}
	return {
		...form,
		translations: {
			...form.translations,
			[locale]: { ...current, [field]: value },
		},
	}
}

export function readPrompt(
	form: PostingForm,
	question: ScreenerQuestion,
	locale: string,
	defaultLocale: string,
): string {
	if (locale === defaultLocale) return question.prompt
	return form.translations[locale]?.prompts?.[question.id] ?? ''
}

/** Writes a question prompt for `locale`; returns the new questions and translations. */
export function writePrompt(
	form: PostingForm,
	questionId: string,
	value: string,
	locale: string,
	defaultLocale: string,
): PostingForm {
	if (locale === defaultLocale) {
		return {
			...form,
			questions: form.questions.map((question) =>
				question.id === questionId ? { ...question, prompt: value } : question,
			),
		}
	}
	const current = form.translations[locale] ?? {}
	return {
		...form,
		translations: {
			...form.translations,
			[locale]: {
				...current,
				prompts: { ...current.prompts, [questionId]: value },
			},
		},
	}
}

/** How many of the translatable fields a locale already has, for the switcher hint. */
export function translationProgress(
	form: PostingForm,
	locale: string,
): { done: number; total: number } {
	const entry = form.translations[locale]
	const fields: Array<string | undefined> = [
		form.title ? entry?.title : undefined,
		form.descriptionHtml ? entry?.descriptionHtml : undefined,
		...form.questions.map((question) =>
			question.prompt ? entry?.prompts?.[question.id] : undefined,
		),
	]
	const total =
		(form.title ? 1 : 0) +
		(form.descriptionHtml ? 1 : 0) +
		form.questions.filter((question) => question.prompt).length
	return { done: fields.filter((value) => value?.trim()).length, total }
}
