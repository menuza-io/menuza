import { type ReservationsApi } from './api.ts'
import { createAttemptKeys } from './attempt.ts'
import { isPlausibleEmail, isPlausiblePhone } from './details.ts'
import { waitlistErrorKey } from './errors.ts'
import { type ReservationLabels } from './labels.ts'
import { formatHhmm, parseHhmm, todayIn, zoneNote } from './time.ts'
import { type Availability } from './types.ts'
import {
	bannerErrorClass,
	cardClass,
	createChallenge,
	field,
	guestsLabel,
	inputClass,
	labelClass,
	primaryButtonClass,
	secondaryButtonClass,
	showFieldError,
} from './ui.ts'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'

const DEFAULT_FROM_MIN = 19 * 60
const DEFAULT_TO_MIN = 21 * 60
const BEFORE_PREFERRED_MIN = 60
const AFTER_PREFERRED_MIN = 120
const LAST_MINUTE_OF_DAY = 23 * 60 + 59

/** The time range offered by default: around the time the guest searched for, else dinner time. */
export function defaultNotifyWindow(preferredMin: number | null): {
	fromLocalMin: number
	toLocalMin: number
} {
	if (preferredMin === null) {
		return { fromLocalMin: DEFAULT_FROM_MIN, toLocalMin: DEFAULT_TO_MIN }
	}
	return {
		fromLocalMin: Math.max(0, preferredMin - BEFORE_PREFERRED_MIN),
		toLocalMin: Math.min(
			LAST_MINUTE_OF_DAY,
			preferredMin + AFTER_PREFERRED_MIN,
		),
	}
}

/** Statuses where no table exists for a reason waiting cannot fix. */
const NO_OFFER_STATUSES = new Set([
	'closed',
	'online_closed',
	'beyond_horizon',
	'large_party',
])

function noTableToday(result: Availability): boolean {
	return result.slots.length === 0 && !NO_OFFER_STATUSES.has(result.status)
}

/** "Notify me" appears only when nothing fits and the restaurant offers alerts. */
export function offersNotifyMe(result: Availability): boolean {
	return result.notifyMe === true && noTableToday(result)
}

/** "Join the waitlist" appears only for today, when nothing fits and joins are open. */
export function offersWaitlist(result: Availability): boolean {
	if (result.waitlist !== true || !noTableToday(result)) return false
	const serverNow = Date.parse(result.now)
	return (
		result.date ===
		todayIn(result.timeZone, Number.isNaN(serverNow) ? Date.now() : serverNow)
	)
}

export type NotifyMeValues = {
	partySize: number
	date: string
	from: string
	to: string
	phone: string
	email: string
}

export type NotifyMeField = 'contact' | 'phone' | 'email' | 'from' | 'to'
export type NotifyMeErrors = Partial<
	Record<NotifyMeField, 'required' | 'invalid'>
>

export function validateNotifyMe(values: NotifyMeValues): NotifyMeErrors {
	const errors: NotifyMeErrors = {}
	const phone = values.phone.trim()
	const email = values.email.trim()
	if (!phone && !email) errors.contact = 'required'
	if (phone && !isPlausiblePhone(phone)) errors.phone = 'invalid'
	if (email && !isPlausibleEmail(email)) errors.email = 'invalid'
	const from = parseHhmm(values.from)
	const to = parseHhmm(values.to)
	if (from === null) errors.from = 'required'
	if (to === null) errors.to = 'required'
	if (from !== null && to !== null && to <= from) errors.to = 'invalid'
	return errors
}

export function buildNotifyMeBody(
	input: NotifyMeValues & {
		locationId: string
		locale: string
		honeypot: string
		turnstileToken: string | null
	},
) {
	return {
		locationId: input.locationId,
		date: input.date,
		partySize: input.partySize,
		fromLocalMin: parseHhmm(input.from) ?? 0,
		toLocalMin: parseHhmm(input.to) ?? 0,
		phone: input.phone.trim() || null,
		email: input.email.trim() || null,
		locale: input.locale,
		website: input.honeypot,
		...(input.turnstileToken ? { turnstileToken: input.turnstileToken } : {}),
	}
}

export type NotifyMeDeps = {
	api: ReservationsApi
	labels: ReservationLabels
	locale: string
	orgName: string
	phoneExample: string
	turnstileSiteKey: string
	locationId: string
	/** The restaurant's zone: the from/to window is read in it. */
	timeZone?: string
	/** Overrides the browser's zone (tests); `null` means unknown. */
	visitorZone?: string | null
	partySize: { min: number; max: number }
	/** What the guest searched for; the form starts from it. */
	search: { partySize: number; date: string; preferredMin: number | null }
	dateRange: { min: string; max: string }
	signedIn?: () => boolean
	newKey?: () => string
}

