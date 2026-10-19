import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { formatHhmm, parseHhmm } from '@repo/reservations'
import { formatBusinessDate } from '#app/utils/reservations/business-date.ts'
import {
	EXPERIENCE_LOCALES,
	type ExperienceDto,
	type ExperienceInput,
	type ExperienceKind,
	type ExperienceLocale,
	type ExperiencePatch,
	type ExperienceScheduleDto,
	type ExperienceStatus,
	type ScheduleBody,
} from '#app/utils/reservations/experiences-api.ts'
import {
	currencyFractionDigits,
	parseMoneyInput,
} from '#app/utils/reservations/payments-view.ts'
import { minorToInput } from '#app/utils/reservations/policies-view.ts'

export const EXPERIENCE_KIND_LABELS: Record<ExperienceKind, MessageDescriptor> =
	{
		ticketed: msg`Ticketed`,
		prix_fixe: msg`Prix fixe menu`,
	}

export const EXPERIENCE_STATUS_LABELS: Record<
	ExperienceStatus,
	MessageDescriptor
> = {
	draft: msg`Draft`,
	published: msg`Published`,
	archived: msg`Archived`,
}

export const EXPERIENCE_LOCALE_LABELS: Record<
	ExperienceLocale,
	MessageDescriptor
> = {
	en: msg`English`,
	ar: msg`Arabic`,
	es: msg`Spanish`,
	fr: msg`French`,
	de: msg`German`,
	zh: msg`Chinese`,
}

/** The name in the interface language, then English, then any language. */
export function pickExperienceText(
	values: Record<string, string> | null | undefined,
	locale: string,
): string {
	if (!values) return ''
	return (
		values[locale] ?? values.en ?? Object.values(values).find(Boolean) ?? ''
	)
}

/** `Chef's Counter` -> `chefs-counter`; empty when nothing ASCII is left (Arabic names). */
export function slugify(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
}

const SLUG_RE = /^[a-z0-9-]{1,64}$/

// -- Weekdays ------------------------------------------------------------------

/** Monday first, matching the schedule mask (bit 0 = Monday ... bit 6 = Sunday). */
export const MASK_WEEKDAYS: ReadonlyArray<{
	bit: number
	code: string
	short: MessageDescriptor
	full: MessageDescriptor
}> = [
	{ bit: 0, code: 'mon', short: msg`Mon`, full: msg`Monday` },
	{ bit: 1, code: 'tue', short: msg`Tue`, full: msg`Tuesday` },
	{ bit: 2, code: 'wed', short: msg`Wed`, full: msg`Wednesday` },
	{ bit: 3, code: 'thu', short: msg`Thu`, full: msg`Thursday` },
	{ bit: 4, code: 'fri', short: msg`Fri`, full: msg`Friday` },
	{ bit: 5, code: 'sat', short: msg`Sat`, full: msg`Saturday` },
	{ bit: 6, code: 'sun', short: msg`Sun`, full: msg`Sunday` },
]

export const ALL_DAYS_MASK = 127

export function maskToDays(mask: number): boolean[] {
	return MASK_WEEKDAYS.map((day) => (mask & (1 << day.bit)) !== 0)
}

export function daysToMask(days: readonly boolean[]): number {
	return MASK_WEEKDAYS.reduce(
		(mask, day) => (days[day.bit] ? mask | (1 << day.bit) : mask),
		0,
	)
}

// -- Experience form ---------------------------------------------------------------

export type ExperienceFormValues = {
	slug: string
	kind: ExperienceKind
	names: Partial<Record<ExperienceLocale, string>>
	descriptions: Partial<Record<ExperienceLocale, string>>
	imageUrl: string
	price: string
	pricePerCover: boolean
	policyId: string
	partyMin: string
	partyMax: string
	usesTables: boolean
	exclusive: boolean
	sort: string
}

export type ExperienceFormField =
	'slug' | 'name' | 'imageUrl' | 'price' | 'partyMin' | 'partyMax' | 'sort'

export type ExperienceFormErrors = Partial<
	Record<ExperienceFormField, MessageDescriptor>
>

const clean = <T extends string>(
	values: Partial<Record<T, string>>,
	keys: readonly T[],
): Partial<Record<T, string>> => {
	const out: Partial<Record<T, string>> = {}
	for (const key of keys) {
		const text = values[key]?.trim()
		if (text) out[key] = text
	}
	return out
}

