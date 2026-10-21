import { type ReservationsApi } from './api.ts'
import { createAttemptKeys } from './attempt.ts'
import { isPlausibleEmail, isPlausiblePhone } from './details.ts'
import {
	invalidFieldPaths,
	type ReservationErrorKey,
	waitlistErrorKey,
} from './errors.ts'
import {
	forgetWaitlistToken,
	publishWaitlistToken,
	takeWaitlistToken,
} from './fragment.ts'
import { formatHoldClock } from './hold.ts'
import { type ReservationLabels } from './labels.ts'
import { zoneNote } from './time.ts'
import {
	type ReservationLocation,
	type WaitlistJoinResponse,
	type WaitlistStatus,
} from './types.ts'
import {
	bannerErrorClass,
	bannerInfoClass,
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

const DEFAULT_POLL_MS = 15_000
const ACTIVE_STATES = new Set(['waiting', 'notified', 'on_the_way'])

export function isActiveWaitlistState(state: string): boolean {
	return ACTIVE_STATES.has(state)
}

/** Keeps numbers and times in their own direction inside right-to-left text. */
function isolate(value: string | number): string {
	return `\u2066${value}\u2069`
}

export type WaitlistStateCopy = {
	title: string
	body: string | null
	tone: 'ready' | 'info' | 'done'
}

/** The headline and explanation for an entry state; `deadline` is the countdown text when known. */
export function waitlistStateCopy(
	labels: ReservationLabels,
	state: string,
	deadline: string | null = null,
): WaitlistStateCopy {
	switch (state) {
		case 'waiting':
			return {
				title: labels.waitlistStateWaiting,
				body: labels.waitlistStateWaitingBody,
				tone: 'info',
			}
		case 'notified':
			return {
				title: labels.waitlistStateNotified,
				body: deadline
					? fillTemplate(labels.waitlistStateNotifiedBody, {
							time: isolate(deadline),
						})
					: labels.waitlistStateNotifiedNoTimer,
				tone: 'ready',
			}
		case 'on_the_way':
			return {
				title: labels.waitlistStateOnTheWay,
				body: labels.waitlistStateOnTheWayBody,
				tone: 'info',
			}
		case 'seated':
			return {
				title: labels.waitlistStateSeated,
				body: labels.waitlistStateSeatedBody,
				tone: 'done',
			}
		case 'left':
			return {
				title: labels.waitlistStateLeft,
				body: labels.waitlistStateLeftBody,
				tone: 'done',
			}
		case 'cancelled':
			return {
				title: labels.waitlistStateCancelled,
				body: labels.waitlistStateCancelledBody,
				tone: 'done',
			}
		case 'no_response':
			return {
				title: labels.waitlistStateNoResponse,
				body: labels.waitlistStateNoResponseBody,
				tone: 'done',
			}
		default:
			return { title: labels.waitlistStatusTitle, body: null, tone: 'done' }
	}
}

export function joinResponseToStatus(
	result: WaitlistJoinResponse,
): WaitlistStatus {
	const { entry } = result
	return {
		status: entry.status,
		position: entry.position,
		partySize: entry.partySize,
		quotedMin: entry.quotedMin,
		quotedReadyAt: entry.quotedReadyAt,
		locationName: entry.locationName,
		notifiedAt: null,
		responseDeadlineAt: null,
		canLeave: isActiveWaitlistState(entry.status),
		canOnMyWay: entry.status === 'waiting',
		now: result.now,
	}
}

export type JoinValues = {
	name: string
	phone: string
	email: string
	partySize: number
	areaId: string
	smsOptIn: boolean
}

export type JoinErrors = Partial<
	Record<'name' | 'phone' | 'email', 'required' | 'invalid'>
>

export function validateJoin(values: JoinValues): JoinErrors {
	const errors: JoinErrors = {}
	if (!values.name.trim()) errors.name = 'required'
	if (!values.phone.trim()) errors.phone = 'required'
	else if (!isPlausiblePhone(values.phone)) errors.phone = 'invalid'
	if (values.email.trim() && !isPlausibleEmail(values.email)) {
		errors.email = 'invalid'
	}
	return errors
}

export function buildJoinBody(
	input: JoinValues & {
		locationId: string
		locale: string
		honeypot: string
		turnstileToken: string | null
	},
) {
	return {
		locationId: input.locationId,
		name: input.name.trim(),
		partySize: input.partySize,
		phone: input.phone.trim(),
		email: input.email.trim() || null,
		smsOptIn: input.smsOptIn,
		areaId: input.areaId || null,
		locale: input.locale,
		website: input.honeypot,
		...(input.turnstileToken ? { turnstileToken: input.turnstileToken } : {}),
	}
}

/** What the status card shows; a poll that changes none of it leaves the card (and its focus) alone. */
function statusSignature(view: WaitlistStatus): string {
	const { now: ignoredNow, ...rest } = view
	return JSON.stringify(rest)
}

export type WaitlistDeps = {
	api: ReservationsApi
	labels: ReservationLabels
	locale: string
	smsAllowed: boolean
	phoneExample?: string
	turnstileSiteKey: string
	orgName: string
	/** `location.search` of the page. */
	search: string
	pageLocation: Pick<Location, 'hash' | 'pathname' | 'search'>
	history: Pick<History, 'replaceState' | 'state'>
	/** Where "Book a table" points. */
	bookHref: string
	/** The page heading and subtitle, retitled when the status view replaces the join form. */
	headingEl?: HTMLElement | null
	subtitleEl?: HTMLElement | null
	/** Overrides the browser's zone (tests); `null` means unknown. */
	visitorZone?: string | null
	loadPrefill?: () => Promise<{
		name: string
		phone: string
		email: string
	} | null>
	signedIn?: () => boolean
	storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
	now?: () => number
	pollMs?: number
	isHidden?: () => boolean
	newKey?: () => string
}

export async function initWaitlistPage(root: HTMLElement, deps: WaitlistDeps) {
	const { api, locale, labels: rawLabels } = deps
	const now = deps.now ?? (() => Date.now())
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
	const isHidden =
		deps.isHidden ?? (() => typeof document !== 'undefined' && document.hidden)
	const phoneExample = isolate(deps.phoneExample ?? '+1 415 555 0123')
	const labels = {
		...rawLabels,
		phoneHint: fillTemplate(rawLabels.phoneHint, { example: phoneExample }),
		phoneInvalid: fillTemplate(rawLabels.phoneInvalid, {
			example: phoneExample,
		}),
	}
	const attempts = createAttemptKeys(deps.newKey)

	let destroyed = false
	let pollTimer: ReturnType<typeof setTimeout> | undefined
	let countdownTimer: ReturnType<typeof setInterval> | undefined
	let pollSeq = 0
	let token: string | null = null
	let view: WaitlistStatus | null = null
	let renderedSignature = ''
	let confirmingLeave = false
	let busy = false
	let deviceOffsetMs = 0
	let lastAnnounced = ''

	const statusBox = el('div')
	statusBox.setAttribute('aria-live', 'polite')
	const announcer = el('div', 'sr-only')
	announcer.setAttribute('aria-live', 'polite')
	const stage = el('div', 'flex flex-col gap-6')
	root.replaceChildren(statusBox, announcer, stage)

	function say(text: string | null, kind: 'error' | 'info' = 'info') {
		statusBox.replaceChildren()
		if (!text) return
		const note = el(
			'p',
			kind === 'error' ? bannerErrorClass : bannerInfoClass,
			text,
		)
		if (kind === 'error') note.setAttribute('role', 'alert')
		statusBox.append(note)
	}

	function setHeading(mode: 'join' | 'status') {
		if (deps.headingEl) {
			deps.headingEl.textContent =
				mode === 'join' ? labels.waitlistTitle : labels.waitlistStatusTitle
		}
		if (deps.subtitleEl) deps.subtitleEl.hidden = mode === 'status'
	}

	function stopTimers() {
		clearTimeout(pollTimer)
		clearInterval(countdownTimer)
		pollTimer = undefined
		countdownTimer = undefined
	}

	function bookLink() {
		const link = el('a', secondaryButtonClass, labels.bookATable)
		link.href = deps.bookHref
		return link
	}

	function unavailable() {
		stopTimers()
		setHeading('join')
		const card = el('section', cardClass)
		card.dataset.waitlist = 'unavailable'
		card.append(
			el(
				'h2',
				'text-xl font-semibold text-foreground',
				labels.waitlistUnavailableTitle,
			),
			el('p', 'text-sm text-muted-foreground', labels.waitlistUnavailableBody),
			bookLink(),
		)
		stage.replaceChildren(card)
	}

	// Join ---------------------------------------------------------------------
	async function showJoin() {
		stopTimers()
		token = null
		view = null
		renderedSignature = ''
		confirmingLeave = false
		setHeading('join')
		say(null)
		stage.replaceChildren(
			el('p', 'text-sm text-muted-foreground', labels.loading),
		)

		let locations: ReservationLocation[]
		try {
			locations = (await api.config(locale)).locations.filter(
				(place) => place.waitlist.online,
			)
		} catch {
			if (!destroyed) unavailable()
			return
		}
		if (destroyed) return
		if (locations.length === 0) {
			unavailable()
			return
		}
		renderJoinForm(locations)
	}

	function renderJoinForm(locations: ReservationLocation[]) {
		const query = new URLSearchParams(deps.search)
		let location =
			locations.find((place) => place.id === query.get('location')) ??
			locations[0]!

		const card = el('section', cardClass)
		card.dataset.waitlist = 'join'
		card.setAttribute('aria-labelledby', 'rsv-waitlist-join-heading')
		const heading = el(
			'h2',
			'text-xl font-semibold text-foreground',
			labels.waitlistTitle,
		)
		heading.id = 'rsv-waitlist-join-heading'
		const form = el('form', 'flex flex-col gap-4')
		form.noValidate = true

		const locationSelect = el('select', inputClass)
		locationSelect.id = 'rsv-waitlist-location'
		for (const place of locations) {
			const option = el('option', undefined, place.name)
			option.value = place.id
			locationSelect.append(option)
		}
		locationSelect.value = location.id
		const zoneBox = el('p', 'text-sm text-muted-foreground')
		zoneBox.dataset.zoneNote = 'true'
		zoneBox.hidden = true
		const locationWrap = el('div', 'flex flex-col gap-2')
		const locationLabel = el('label', labelClass, labels.fieldLocation)
		locationLabel.htmlFor = locationSelect.id
		locationWrap.append(locationLabel, locationSelect)
		locationWrap.hidden = locations.length < 2

		const name = field({
			id: 'rsv-waitlist-name',
			name: 'name',
			label: labels.waitlistName,
			autocomplete: 'name',
			maxLength: 120,
			required: true,
		})
		const phone = field({
			id: 'rsv-waitlist-phone',
			name: 'phone',
			label: labels.phone,
			type: 'tel',
			hint: labels.phoneHint,
			autocomplete: 'tel',
			maxLength: 40,
			dir: 'ltr',
			required: true,
		})
		const email = field({
			id: 'rsv-waitlist-email',
			name: 'email',
			label: labels.email,
			optional: labels.optional,
			type: 'email',
			hint: labels.waitlistEmailHint,
			autocomplete: 'email',
			maxLength: 254,
			dir: 'ltr',
		})

		const partySelect = el('select', inputClass)
		partySelect.id = 'rsv-waitlist-party'
		partySelect.name = 'partySize'
		const partyWrap = el('div', 'flex flex-col gap-2')
		const partyLabel = el('label', labelClass, labels.fieldParty)
		partyLabel.htmlFor = partySelect.id
		partyWrap.append(partyLabel, partySelect)

		const areaSelect = el('select', inputClass)
		areaSelect.id = 'rsv-waitlist-area'
		areaSelect.name = 'areaId'
		const areaWrap = el('div', 'flex flex-col gap-2')
		const areaLabel = el('label', labelClass, labels.waitlistArea)
		areaLabel.htmlFor = areaSelect.id
		areaWrap.append(areaLabel, areaSelect)

		function applyLocation() {
			const queryParty = Number(query.get('party')) || 2
			const max = Math.max(1, location.partySize.max)
			const keep = Number(partySelect.value) || queryParty
			partySelect.replaceChildren()
			for (let size = 1; size <= max; size++) {
				const option = el('option', undefined, guestsLabel(labels, size))
				option.value = String(size)
				partySelect.append(option)
			}
			partySelect.value = String(Math.min(Math.max(keep, 1), max))
			areaSelect.replaceChildren()
			const any = el('option', undefined, labels.waitlistAreaAny)
			any.value = ''
			areaSelect.append(any)
			for (const area of location.areas ?? []) {
				const option = el('option', undefined, area.name)
				option.value = area.id
				areaSelect.append(option)
			}
			areaWrap.hidden = (location.areas ?? []).length === 0
			const zone = zoneNote(location.timeZone, deps.visitorZone)
			zoneBox.hidden = !zone
			zoneBox.textContent = zone
				? fillTemplate(labels.restaurantZone, { zone })
				: ''
		}
		applyLocation()
		locationSelect.addEventListener('change', () => {
			location =
				locations.find((place) => place.id === locationSelect.value) ?? location
			applyLocation()
		})

		function checkbox(inputName: string, text: string) {
			const wrap = el(
				'label',
				'flex cursor-pointer items-start gap-3 text-sm text-foreground',
			)
			const input = el('input', 'mt-0.5 size-5 shrink-0 accent-primary')
			input.type = 'checkbox'
			input.name = inputName
			wrap.append(input, el('span', undefined, text))
			return { wrap, input }
		}
		const sms = deps.smsAllowed
			? checkbox('smsOptIn', labels.waitlistSmsOptIn)
			: null

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
		const submit = el('button', primaryButtonClass, labels.waitlistSubmit)
		submit.type = 'submit'

		const row = el('div', 'grid gap-4 sm:grid-cols-2')
		row.append(partyWrap, areaWrap)
		form.append(
			locationWrap,
			zoneBox,
			name.wrapper,
			phone.wrapper,
			email.wrapper,
			row,
		)
		if (sms) form.append(sms.wrap)
		form.append(
			el(
				'p',
				'text-xs text-muted-foreground',
				fillTemplate(labels.waitlistContactNote, { name: deps.orgName }),
			),
			trap,
			challengeBox,
			bannerBox,
			submit,
		)
		card.append(heading, form)
		stage.replaceChildren(card)

		const fieldMap = { name, phone, email } as const

		function banner(text: string | null) {
			bannerBox.replaceChildren()
			if (!text) return
			const note = el('p', bannerErrorClass, text)
			note.setAttribute('role', 'alert')
			bannerBox.append(note)
		}

		function showErrors(errors: JoinErrors) {
			const text = (
				code: 'required' | 'invalid' | undefined,
				invalid: string,
			) =>
				code ? (code === 'required' ? labels.fieldRequired : invalid) : null
			showFieldError(
				name.input,
				name.error,
				text(errors.name, labels.fieldRequired),
			)
			showFieldError(
				phone.input,
				phone.error,
				text(errors.phone, labels.phoneInvalid),
			)
			showFieldError(
				email.input,
				email.error,
				text(errors.email, labels.emailInvalid),
			)
		}

		function setBusy(isBusy: boolean) {
			submit.disabled = isBusy
			submit.textContent = isBusy
				? labels.waitlistSubmitting
				: labels.waitlistSubmit
		}

		function read(): JoinValues {
			return {
				name: name.input.value,
				phone: phone.input.value,
				email: email.input.value,
				partySize: Number(partySelect.value) || 1,
				areaId: areaSelect.value,
				smsOptIn: sms?.input.checked ?? false,
			}
		}

		form.addEventListener('submit', (event) => {
			event.preventDefault()
			banner(null)
			const values = read()
			const errors = validateJoin(values)
			showErrors(errors)
			const firstBad = (['name', 'phone', 'email'] as const).find(
				(key) => errors[key],
			)
			if (firstBad) {
				banner(labels.fixFields)
				fieldMap[firstBad].input.focus()
				return
			}
			if (challenge.enabled && !challenge.token() && !deps.signedIn?.()) {
				banner(labels.verifyFirst)
				return
			}
			const body = buildJoinBody({
				...values,
				locationId: location.id,
				locale,
				honeypot: trapInput.value,
				turnstileToken: challenge.token(),
			})
			const { turnstileToken: ignoredToken, ...signed } = body
			const key = attempts.keyFor(JSON.stringify(signed))
			setBusy(true)
			api.waitlist
				.join(body, key)
				.then((result) => {
					attempts.reset()
					challenge.reset()
					if (destroyed) return
					token = result.statusToken
					publishWaitlistToken(
						token,
						deps.pageLocation,
						deps.history,
						deps.storage,
					)
					applyView(joinResponseToStatus(result), { focus: true })
					schedulePoll()
				})
				.catch((error) => {
					challenge.reset()
					setBusy(false)
					const errorKey: ReservationErrorKey = waitlistErrorKey(error, 'join')
					if (errorKey === 'errorInvalid') {
						const paths = invalidFieldPaths(error)
						if (paths.some((path) => path.includes('phone'))) {
							showFieldError(phone.input, phone.error, labels.phoneInvalid)
						}
						if (paths.some((path) => path.includes('email'))) {
							showFieldError(email.input, email.error, labels.emailInvalid)
						}
						if (paths.some((path) => path.includes('name'))) {
							showFieldError(name.input, name.error, labels.fieldRequired)
						}
					}
					banner(labels[errorKey])
				})
		})

		void deps.loadPrefill?.().then((profile) => {
			if (!profile || destroyed) return
			if (!name.input.value) name.input.value = profile.name
			if (!phone.input.value) phone.input.value = profile.phone
			if (!email.input.value) email.input.value = profile.email
		})
	}

	// Status -------------------------------------------------------------------
	function deviceNow() {
		return now() + deviceOffsetMs
	}

	function deadlineClock(current: WaitlistStatus): string | null {
		if (!current.responseDeadlineAt) return null
		const deadline = Date.parse(current.responseDeadlineAt)
		if (Number.isNaN(deadline)) return null
		return formatHoldClock(Math.max(0, deadline - deviceNow()))
	}

	function applyView(next: WaitlistStatus, options: { focus?: boolean } = {}) {
		view = next
		const serverNow = Date.parse(next.now)
		deviceOffsetMs = Number.isNaN(serverNow) ? 0 : serverNow - now()
		const signature = statusSignature(next)
		if (signature === renderedSignature && !options.focus) return
		renderedSignature = signature
		renderStatus(options)
	}

	function renderStatus(options: { focus?: boolean } = {}) {
		if (!view) return
		const current = view
		setHeading('status')
		const focused = (document.activeElement as HTMLElement | null)?.dataset
			?.action
		const copy = waitlistStateCopy(
			labels,
			current.status,
			deadlineClock(current),
		)
		const active = isActiveWaitlistState(current.status)

		const card = el('section', cardClass)
		card.dataset.waitlist = 'status'
		card.dataset.state = current.status
		card.setAttribute('aria-labelledby', 'rsv-waitlist-state-heading')
		const heading = el(
			'h2',
			copy.tone === 'ready'
				? 'text-2xl font-bold text-foreground'
				: 'text-xl font-semibold text-foreground',
			copy.title,
		)
		heading.id = 'rsv-waitlist-state-heading'
		heading.tabIndex = -1
		card.append(heading)
		let bodyEl: HTMLElement | null = null
		if (copy.body) {
			bodyEl = el('p', 'text-sm text-muted-foreground', copy.body)
			bodyEl.dataset.stateBody = 'true'
			card.append(bodyEl)
		}

		if (active) {
			const rows = el('dl', 'grid gap-3 sm:grid-cols-3')
			const add = (term: string, value: string | Node) => {
				const wrap = el('div', 'flex flex-col gap-1')
				const dd = el('dd', 'text-lg font-semibold text-foreground')
				dd.append(value)
				wrap.append(
					el(
						'dt',
						'text-xs uppercase tracking-wide text-muted-foreground',
						term,
					),
					dd,
				)
				rows.append(wrap)
			}
			const number = (value: string | number) => {
				const bdi = el('bdi', undefined, value)
				bdi.dir = 'ltr'
				return bdi
			}
			if (current.position !== null && current.status !== 'notified') {
				const bdi = number(current.position)
				bdi.dataset.position = 'true'
				add(labels.waitlistPosition, bdi)
			}
			if (current.quotedMin !== null && current.status !== 'notified') {
				const bdi = el(
					'bdi',
					undefined,
					fillTemplate(labels.waitlistQuotedMinutes, {
						count: isolate(current.quotedMin),
					}),
				)
				bdi.dataset.quotedWait = 'true'
				add(labels.waitlistQuotedWait, bdi)
			}
			add(labels.partyLabel, guestsLabel(labels, current.partySize))
			if (current.locationName) add(labels.whereLabel, current.locationName)
			card.append(rows)

			const actions = el('div', 'flex flex-wrap gap-3')
			if (current.canOnMyWay) {
				const button = el(
					'button',
					current.status === 'notified'
						? primaryButtonClass
						: secondaryButtonClass,
					labels.waitlistOnMyWay,
				)
				button.type = 'button'
				button.dataset.action = 'on-my-way'
				button.disabled = busy
				button.addEventListener('click', () => void act('onMyWay'))
				actions.append(button)
			}
			if (current.canLeave) {
				const button = el('button', secondaryButtonClass, labels.waitlistLeave)
				button.type = 'button'
				button.dataset.action = 'leave'
				button.disabled = busy
				button.addEventListener('click', () => {
					confirmingLeave = true
					renderStatus()
					document
						.querySelector<HTMLElement>('[data-action="leave-keep"]')
						?.focus()
				})
				if (!confirmingLeave) actions.append(button)
			}
			if (actions.childElementCount > 0) card.append(actions)

			if (confirmingLeave && current.canLeave) {
				const confirm = el(
					'div',
					'flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-4',
				)
				confirm.setAttribute('role', 'group')
				confirm.setAttribute('aria-label', labels.waitlistLeaveConfirmTitle)
				const yes = el('button', primaryButtonClass, labels.waitlistLeaveYes)
				yes.type = 'button'
				yes.dataset.action = 'leave-yes'
				yes.disabled = busy
				yes.addEventListener('click', () => void act('leave'))
				const keep = el(
					'button',
					secondaryButtonClass,
					labels.waitlistLeaveKeep,
				)
				keep.type = 'button'
				keep.dataset.action = 'leave-keep'
				keep.addEventListener('click', () => {
					confirmingLeave = false
					renderStatus()
					document.querySelector<HTMLElement>('[data-action="leave"]')?.focus()
				})
				const choices = el('div', 'flex flex-wrap gap-3')
				choices.append(yes, keep)
				confirm.append(
					el(
						'p',
						'font-medium text-foreground',
						labels.waitlistLeaveConfirmTitle,
					),
					choices,
				)
				card.append(confirm)
			}
			card.append(
				el('p', 'text-xs text-muted-foreground', labels.waitlistSaveLinkNote),
			)
		} else {
			const actions = el('div', 'flex flex-wrap gap-3')
			if (current.status !== 'seated') {
				const again = el('button', primaryButtonClass, labels.waitlistJoinAgain)
				again.type = 'button'
				again.dataset.action = 'join-again'
				again.addEventListener('click', () => {
					forgetWaitlistToken(deps.pageLocation, deps.history, deps.storage)
					void showJoin()
				})
				actions.append(again)
			}
			actions.append(bookLink())
			card.append(actions)
		}

		stage.replaceChildren(card)
		if (copy.title !== lastAnnounced) {
			lastAnnounced = copy.title
			announcer.textContent = copy.title
		}
		if (options.focus) heading.focus()
		else if (focused) {
			card.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus()
		}
		startCountdown(bodyEl)
	}

	function startCountdown(bodyEl: HTMLElement | null) {
		clearInterval(countdownTimer)
		countdownTimer = undefined
		if (
			!view ||
			view.status !== 'notified' ||
			!view.responseDeadlineAt ||
			!bodyEl
		) {
			return
		}
		const current = view
		countdownTimer = setInterval(() => {
			const clock = deadlineClock(current)
			if (clock === null) return
			bodyEl.textContent = waitlistStateCopy(labels, current.status, clock).body
		}, 1000)
	}

	async function refresh() {
		if (!token || destroyed) return
		const seq = ++pollSeq
		try {
			const next = await api.waitlist.status(token)
			if (seq !== pollSeq || destroyed) return
			say(null)
			applyView(next)
		} catch (error) {
			if (seq !== pollSeq || destroyed) return
			const key = waitlistErrorKey(error, 'status')
			if (key === 'errorWaitlistLinkInvalid') {
				forgetWaitlistToken(deps.pageLocation, deps.history, deps.storage)
				token = null
				view = null
				stopTimers()
				renderLinkInvalid()
				return
			}
			say(labels[key], 'error')
		}
		schedulePoll()
	}

	function renderLinkInvalid() {
		setHeading('join')
		say(null)
		const card = el('section', cardClass)
		card.dataset.waitlist = 'link-invalid'
		const join = el('button', primaryButtonClass, labels.waitlistTitle)
		join.type = 'button'
		join.addEventListener('click', () => void showJoin())
		card.append(
			el('p', 'text-sm text-foreground', labels.errorWaitlistLinkInvalid),
			join,
		)
		stage.replaceChildren(card)
	}

	function schedulePoll() {
		clearTimeout(pollTimer)
		pollTimer = undefined
		if (destroyed || !view || !isActiveWaitlistState(view.status)) return
		pollTimer = setTimeout(() => {
			if (isHidden()) {
				schedulePoll()
				return
			}
			void refresh()
		}, pollMs)
	}

	async function act(kind: 'leave' | 'onMyWay') {
		if (!token || busy) return
		busy = true
		pollSeq++
		renderStatus()
		try {
			const next =
				kind === 'leave'
					? await api.waitlist.leave(token)
					: await api.waitlist.onMyWay(token)
			confirmingLeave = false
			busy = false
			say(kind === 'onMyWay' ? labels.waitlistOnMyWaySent : null)
			applyView(next, { focus: true })
			schedulePoll()
		} catch (error) {
			busy = false
			confirmingLeave = false
			const key = waitlistErrorKey(error, 'status')
			if (key !== 'errorWaitlistLinkInvalid') say(labels[key], 'error')
			renderStatus()
			await refresh()
		}
	}

	function onVisibility() {
		if (
			destroyed ||
			isHidden() ||
			!view ||
			!isActiveWaitlistState(view.status)
		) {
			return
		}
		void refresh()
	}
	if (typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', onVisibility)
	}

	token = takeWaitlistToken(deps.pageLocation, deps.storage)
	if (token) {
		setHeading('status')
		stage.replaceChildren(
			el('p', 'text-sm text-muted-foreground', labels.loading),
		)
		await refresh()
		if (!view && token) {
			const retry = el('button', primaryButtonClass, labels.waitlistRetry)
			retry.type = 'button'
			retry.addEventListener('click', () => void refresh())
			stage.replaceChildren(retry)
		}
	} else {
		await showJoin()
	}

	return {
		destroy() {
			destroyed = true
			stopTimers()
			if (typeof document !== 'undefined') {
				document.removeEventListener('visibilitychange', onVisibility)
			}
		},
	}
}