/** "Notify me": asks tenant-api to contact the guest when a table opens in a time range. */
export function createNotifyMeForm(deps: NotifyMeDeps) {
	const { api, labels, locale } = deps
	const phoneExample = `\u2066${deps.phoneExample}\u2069`
	const attempts = createAttemptKeys(deps.newKey)

	const section = el('section', cardClass)
	section.dataset.notifyMe = 'true'
	section.setAttribute('aria-labelledby', 'rsv-notify-heading')
	const heading = el(
		'h3',
		'text-base font-semibold text-foreground',
		labels.notifyTitle,
	)
	heading.id = 'rsv-notify-heading'
	const intro = el('p', 'text-sm text-muted-foreground', labels.notifyBody)
	const live = el('div')
	live.setAttribute('aria-live', 'polite')
	section.append(heading, intro, live)

	const form = el('form', 'flex flex-col gap-4')
	form.noValidate = true
	form.dataset.notifyForm = 'true'

	const partySelect = el('select', inputClass)
	partySelect.id = 'rsv-notify-party'
	partySelect.name = 'partySize'
	for (let size = deps.partySize.min; size <= deps.partySize.max; size++) {
		const option = el('option', undefined, guestsLabel(labels, size))
		option.value = String(size)
		partySelect.append(option)
	}
	partySelect.value = String(deps.search.partySize)
	const partyWrap = el('div', 'flex flex-col gap-2')
	const partyLabel = el('label', labelClass, labels.fieldParty)
	partyLabel.htmlFor = partySelect.id
	partyWrap.append(partyLabel, partySelect)

	const dateInput = el('input', inputClass)
	dateInput.id = 'rsv-notify-date'
	dateInput.name = 'date'
	dateInput.type = 'date'
	dateInput.required = true
	dateInput.min = deps.dateRange.min
	dateInput.max = deps.dateRange.max
	dateInput.value = deps.search.date
	const dateWrap = el('div', 'flex flex-col gap-2')
	const dateLabel = el('label', labelClass, labels.fieldDate)
	dateLabel.htmlFor = dateInput.id
	dateWrap.append(dateLabel, dateInput)

	const defaults = defaultNotifyWindow(deps.search.preferredMin)
	const from = field({
		id: 'rsv-notify-from',
		name: 'from',
		label: labels.notifyFrom,
		type: 'time',
		dir: 'ltr',
		required: true,
		value: formatHhmm(defaults.fromLocalMin),
	})
	const to = field({
		id: 'rsv-notify-to',
		name: 'to',
		label: labels.notifyTo,
		type: 'time',
		dir: 'ltr',
		required: true,
		value: formatHhmm(defaults.toLocalMin),
	})
	const phone = field({
		id: 'rsv-notify-phone',
		name: 'phone',
		label: labels.phone,
		optional: labels.optional,
		type: 'tel',
		autocomplete: 'tel',
		maxLength: 40,
		dir: 'ltr',
		hint: fillTemplate(labels.phoneHint, { example: phoneExample }),
	})
	const email = field({
		id: 'rsv-notify-email',
		name: 'email',
		label: labels.email,
		optional: labels.optional,
		type: 'email',
		autocomplete: 'email',
		maxLength: 254,
		dir: 'ltr',
		hint: labels.notifyContactHint,
	})
	const contactError = el('p', 'text-sm text-destructive')
	contactError.hidden = true
	contactError.id = 'rsv-notify-contact-error'

	const trap = el('div', 'hidden')
	trap.setAttribute('aria-hidden', 'true')
	const trapInput = el('input')
	trapInput.name = 'website'
	trapInput.tabIndex = -1
	trapInput.autocomplete = 'off'
	trap.append(trapInput)

	const challengeBox = el('div')
	const challenge = createChallenge(challengeBox, deps.turnstileSiteKey)

	const bannerBox = el('div')
	const submit = el('button', primaryButtonClass, labels.notifySubmit)
	submit.type = 'submit'

	const times = el('div', 'grid gap-4 sm:grid-cols-2')
	times.append(from.wrapper, to.wrapper)
	const zone = deps.timeZone ? zoneNote(deps.timeZone, deps.visitorZone) : null
	const zoneBox = el(
		'p',
		'text-sm text-muted-foreground',
		zone ? fillTemplate(labels.restaurantZone, { zone }) : '',
	)
	zoneBox.dataset.zoneNote = 'true'
	zoneBox.hidden = !zone
	const contacts = el('div', 'grid gap-4 sm:grid-cols-2')
	contacts.append(phone.wrapper, email.wrapper)
	const basics = el('div', 'grid gap-4 sm:grid-cols-2')
	basics.append(partyWrap, dateWrap)
	form.append(
		basics,
		times,
		zoneBox,
		contacts,
		contactError,
		el(
			'p',
			'text-xs text-muted-foreground',
			fillTemplate(labels.notifyContactNote, { name: deps.orgName }),
		),
		trap,
		challengeBox,
		bannerBox,
		submit,
	)
	section.append(form)

	function banner(text: string | null) {
		bannerBox.replaceChildren()
		if (!text) return
		const note = el('p', bannerErrorClass, text)
		note.setAttribute('role', 'alert')
		bannerBox.append(note)
	}

	function showErrors(errors: NotifyMeErrors) {
		const text = (code: 'required' | 'invalid' | undefined, invalid: string) =>
			code ? (code === 'required' ? labels.fieldRequired : invalid) : null
		showFieldError(
			phone.input,
			phone.error,
			text(
				errors.phone,
				fillTemplate(labels.phoneInvalid, { example: phoneExample }),
			),
		)
		showFieldError(
			email.input,
			email.error,
			text(errors.email, labels.emailInvalid),
		)
		showFieldError(
			from.input,
			from.error,
			text(errors.from, labels.fieldRequired),
		)
		showFieldError(
			to.input,
			to.error,
			text(errors.to, labels.notifyWindowInvalid),
		)
		contactError.hidden = !errors.contact
		contactError.textContent = errors.contact
			? labels.notifyContactRequired
			: ''
	}

	function read(): NotifyMeValues {
		return {
			partySize: Number(partySelect.value) || deps.search.partySize,
			date: dateInput.value || deps.search.date,
			from: from.input.value,
			to: to.input.value,
			phone: phone.input.value,
			email: email.input.value,
		}
	}

	function setBusy(busy: boolean) {
		submit.disabled = busy
		submit.textContent = busy ? labels.notifySubmitting : labels.notifySubmit
	}

	function renderDone(cancelToken: string) {
		form.hidden = true
		intro.hidden = true
		heading.textContent = labels.notifyDoneTitle
		live.replaceChildren()
		const body = el('p', 'text-sm text-foreground', labels.notifyDoneBody)
		const cancel = el('button', secondaryButtonClass, labels.notifyCancel)
		cancel.type = 'button'
		const status = el('div')
		status.setAttribute('aria-live', 'polite')
		cancel.addEventListener('click', () => {
			cancel.disabled = true
			cancel.textContent = labels.notifyCancelling
			status.replaceChildren()
			api.notifyMe
				.cancel(cancelToken)
				.then(() => {
					heading.textContent = labels.notifyCancelled
					body.hidden = true
					cancel.hidden = true
				})
				.catch((error) => {
					cancel.disabled = false
					cancel.textContent = labels.notifyCancel
					const note = el(
						'p',
						bannerErrorClass,
						labels[waitlistErrorKey(error, 'notify')],
					)
					note.setAttribute('role', 'alert')
					status.replaceChildren(note)
				})
		})
		section.append(body, cancel, status)
		cancel.focus()
	}

	form.addEventListener('submit', (event) => {
		event.preventDefault()
		banner(null)
		const values = read()
		const errors = validateNotifyMe(values)
		showErrors(errors)
		const firstBad = (
			['contact', 'phone', 'email', 'from', 'to'] as const
		).find((key) => errors[key])
		if (firstBad) {
			const target = { contact: phone, phone, email, from, to }[firstBad]
			target.input.focus()
			return
		}
		if (challenge.enabled && !challenge.token() && !deps.signedIn?.()) {
			banner(labels.verifyFirst)
			return
		}
		const body = buildNotifyMeBody({
			...values,
			locationId: deps.locationId,
			locale,
			honeypot: trapInput.value,
			turnstileToken: challenge.token(),
		})
		const { turnstileToken: ignoredToken, ...signed } = body
		const key = attempts.keyFor(JSON.stringify(signed))
		setBusy(true)
		api.notifyMe
			.create(body, key)
			.then((result) => {
				attempts.reset()
				challenge.reset()
				renderDone(result.cancelToken)
			})
			.catch((error) => {
				challenge.reset()
				setBusy(false)
				banner(labels[waitlistErrorKey(error, 'notify')])
			})
	})

	return { element: section }
}