export function emptyExperienceForm(): ExperienceFormValues {
	return {
		slug: '',
		kind: 'ticketed',
		names: {},
		descriptions: {},
		imageUrl: '',
		price: '',
		pricePerCover: true,
		policyId: '',
		partyMin: '1',
		partyMax: '8',
		usesTables: true,
		exclusive: false,
		sort: '0',
	}
}

export function experienceToForm(
	experience: ExperienceDto,
): ExperienceFormValues {
	const names: Partial<Record<ExperienceLocale, string>> = {}
	const descriptions: Partial<Record<ExperienceLocale, string>> = {}
	for (const locale of EXPERIENCE_LOCALES) {
		const name = experience.nameI18n[locale]
		if (name) names[locale] = name
		const description = experience.descriptionI18n?.[locale]
		if (description) descriptions[locale] = description
	}
	return {
		slug: experience.slug,
		kind: experience.kind,
		names,
		descriptions,
		imageUrl: experience.imageUrl ?? '',
		price: minorToInput(experience.priceMinor, experience.currency),
		pricePerCover: experience.pricePerCover,
		policyId: experience.policyId ?? '',
		partyMin: String(experience.partyMin),
		partyMax: String(experience.partyMax),
		usesTables: experience.usesTables,
		exclusive: experience.exclusive,
		sort: String(experience.sort),
	}
}

type ParsedForm =
	| {
			ok: true
			input: Required<Omit<ExperienceInput, 'descriptionI18n'>> & {
				descriptionI18n: Partial<Record<ExperienceLocale, string>> | null
			}
	  }
	| { ok: false; errors: ExperienceFormErrors }

/** Form text -> a full experience input, or the field errors to show. */
export function experienceFormToInput(
	form: ExperienceFormValues,
	currency: string,
): ParsedForm {
	const errors: ExperienceFormErrors = {}
	const nameI18n = clean(form.names, EXPERIENCE_LOCALES)
	if (Object.keys(nameI18n).length === 0) {
		errors.name = msg`Enter a name in at least one language.`
	}
	const slug = form.slug.trim()
	if (!slug) {
		// An empty form only reports the name; the link name follows from it.
		if (!errors.name) errors.slug = msg`Enter a link name.`
	} else if (!SLUG_RE.test(slug)) {
		errors.slug = msg`Use lowercase letters, numbers and dashes only (up to 64).`
	}

	const imageUrl = form.imageUrl.trim()
	if (imageUrl) {
		let secure = false
		try {
			secure = new URL(imageUrl).protocol === 'https:'
		} catch {
			secure = false
		}
		if (!secure)
			errors.imageUrl = msg`Use a secure image link that starts with https://.`
	}

	let priceMinor: number | null = null
	if (form.price.trim()) {
		priceMinor = parseMoneyInput(form.price, currency)
		if (priceMinor === null)
			errors.price = msg`Enter a price like 75.00, or leave it empty.`
	}

	const partyMin = Number(form.partyMin)
	const partyMax = Number(form.partyMax)
	if (!Number.isInteger(partyMin) || partyMin < 1 || partyMin > 99) {
		errors.partyMin = msg`Enter a party size from 1 to 99.`
	}
	if (!Number.isInteger(partyMax) || partyMax < 1 || partyMax > 99) {
		errors.partyMax = msg`Enter a party size from 1 to 99.`
	} else if (!errors.partyMin && partyMin > partyMax) {
		errors.partyMax = msg`The largest party cannot be smaller than the smallest.`
	}
	const sort = Number(form.sort || '0')
	if (!Number.isInteger(sort) || sort < 0 || sort > 10_000) {
		errors.sort = msg`Enter a whole number from 0 to 10000.`
	}

	if (Object.keys(errors).length > 0) return { ok: false, errors }
	const descriptions = clean(form.descriptions, EXPERIENCE_LOCALES)
	return {
		ok: true,
		input: {
			slug,
			kind: form.kind,
			nameI18n,
			descriptionI18n:
				Object.keys(descriptions).length > 0 ? descriptions : null,
			imageUrl: imageUrl || null,
			priceMinor,
			pricePerCover: form.pricePerCover,
			policyId: form.policyId || null,
			partyMin,
			partyMax,
			usesTables: form.usesTables,
			exclusive: form.exclusive,
			sort,
		},
	}
}

const sameJson = (a: unknown, b: unknown) =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export type ExperienceFormInput = Extract<ParsedForm, { ok: true }>['input']

/** The input a saved experience corresponds to, to compare a draft against. */
export function experienceToInput(
	experience: ExperienceDto,
): ExperienceFormInput {
	return {
		slug: experience.slug,
		kind: experience.kind,
		nameI18n: experience.nameI18n,
		descriptionI18n: experience.descriptionI18n,
		imageUrl: experience.imageUrl,
		priceMinor: experience.priceMinor,
		pricePerCover: experience.pricePerCover,
		policyId: experience.policyId,
		partyMin: experience.partyMin,
		partyMax: experience.partyMax,
		usesTables: experience.usesTables,
		exclusive: experience.exclusive,
		sort: experience.sort,
	}
}

/**
 * Only what the person changed (the draft against the experience the draft
 * started from), sent with the latest version. A save never rewrites fields
 * someone else edited in the meantime. `null` when nothing changed.
 */
export function experiencePatch(
	base: ExperienceDto,
	input: ExperienceFormInput,
	expectedVersion: number,
): ExperiencePatch | null {
	const before = experienceToInput(base)
	const patch: Partial<ExperienceInput> = {}
	if (input.slug !== before.slug) patch.slug = input.slug
	if (input.kind !== before.kind) patch.kind = input.kind
	if (!sameJson(input.nameI18n, before.nameI18n))
		patch.nameI18n = input.nameI18n
	if (!sameJson(input.descriptionI18n, before.descriptionI18n)) {
		patch.descriptionI18n = input.descriptionI18n
	}
	if (input.imageUrl !== before.imageUrl) patch.imageUrl = input.imageUrl
	if (input.priceMinor !== before.priceMinor)
		patch.priceMinor = input.priceMinor
	if (input.pricePerCover !== before.pricePerCover) {
		patch.pricePerCover = input.pricePerCover
	}
	if (input.policyId !== before.policyId) patch.policyId = input.policyId
	if (input.partyMin !== before.partyMin) patch.partyMin = input.partyMin
	if (input.partyMax !== before.partyMax) patch.partyMax = input.partyMax
	if (input.usesTables !== before.usesTables)
		patch.usesTables = input.usesTables
	if (input.exclusive !== before.exclusive) patch.exclusive = input.exclusive
	if (input.sort !== before.sort) patch.sort = input.sort
	if (Object.keys(patch).length === 0) return null
	return { ...patch, expectedVersion }
}

// -- Schedule form -----------------------------------------------------------------

export type ScheduleFormValues = {
	fromDate: string
	toDate: string
	days: boolean[]
	mode: 'times' | 'interval'
	times: string[]
	start: string
	end: string
	interval: string
	turnMin: string
	capSeating: string
	capDay: string
	areaIds: string[]
	serviceId: string
}

export type ScheduleFormField =
	| 'fromDate'
	| 'toDate'
	| 'days'
	| 'times'
	| 'start'
	| 'end'
	| 'interval'
	| 'turnMin'
	| 'capSeating'
	| 'capDay'

export type ScheduleFormErrors = Partial<
	Record<ScheduleFormField, MessageDescriptor>
>

export const MAX_SEATINGS = 48

export function emptyScheduleForm(today: string): ScheduleFormValues {
	return {
		fromDate: today,
		toDate: today,
		days: MASK_WEEKDAYS.map(() => true),
		mode: 'times',
		times: [],
		start: '18:00',
		end: '21:00',
		interval: '60',
		turnMin: '90',
		capSeating: '',
		capDay: '',
		areaIds: [],
		serviceId: '',
	}
}

export function scheduleToForm(
	schedule: ExperienceScheduleDto,
): ScheduleFormValues {
	const explicit =
		schedule.seatingMins !== null && schedule.seatingMins.length > 0
	return {
		fromDate: schedule.fromDate,
		toDate: schedule.toDate,
		days: maskToDays(schedule.daysMask),
		mode: explicit ? 'times' : 'interval',
		times: explicit ? schedule.seatingMins!.map(formatHhmm) : [],
		start: schedule.startMin !== null ? formatHhmm(schedule.startMin) : '18:00',
		end: schedule.endMin !== null ? formatHhmm(schedule.endMin) : '21:00',
		interval:
			schedule.intervalMin !== null ? String(schedule.intervalMin) : '60',
		turnMin: String(schedule.turnMin),
		capSeating:
			schedule.coversCapPerSeating === null
				? ''
				: String(schedule.coversCapPerSeating),
		capDay:
			schedule.coversCapPerDay === null ? '' : String(schedule.coversCapPerDay),
		areaIds: schedule.areaIds ?? [],
		serviceId: schedule.serviceId ?? '',
	}
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function optionalCap(
	text: string,
	max: number,
	field: ScheduleFormField,
	errors: ScheduleFormErrors,
): number | null {
	if (!text.trim()) return null
	const value = Number(text)
	if (!Number.isInteger(value) || value < 1 || value > max) {
		errors[field] = msg`Enter a whole number of guests, or leave it empty.`
		return null
	}
	return value
}

/**
 * Schedule form -> request body. `usesTables` decides whether a cap is
 * required: an experience that does not use tables is limited only by its
 * covers cap, so publishing without one is refused by the region too.
 */
export function scheduleFormToBody(
	form: ScheduleFormValues,
	options: { usesTables: boolean },
):
	{ ok: true; body: ScheduleBody } | { ok: false; errors: ScheduleFormErrors } {
	const errors: ScheduleFormErrors = {}
	if (!DATE_RE.test(form.fromDate))
		errors.fromDate = msg`Choose the first date.`
	if (!DATE_RE.test(form.toDate)) errors.toDate = msg`Choose the last date.`
	if (!errors.fromDate && !errors.toDate && form.toDate < form.fromDate) {
		errors.toDate = msg`The last date cannot be before the first.`
	}
	const daysMask = daysToMask(form.days)
	if (daysMask === 0) errors.days = msg`Choose at least one day.`

	let seatingMins: number[] | null = null
	let startMin: number | null = null
	let endMin: number | null = null
	let intervalMin: number | null = null
	if (form.mode === 'times') {
		const unique = [...new Set(form.times)].sort()
		if (unique.length === 0) {
			errors.times = msg`Add at least one seating time.`
		} else if (unique.length > MAX_SEATINGS) {
			errors.times = msg`Use at most 48 seatings in one schedule.`
		} else {
			try {
				seatingMins = unique.map(parseHhmm)
			} catch {
				errors.times = msg`Enter times like 19:00.`
			}
		}
	} else {
		try {
			startMin = parseHhmm(form.start)
		} catch {
			errors.start = msg`Enter a time like 18:00.`
		}
		try {
			endMin = parseHhmm(form.end)
		} catch {
			errors.end = msg`Enter a time like 21:00.`
		}
		const step = Number(form.interval)
		if (!Number.isInteger(step) || step < 1 || step > 1440) {
			errors.interval = msg`Enter the minutes between seatings, for example 60.`
		} else {
			intervalMin = step
		}
		if (startMin !== null && endMin !== null) {
			if (endMin <= startMin) {
				errors.end = msg`The last seating must be after the first.`
			} else if (
				intervalMin !== null &&
				Math.floor((endMin - startMin) / intervalMin) + 1 > MAX_SEATINGS
			) {
				errors.interval = msg`That makes more than 48 seatings. Use a longer interval.`
			}
		}
	}

	const turn = Number(form.turnMin)
	if (!Number.isInteger(turn) || turn < 15 || turn > 480) {
		errors.turnMin = msg`Enter a length from 15 to 480 minutes.`
	}
	const coversCapPerSeating = optionalCap(
		form.capSeating,
		9999,
		'capSeating',
		errors,
	)
	const coversCapPerDay = optionalCap(form.capDay, 99_999, 'capDay', errors)
	if (
		!options.usesTables &&
		coversCapPerSeating === null &&
		coversCapPerDay === null &&
		!errors.capSeating &&
		!errors.capDay
	) {
		errors.capSeating = msg`Without tables, set a guest limit per seating or per day.`
	}

	if (Object.keys(errors).length > 0) return { ok: false, errors }
	return {
		ok: true,
		body: {
			fromDate: form.fromDate,
			toDate: form.toDate,
			daysMask,
			seatingMins,
			startMin,
			endMin,
			intervalMin,
			turnMin: turn,
			coversCapPerSeating,
			coversCapPerDay,
			areaIds: form.areaIds.length > 0 ? form.areaIds : null,
			serviceId: form.serviceId || null,
		},
	}
}

/** `19:00` shown in the interface locale, as a time of day with no zone. */
export function formatSeatingMin(minute: number, locale: string): string {
	const wrapped = ((minute % 1440) + 1440) % 1440
	try {
		return new Intl.DateTimeFormat(locale, {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: 'UTC',
		}).format(Date.UTC(2000, 0, 1, Math.floor(wrapped / 60), wrapped % 60))
	} catch {
		return formatHhmm(wrapped)
	}
}

/** A date like `2026-10-24` shown as a calendar date (no zone shift). */
export function formatCalendarDate(date: string, locale: string): string {
	return formatBusinessDate(date, locale, 'medium')
}

export { currencyFractionDigits }

// -- Errors --------------------------------------------------------------------------

const ISSUE_MESSAGES: Record<string, MessageDescriptor> = {
	schedules_required: msg`Add at least one schedule before publishing.`,
	schedule_in_past: msg`Every schedule has ended. Add or extend a schedule before publishing.`,
	required: msg`A seating time is missing.`,
	cap_required: msg`Without tables, every schedule needs a guest limit.`,
	invalid_reference: msg`An area, service or policy you picked no longer exists. Reload and choose again.`,
	https_only: msg`Use a secure image link that starts with https://.`,
	one_mode: msg`Use either specific times or an interval, not both.`,
	seatings_required: msg`Add seating times.`,
	too_many_seatings: msg`That makes more than 48 seatings.`,
	range: msg`A start is after its end.`,
}

const ERROR_MESSAGES: Record<string, MessageDescriptor> = {
	stale_version: msg`Someone else changed this experience first. The latest version is loaded; check it and try again.`,
	slug_taken: msg`Another experience already uses this link name. Pick a different one.`,
	experience_archived: msg`This experience is archived and can no longer be changed.`,
	invalid_status_transition: msg`That is no longer possible for this experience. It has been reloaded.`,
	not_found: msg`This experience no longer exists.`,
	feature_off: msg`Experiences are not turned on for this restaurant.`,
	forbidden: msg`You do not have permission to change experiences.`,
	missing_grant: msg`You do not have permission to change experiences.`,
}

type ErrorBody = {
	error?: string
	code?: string
	issues?: Array<{ path?: string; code?: string }>
	current?: unknown
}

function bodyOf(err: unknown): ErrorBody | null {
	if (!err || typeof err !== 'object') return null
	const body = (err as { body?: unknown }).body
	return body && typeof body === 'object' ? (body as ErrorBody) : null
}

export function experienceErrorCode(err: unknown): string | null {
	const body = bodyOf(err)
	return body?.error ?? body?.code ?? null
}

export function experienceErrorStatus(err: unknown): number | null {
	const status =
		err && typeof err === 'object' ? (err as { status?: unknown }).status : null
	return typeof status === 'number' ? status : null
}

/** The experience as the region has it now, sent with a version conflict. */
export function conflictCurrent(err: unknown): unknown {
	return experienceErrorCode(err) === 'stale_version'
		? (bodyOf(err)?.current ?? null)
		: null
}

/** Sentences for a failed call: a known code, then each flagged issue. */
export function experienceErrorMessages(
	err: unknown,
	translate: (descriptor: MessageDescriptor) => string,
	fallback: MessageDescriptor,
): string[] {
	const code = experienceErrorCode(err)
	const body = bodyOf(err)
	const out: string[] = []
	if (code && ERROR_MESSAGES[code]) out.push(translate(ERROR_MESSAGES[code]!))
	if (code === 'invalid' || body?.issues) {
		const seen = new Set<string>()
		for (const issue of body?.issues ?? []) {
			const descriptor = issue.code ? ISSUE_MESSAGES[issue.code] : undefined
			if (descriptor && !seen.has(issue.code!)) {
				seen.add(issue.code!)
				out.push(translate(descriptor))
			}
		}
	}
	if (out.length > 0) return out
	if (experienceErrorStatus(err) === 403) {
		return [translate(ERROR_MESSAGES.forbidden!)]
	}
	return [translate(fallback)]
}

/** A schedule as one sentence-ish summary for the table. */
export function seatingSummary(
	schedule: ExperienceScheduleDto,
	locale: string,
	limit = 4,
): string {
	const times = schedule.seatings.map((minute) =>
		formatSeatingMin(minute, locale),
	)
	if (times.length <= limit) return times.join(', ')
	return `${times.slice(0, limit).join(', ')} +${times.length - limit}`
}
