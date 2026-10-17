import { type ReservationsApi } from './api.ts'
import {
	buildBookingFields,
	type DetailsErrors,
	splitName,
	validateDetails,
} from './details.ts'
import {
	invalidFieldPaths,
	type ReservationErrorKey,
	reservationErrorKey,
} from './errors.ts'
import { parseFragmentParam, stripFragment } from './fragment.ts'
import { holdRemainingMs, holdTargetMs, formatHoldClock } from './hold.ts'
import { type ReservationLabels } from './labels.ts'
import {
	createNotifyMeForm,
	offersNotifyMe,
	offersWaitlist,
} from './notify-me-form.ts'
import {
	addDaysIso,
	formatClock,
	formatDateLong,
	formatDateShort,
	formatHhmm,
	parseHhmm,
	todayIn,
	zoneNote,
} from './time.ts'
import {
	type Availability,
	type BookingResponse,
	type PublicSlot,
	type ReservationLocation,
	type ReservationsConfig,
	type SlotRef,
} from './types.ts'
import {
	bannerErrorClass,
	bannerInfoClass,
	cardClass,
	chipClass,
	createChallenge,
	downloadBlob,
	field,
	guestsLabel,
	inputClass,
	labelClass,
	primaryButtonClass,
	secondaryButtonClass,
	showFieldError,
	statusLabel,
} from './ui.ts'
import { randomUuid } from './uuid.ts'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'

const TERMS_VERSION = '2026-10'
const LARGE = 'large'

export type FlowDeps = {
	api: ReservationsApi
	labels: ReservationLabels
	/** Page locale, for dates and the booking's `locale`. */
	locale: string
	/** SMS opt-in is offered only where texting is allowed (not on the KSA node). */
	smsAllowed: boolean
	/** A sample number in the restaurant's region, shown in the phone hint. */
	phoneExample?: string
	turnstileSiteKey: string
	orgName: string
	/** `location.search` and `location.hash` of the page. */
	search: string
	hash: string
	history?: Pick<History, 'replaceState' | 'state'>
	pageLocation?: Pick<Location, 'hash' | 'pathname' | 'search'>
	manageHref: (token: string) => string
	/** The waitlist page for this site and locale; omitted when the page does not exist. */
	waitlistHref?: string
	loadPrefill: () => Promise<{
		name: string
		phone: string
		email: string
	} | null>
	signedIn: () => boolean
	now?: () => number
}

type DetailsValues = {
	guest: { firstName: string; lastName: string; phone: string; email: string }
	occasionTagId: string
	requests: string
	dietaryNames: string[]
	dietaryNotes: string
	smsOptIn: boolean
	marketingEmail: boolean
	marketingSms: boolean
	honeypot: string
}

type ActiveHold = {
	token: string
	target: number
	slot: SlotRef
	locationId: string
}

type Step = 'search' | 'details' | 'done'

const SLOT_LOST: ReservationErrorKey[] = [
	'errorSlotUnavailable',
	'errorHoldExpired',
]

export async function initReserveFlow(root: HTMLElement, deps: FlowDeps) {
	const { api, locale } = deps
	const now = deps.now ?? (() => Date.now())
	// Isolated so the sample number keeps its order inside right-to-left text.
	const phoneExample = `\u2066${deps.phoneExample ?? '+1 415 555 0123'}\u2069`
	const labels = {
		...deps.labels,
		phoneHint: fillTemplate(deps.labels.phoneHint, { example: phoneExample }),
		phoneInvalid: fillTemplate(deps.labels.phoneInvalid, {
			example: phoneExample,
		}),
	}
	root.replaceChildren()

	let config: ReservationsConfig
	try {
		config = await api.config(locale)
	} catch (error) {
		renderUnavailable(root, labels, error)
		return
	}
	if (config.locations.length === 0) {
		renderUnavailable(root, labels, null)
		return
	}

	const query = new URLSearchParams(deps.search)
	const firstLocation = config.locations[0]!
	let location: ReservationLocation =
		config.locations.find((item) => item.id === query.get('location')) ??
		firstLocation
	let partyValue: number | typeof LARGE = clampParty(
		Number(query.get('party')) || Math.min(2, location.partySize.max),
	)
	const serverNow = Date.parse(config.now) || now()
	let date =
		validDate(query.get('date')) ?? todayIn(location.timeZone, serverNow)
	const preferredMin = parseHhmm(query.get('time'))

	let hold: ActiveHold | null = null
	let holdTimer: ReturnType<typeof setInterval> | undefined
	let attemptKey: string | null = null
	let searchSeq = 0
	let step: Step = 'search'

	function maxOnline(place: ReservationLocation) {
		return place.partySize.max
	}
	function clampParty(value: number): number | typeof LARGE {
		if (
			value > maxOnline(location) &&
			location.largeParty.mode !== 'disabled'
		) {
			return LARGE
		}
		return Math.min(
			Math.max(value, location.partySize.min),
			maxOnline(location),
		)
	}
	function validDate(value: string | null) {
		return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
	}

	// Skeleton ---------------------------------------------------------------
	const statusBox = el('div')
	statusBox.setAttribute('aria-live', 'polite')

	const searchCard = el('section', cardClass)
	searchCard.setAttribute('aria-labelledby', 'rsv-find-heading')
	const findHeading = el(
		'h2',
		'text-lg font-semibold text-foreground',
		labels.stepFind,
	)
	findHeading.id = 'rsv-find-heading'
	const searchForm = el('form', 'grid gap-4 sm:grid-cols-2 lg:grid-cols-4')
	searchForm.noValidate = true
	searchForm.id = 'rsv-search'

	const locationSelect = el('select', inputClass)
	locationSelect.id = 'rsv-location'
	const partySelect = el('select', inputClass)
	partySelect.id = 'rsv-party'
	const dateInput = el('input', inputClass)
	dateInput.id = 'rsv-date'
	dateInput.type = 'date'
	dateInput.required = true
	const findButton = el('button', primaryButtonClass, labels.findButton)
	findButton.type = 'submit'

	function selectField(id: string, text: string, control: HTMLElement) {
		const wrap = el('div', 'flex flex-col gap-2')
		const label = el('label', labelClass, text)
		label.htmlFor = id
		wrap.append(label, control)
		return wrap
	}

	for (const place of config.locations) {
		const option = el('option', undefined, place.name)
		option.value = place.id
		locationSelect.append(option)
	}
	const locationField = selectField(
		'rsv-location',
		labels.fieldLocation,
		locationSelect,
	)
	locationField.hidden = config.locations.length < 2
	searchForm.append(
		locationField,
		selectField('rsv-party', labels.fieldParty, partySelect),
		selectField('rsv-date', labels.fieldDate, dateInput),
	)
	const buttonWrap = el('div', 'flex items-end')
	buttonWrap.append(findButton)
	searchForm.append(buttonWrap)
	const searchChallengeBox = el('div')
	const searchChallenge = createChallenge(
		searchChallengeBox,
		deps.turnstileSiteKey,
	)
	const zoneBox = el('p', 'text-sm text-muted-foreground')
	zoneBox.hidden = true
	const publicNote = el('p', 'text-sm text-muted-foreground')
	publicNote.hidden = true
	searchCard.append(
		findHeading,
		searchForm,
		searchChallengeBox,
		zoneBox,
		publicNote,
	)

	const resultsCard = el('section', cardClass)
	resultsCard.setAttribute('aria-labelledby', 'rsv-times-heading')
	resultsCard.hidden = true

	const largeCard = el('section', cardClass)
	largeCard.hidden = true

	const detailsCard = el('section', cardClass)
	detailsCard.setAttribute('aria-labelledby', 'rsv-details-heading')
	detailsCard.hidden = true

	const doneCard = el('section', cardClass)
	doneCard.setAttribute('aria-labelledby', 'rsv-done-heading')
	doneCard.hidden = true

	root.append(
		statusBox,
		searchCard,
		resultsCard,
		largeCard,
		detailsCard,
		doneCard,
	)

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

	function showStep(next: Step) {
		step = next
		searchCard.hidden = next !== 'search'
		const large = partyValue === LARGE
		resultsCard.hidden = next !== 'search' || large
		largeCard.hidden = next !== 'search' || !large
		detailsCard.hidden = next !== 'details'
		doneCard.hidden = next !== 'done'
	}

	function focusHeading(card: HTMLElement) {
		const heading = card.querySelector<HTMLElement>('h2')
		if (heading) {
			heading.tabIndex = -1
			heading.focus({ preventScroll: false })
		}
	}

	// Search controls ---------------------------------------------------------
	function fillPartyOptions() {
		partySelect.replaceChildren()
		for (
			let size = location.partySize.min;
			size <= maxOnline(location);
			size++
		) {
			const option = el('option', undefined, guestsLabel(labels, size))
			option.value = String(size)
			partySelect.append(option)
		}
		if (location.largeParty.mode !== 'disabled') {
			const option = el('option', undefined, labels.largerParty)
			option.value = LARGE
			partySelect.append(option)
		}
		partySelect.value = String(partyValue)
	}

	function applyLocation() {
		const today = todayIn(location.timeZone, serverNow)
		dateInput.min = today
		dateInput.max = addDaysIso(today, location.horizonDays)
		if (date < today) date = today
		dateInput.value = date
		fillPartyOptions()
		const zone = zoneNote(location.timeZone)
		zoneBox.hidden = !zone
		zoneBox.textContent = zone
			? fillTemplate(labels.restaurantZone, { zone })
			: ''
		publicNote.hidden = !location.publicNote
		publicNote.textContent = location.publicNote ?? ''
	}

	locationSelect.value = location.id
	applyLocation()

	function readControls() {
		location =
			config.locations.find((item) => item.id === locationSelect.value) ??
			location
		const chosen = partySelect.value
		partyValue =
			chosen === LARGE ? LARGE : Number(chosen) || location.partySize.min
		date = dateInput.value || date
	}

	locationSelect.addEventListener('change', () => {
		readControls()
		applyLocation()
		void search()
	})
	partySelect.addEventListener('change', () => {
		readControls()
		void search()
	})
	dateInput.addEventListener('change', () => {
		readControls()
		void search()
	})
	searchForm.addEventListener('submit', (event) => {
		event.preventDefault()
		readControls()
		void search()
	})

	// Availability ------------------------------------------------------------
	function slotChip(slot: PublicSlot, slotDate: string, partySize: number) {
		const time = formatClock(slot.localMin, locale)
		const area = slot.areaLabel?.trim() || null
		const chip = el('button', chipClass)
		chip.type = 'button'
		chip.dataset.time = formatHhmm(slot.localMin)
		chip.dataset.localMin = String(slot.localMin)
		chip.setAttribute('aria-pressed', 'false')
		if (area) {
			chip.className = `${chipClass} flex-col gap-0.5 py-1.5`
			chip.append(el('span', undefined, time))
			const areaText = el(
				'span',
				'text-xs font-normal text-muted-foreground',
				area,
			)
			areaText.dataset.area = 'true'
			chip.append(areaText)
		} else {
			chip.textContent = time
		}
		const base = area
			? fillTemplate(labels.selectTimeArea, { time, area })
			: fillTemplate(labels.selectTime, { time })
		chip.setAttribute(
			'aria-label',
			`${base}${slot.serviceName ? `, ${slot.serviceName}` : ''}`,
		)
		chip.addEventListener('click', () => {
			void chooseSlot(slot, slotDate, partySize, chip)
		})
		return chip
	}

	function renderNoSlotOffers(result: Availability) {
		if (offersNotifyMe(result)) {
			const host = el('div', 'flex flex-col gap-3')
			host.dataset.notifyHost = 'true'
			const open = el('button', secondaryButtonClass, labels.notifySubmit)
			open.type = 'button'
			open.dataset.notifyOpen = 'true'
			open.addEventListener('click', () => {
				const today = todayIn(result.timeZone || location.timeZone, serverNow)
				const form = createNotifyMeForm({
					api,
					labels: deps.labels,
					locale,
					orgName: deps.orgName,
					phoneExample: deps.phoneExample ?? '+1 415 555 0123',
					turnstileSiteKey: deps.turnstileSiteKey,
					locationId: location.id,
					partySize: location.partySize,
					search: {
						partySize: result.partySize,
						date: result.date,
						preferredMin,
					},
					dateRange: {
						min: today,
						max: addDaysIso(today, location.horizonDays),
					},
					signedIn: deps.signedIn,
				})
				host.replaceChildren(form.element)
				form.element.querySelector<HTMLElement>('input, select')?.focus()
			})
			host.append(
				el('p', 'text-sm text-muted-foreground', labels.notifyBody),
				open,
			)
			resultsCard.append(host)
		}
		if (deps.waitlistHref && offersWaitlist(result)) {
			const host = el('div', 'flex flex-col gap-3')
			host.dataset.waitlistOffer = 'true'
			const params = new URLSearchParams({
				location: location.id,
				party: String(result.partySize),
			})
			const link = el('a', secondaryButtonClass, labels.waitlistTitle)
			link.href = `${deps.waitlistHref}?${params.toString()}`
			host.append(
				el('p', 'text-sm text-muted-foreground', labels.waitlistSameDayHint),
				link,
			)
			resultsCard.append(host)
		}
	}

	function renderResults(result: Availability) {
		resultsCard.replaceChildren()
		const heading = el(
			'h2',
			'text-lg font-semibold text-foreground',
			labels.timesHeading,
		)
		heading.id = 'rsv-times-heading'
		const partySize = result.partySize
		const meta = el(
			'p',
			'text-sm text-muted-foreground',
			fillTemplate(labels.timesFor, {
				party: guestsLabel(labels, partySize),
				date: formatDateLong(result.date, locale),
			}),
		)
		resultsCard.append(heading, meta)

		if (result.slots.length > 0) {
			const groups = new Map<string, PublicSlot[]>()
			for (const slot of result.slots) {
				const key = slot.serviceName || ''
				groups.set(key, [...(groups.get(key) ?? []), slot])
			}
			for (const [name, slots] of groups) {
				const group = el('div', 'flex flex-col gap-2')
				if (name && groups.size > 1) {
					group.append(
						el('h3', 'text-sm font-medium text-muted-foreground', name),
					)
				}
				const chips = el('div', 'flex flex-wrap gap-2')
				chips.setAttribute('role', 'group')
				chips.setAttribute('aria-label', name || labels.timesHeading)
				for (const slot of slots)
					chips.append(slotChip(slot, result.date, partySize))
				group.append(chips)
				resultsCard.append(group)
			}
			const preferred =
				preferredMin === null
					? null
					: result.slots.find((slot) => slot.localMin === preferredMin)
			if (preferred) {
				const chip = resultsCard.querySelector<HTMLElement>(
					`[data-local-min="${preferred.localMin}"]`,
				)
				chip?.setAttribute('data-preferred', 'true')
				chip?.classList.add('ring-2', 'ring-primary')
			}
			return
		}

		const reason = emptyReason(result)
		resultsCard.append(el('p', 'font-medium text-foreground', reason.title))
		if (reason.body)
			resultsCard.append(el('p', 'text-sm text-muted-foreground', reason.body))

		const sameDay = result.alternatives?.sameDay ?? []
		if (sameDay.length > 0) {
			const group = el('div', 'flex flex-col gap-2')
			group.append(
				el(
					'h3',
					'text-sm font-medium text-muted-foreground',
					labels.sameDayHeading,
				),
			)
			const chips = el('div', 'flex flex-wrap gap-2')
			for (const slot of sameDay)
				chips.append(slotChip(slot, result.date, partySize))
			group.append(chips)
			resultsCard.append(group)
		}
		const otherDates = result.alternatives?.otherDates ?? []
		if (otherDates.length > 0) {
			const group = el('div', 'flex flex-col gap-2')
			group.append(
				el(
					'h3',
					'text-sm font-medium text-muted-foreground',
					labels.otherDatesHeading,
				),
			)
			const buttons = el('div', 'flex flex-wrap gap-2')
			for (const alt of otherDates) {
				const button = el(
					'button',
					chipClass,
					fillTemplate(labels.otherDateOption, {
						date: formatDateShort(alt.date, locale),
						time: formatClock(alt.firstLocalMin, locale),
					}),
				)
				button.type = 'button'
				button.dataset.date = alt.date
				button.addEventListener('click', () => {
					date = alt.date
					dateInput.value = alt.date
					void search()
				})
				buttons.append(button)
			}
			group.append(buttons)
			resultsCard.append(group)
		}
		renderNoSlotOffers(result)
	}

	function emptyReason(result: Availability): {
		title: string
		body: string | null
	} {
		if (result.status === 'closed') {
			return { title: labels.closedDay, body: result.closed?.note ?? null }
		}
		if (result.status === 'online_closed') {
			return {
				title: labels.onlineClosed,
				body: result.onlineClosed?.note ?? null,
			}
		}
		if (result.status === 'beyond_horizon') {
			return { title: labels.beyondHorizon, body: null }
		}
		return { title: labels.noSlotsTitle, body: labels.noSlotsBody }
	}

	async function search(options: { announce?: boolean } = {}) {
		if (partyValue === LARGE) {
			showStep('search')
			renderLarge()
			return
		}
		const seq = ++searchSeq
		showStep('search')
		resultsCard.replaceChildren(
			el('p', 'text-sm text-muted-foreground', labels.searching),
		)
		resultsCard.setAttribute('aria-busy', 'true')
		try {
			const result = await api.availability({
				locationId: location.id,
				date,
				partySize: partyValue,
				locale,
			})
			if (seq !== searchSeq) return
			renderResults(result)
			if (options.announce) focusHeading(resultsCard)
		} catch (error) {
			if (seq !== searchSeq) return
			resultsCard.replaceChildren()
			say(labels[reservationErrorKey(error)], 'error')
		} finally {
			if (seq === searchSeq) resultsCard.removeAttribute('aria-busy')
		}
	}

	// Hold --------------------------------------------------------------------
	async function chooseSlot(
		slot: PublicSlot,
		slotDate: string,
		partySize: number,
		chip: HTMLButtonElement,
	) {
		if (
			searchChallenge.enabled &&
			!searchChallenge.token() &&
			!deps.signedIn()
		) {
			say(labels.verifyFirst, 'error')
			return
		}
		say(null)
		const chips = resultsCard.querySelectorAll<HTMLButtonElement>('button')
		for (const button of chips) button.disabled = true
		chip.setAttribute('aria-pressed', 'true')
		try {
			const created = await api.createHold({
				locationId: location.id,
				slot: {
					date: slotDate,
					localMin: slot.localMin,
					partySize,
					serviceId: slot.serviceId || null,
				},
				areaPref: slot.areaId || null,
				replaceHoldToken: hold?.token ?? null,
				website: '',
				turnstileToken: searchChallenge.token(),
			})
			searchChallenge.reset()
			startHold({
				holdToken: created.holdToken,
				expiresAt: created.expiresAt,
				now: created.now,
				locationId: created.locationId ?? location.id,
				slot: created.slot,
			})
		} catch (error) {
			searchChallenge.reset()
			const key = reservationErrorKey(error)
			say(labels[key], 'error')
			if (key === 'errorSlotUnavailable') void search()
			else for (const button of chips) button.disabled = false
			chip.setAttribute('aria-pressed', 'false')
		}
	}

	const bookingForm = buildDetailsForm({
		idPrefix: 'rsv',
		submitLabel: labels.submit,
		onSubmit: (values) => submitBooking(values),
		onBack: () => void leaveHold(),
		backLabel: labels.changeTime,
	})
	const holdBanner = el('p', 'text-sm font-medium text-foreground')
	const countdown = el(
		'p',
		'font-mono text-2xl font-semibold tabular-nums text-foreground',
	)
	countdown.dir = 'ltr'
	countdown.setAttribute('role', 'timer')
	const holdSummary = el('p', 'text-sm text-muted-foreground')
	const detailsHeading = el(
		'h2',
		'text-lg font-semibold text-foreground',
		labels.holdHeading,
	)
	detailsHeading.id = 'rsv-details-heading'
	detailsCard.append(
		detailsHeading,
		countdown,
		holdSummary,
		holdBanner,
		bookingForm.element,
	)

	function startHold(created: {
		holdToken: string
		expiresAt: string
		now: string
		locationId: string
		slot: SlotRef
	}) {
		const target = holdTargetMs(created, now())
		if (target === null) {
			say(labels.errorGeneric, 'error')
			return
		}
		hold = {
			token: created.holdToken,
			target,
			slot: created.slot,
			locationId: created.locationId,
		}
		attemptKey = randomUuid()
		clearInterval(holdTimer)
		holdSummary.textContent = fillTemplate(labels.holdSummary, {
			party: guestsLabel(labels, created.slot.partySize),
			date: formatDateLong(created.slot.date, locale),
			time: formatClock(created.slot.localMin, locale),
		})
		bookingForm.reset()
		tick()
		holdTimer = setInterval(tick, 1000)
		showStep('details')
		focusHeading(detailsCard)
	}

	function tick() {
		if (!hold) return
		const remaining = holdRemainingMs(hold.target, now())
		const clock = formatHoldClock(remaining)
		countdown.textContent = clock
		countdown.setAttribute(
			'aria-label',
			fillTemplate(labels.holdCountdown, { time: clock }),
		)
		if (remaining <= 0) void expireHold()
	}

	function dropHold() {
		clearInterval(holdTimer)
		holdTimer = undefined
		hold = null
		attemptKey = null
	}

	async function expireHold() {
		dropHold()
		say(`${labels.holdExpiredTitle}. ${labels.errorHoldExpired}`, 'error')
		showStep('search')
		await search({ announce: false })
		searchCard.scrollIntoView?.({ block: 'start' })
	}

	async function leaveHold() {
		const token = hold?.token
		dropHold()
		say(null)
		showStep('search')
		if (token) void api.releaseHold(token).catch(() => undefined)
		await search({ announce: true })
	}

	globalThis.addEventListener?.('pagehide', () => {
		if (hold && step === 'details')
			void api.releaseHold(hold.token).catch(() => undefined)
	})

	// Booking -----------------------------------------------------------------
	async function submitBooking(values: DetailsValues) {
		if (!hold) return
		const challengeOk =
			!bookingForm.challenge.enabled ||
			bookingForm.challenge.token() ||
			deps.signedIn()
		if (!challengeOk) {
			bookingForm.banner(labels.verifyFirst)
			return
		}
		bookingForm.setBusy(true, labels.submitting)
		try {
			const result = await api.book(
				{
					holdToken: hold.token,
					...buildBookingFields({
						guest: values.guest,
						occasionTagId: values.occasionTagId,
						requests: values.requests,
						dietaryNames: values.dietaryNames,
						dietaryNotes: values.dietaryNotes,
						smsOptIn: values.smsOptIn,
						marketingEmail: values.marketingEmail,
						marketingSms: values.marketingSms,
						locale,
						honeypot: values.honeypot,
						turnstileToken: bookingForm.challenge.token(),
						termsVersion: TERMS_VERSION,
					}),
				},
				attemptKey ?? undefined,
			)
			bookingForm.challenge.reset()
			dropHold()
			renderDone(result)
		} catch (error) {
			bookingForm.challenge.reset()
			handleSubmitError(bookingForm, error)
		}
	}

	function handleSubmitError(form: DetailsForm, error: unknown) {
		const key = reservationErrorKey(error)
		form.setBusy(false)
		if (SLOT_LOST.includes(key)) {
			dropHold()
			say(labels[key], 'error')
			showStep('search')
			void search({ announce: false })
			return
		}
		if (key === 'errorInvalid') form.markServerFields(invalidFieldPaths(error))
		form.banner(labels[key])
	}

	function renderDone(result: BookingResponse) {
		const summary = result.reservation
		const requested = summary.status === 'requested'
		doneCard.replaceChildren()
		const heading = el(
			'h2',
			'text-xl font-semibold text-foreground',
			requested ? labels.requestedTitle : labels.confirmedTitle,
		)
		heading.id = 'rsv-done-heading'
		const body = el(
			'p',
			'text-sm text-muted-foreground',
			requested
				? fillTemplate(labels.requestedBody, {
						name: summary.locationName ?? deps.orgName,
					})
				: labels.confirmedBody,
		)

		const rows = el('dl', 'grid gap-3 sm:grid-cols-2')
		const addRow = (term: string, value: string, ltr = false) => {
			const wrap = el('div', 'flex flex-col gap-1')
			wrap.append(
				el('dt', 'text-xs uppercase tracking-wide text-muted-foreground', term),
			)
			const dd = el('dd', 'text-base font-medium text-foreground', value)
			if (ltr) dd.dir = 'ltr'
			wrap.append(dd)
			rows.append(wrap)
		}
		const code = el('div', 'flex flex-col gap-1')
		code.append(
			el(
				'dt',
				'text-xs uppercase tracking-wide text-muted-foreground',
				labels.confirmationCode,
			),
		)
		const codeValue = el(
			'dd',
			'font-mono text-2xl font-semibold tracking-widest text-foreground',
			summary.confirmationCode,
		)
		codeValue.dir = 'ltr'
		codeValue.dataset.confirmationCode = ''
		code.append(codeValue)
		rows.append(code)
		addRow(labels.whereLabel, summary.locationName ?? location.name)
		addRow(
			labels.whenLabel,
			`${formatDateLong(summary.date, locale)}, ${formatClock(summary.localMin, locale)}`,
		)
		addRow(labels.partyLabel, guestsLabel(labels, summary.partySize))
		if (requested) addRow('', statusLabel(labels, summary.status))

		const actions = el('div', 'flex flex-wrap gap-3')
		const ics = el('button', secondaryButtonClass, labels.addToCalendar)
		ics.type = 'button'
		ics.addEventListener('click', () => {
			ics.disabled = true
			api.manage
				.ics(result.manageToken)
				.then((blob) =>
					downloadBlob(blob, `reservation-${summary.confirmationCode}.ics`),
				)
				.catch(() => say(labels.errorGeneric, 'error'))
				.finally(() => {
					ics.disabled = false
				})
		})
		const manage = el('a', primaryButtonClass, labels.manageLink)
		manage.href = deps.manageHref(result.manageToken)
		manage.dataset.manageLink = ''
		const another = el('a', secondaryButtonClass, labels.bookAnother)
		another.href = deps.pageLocation?.pathname ?? '/reserve'
		actions.append(manage, ics, another)

		const note = el('p', 'text-xs text-muted-foreground', labels.saveLinkNote)
		doneCard.append(heading, body, rows, actions, note)
		say(null)
		showStep('done')
		focusHeading(doneCard)
	}

	// Large parties -----------------------------------------------------------
	function renderLarge() {
		largeCard.replaceChildren()
		showStep('search')
		const mode = location.largeParty.mode
		const maxSize = maxOnline(location)
		if (mode === 'contact') {
			const heading = el(
				'h2',
				'text-lg font-semibold text-foreground',
				fillTemplate(labels.largeContactTitle, { count: maxSize }),
			)
			largeCard.append(
				heading,
				el('p', 'text-sm text-muted-foreground', labels.largeContactBody),
			)
			if (location.largeParty.note) {
				largeCard.append(
					el('p', 'text-sm text-foreground', location.largeParty.note),
				)
			}
			const phone = location.largeParty.phone ?? location.phone
			if (phone) {
				const call = el(
					'a',
					primaryButtonClass,
					fillTemplate(labels.largeCall, { phone }),
				)
				call.href = `tel:${phone.replace(/[^\d+]/g, '')}`
				call.dir = 'ltr'
				largeCard.append(call)
			}
			return
		}
		const heading = el(
			'h2',
			'text-lg font-semibold text-foreground',
			fillTemplate(labels.largeRequestTitle, { count: maxSize }),
		)
		largeCard.append(
			heading,
			el('p', 'text-sm text-muted-foreground', labels.largeRequestBody),
		)

		const sizeField = field({
			id: 'rsv-large-size',
			name: 'partySize',
			label: labels.fieldParty,
			type: 'number',
			dir: 'ltr',
		})
		sizeField.input.min = String(maxSize + 1)
		sizeField.input.max = String(
			Math.max(
				maxSize + 1,
				location.largeParty.maxOnlinePartySize || maxSize + 1,
			),
		)
		sizeField.input.value = String(maxSize + 1)
		const timeField = field({
			id: 'rsv-large-time',
			name: 'time',
			label: labels.fieldTime,
			type: 'time',
			dir: 'ltr',
			value: formatHhmm(preferredMin ?? 19 * 60),
		})
		const requestKey = randomUuid()
		const requestForm: DetailsForm = buildDetailsForm({
			idPrefix: 'rsv-large',
			submitLabel: labels.largeSubmit,
			onSubmit: async (values) => {
				const size = Number(sizeField.input.value)
				const localMin = parseHhmm(timeField.input.value)
				let ok = true
				if (!Number.isInteger(size) || size <= maxSize) {
					showFieldError(
						sizeField.input,
						sizeField.error,
						labels.errorPartySize,
					)
					ok = false
				} else showFieldError(sizeField.input, sizeField.error, null)
				if (localMin === null) {
					showFieldError(timeField.input, timeField.error, labels.fieldRequired)
					ok = false
				} else showFieldError(timeField.input, timeField.error, null)
				if (!ok || localMin === null) {
					requestForm.banner(labels.fixFields)
					return
				}
				requestForm.setBusy(true, labels.submitting)
				try {
					const result = await api.requestLargeParty(
						{
							locationId: location.id,
							slot: { date, localMin, partySize: size },
							...buildBookingFields({
								guest: values.guest,
								occasionTagId: values.occasionTagId,
								requests: values.requests,
								dietaryNames: values.dietaryNames,
								dietaryNotes: values.dietaryNotes,
								smsOptIn: values.smsOptIn,
								marketingEmail: values.marketingEmail,
								marketingSms: values.marketingSms,
								locale,
								honeypot: values.honeypot,
								turnstileToken: requestForm.challenge.token(),
								termsVersion: TERMS_VERSION,
							}),
						},
						requestKey,
					)
					requestForm.challenge.reset()
					renderDone(result)
				} catch (error) {
					requestForm.challenge.reset()
					requestForm.setBusy(false)
					if (reservationErrorKey(error) === 'errorInvalid') {
						requestForm.markServerFields(invalidFieldPaths(error))
					}
					requestForm.banner(labels[reservationErrorKey(error)])
				}
			},
		})
		requestForm.element.prepend(sizeField.wrapper, timeField.wrapper)
		largeCard.append(requestForm.element)
	}

	// Details form ------------------------------------------------------------
	type DetailsForm = ReturnType<typeof buildDetailsForm>

	function buildDetailsForm(options: {
		idPrefix: string
		submitLabel: string
		onSubmit: (values: DetailsValues) => void | Promise<void>
		onBack?: () => void
		backLabel?: string
	}) {
		const id = options.idPrefix
		const form = el('form', 'flex flex-col gap-4')
		form.noValidate = true

		const first = field({
			id: `${id}-first-name`,
			name: 'firstName',
			label: labels.firstName,
			autocomplete: 'given-name',
			maxLength: 80,
			required: true,
		})
		const last = field({
			id: `${id}-last-name`,
			name: 'lastName',
			label: labels.lastName,
			optional: labels.optional,
			autocomplete: 'family-name',
			maxLength: 80,
		})
		const phone = field({
			id: `${id}-phone`,
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
			id: `${id}-email`,
			name: 'email',
			label: labels.email,
			type: 'email',
			hint: labels.emailHint,
			optional: labels.optional,
			autocomplete: 'email',
			maxLength: 254,
			dir: 'ltr',
		})
		const names = el('div', 'grid gap-4 sm:grid-cols-2')
		names.append(first.wrapper, last.wrapper)
		const contact = el('div', 'grid gap-4 sm:grid-cols-2')
		contact.append(phone.wrapper, email.wrapper)
		form.append(names, contact)

		let occasionSelect: HTMLSelectElement | null = null
		if (config.occasions.length > 0) {
			const wrap = el('div', 'flex flex-col gap-2')
			const label = el('label', labelClass, labels.occasion)
			label.htmlFor = `${id}-occasion`
			occasionSelect = el('select', inputClass)
			occasionSelect.id = `${id}-occasion`
			const none = el('option', undefined, labels.occasionNone)
			none.value = ''
			occasionSelect.append(none)
			for (const occasion of config.occasions) {
				const option = el('option', undefined, occasion.name)
				option.value = occasion.id
				occasionSelect.append(option)
			}
			wrap.append(label, occasionSelect)
			form.append(wrap)
		}

		const dietaryBoxes: Array<{ input: HTMLInputElement; name: string }> = []
		if (config.dietary.length > 0) {
			const set = el('fieldset', 'flex flex-col gap-2')
			set.append(el('legend', labelClass, labels.dietary))
			const row = el('div', 'flex flex-wrap gap-2')
			for (const tag of config.dietary) {
				const wrap = el(
					'label',
					'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10',
				)
				const input = el('input', 'size-4 accent-primary')
				input.type = 'checkbox'
				input.value = tag.id
				wrap.append(input, document.createTextNode(tag.name))
				dietaryBoxes.push({ input, name: tag.name })
				row.append(wrap)
			}
			set.append(row)
			form.append(set)
		}
		const dietaryNotes = field({
			id: `${id}-dietary-notes`,
			name: 'dietaryNotes',
			label: labels.dietaryNotes,
			optional: labels.optional,
			maxLength: 200,
		})
		const requests = el('textarea', `${inputClass} h-auto resize-y`)
		requests.id = `${id}-requests`
		requests.rows = 3
		requests.maxLength = 500
		const requestsWrap = el('div', 'flex flex-col gap-2')
		const requestsLabel = el('label', labelClass, labels.requests)
		requestsLabel.htmlFor = requests.id
		requestsLabel.append(
			el('span', 'font-normal text-muted-foreground', ` ${labels.optional}`),
		)
		requestsWrap.append(requestsLabel, requests)
		form.append(dietaryNotes.wrapper, requestsWrap)

		function checkbox(name: string, text: string, checked = false) {
			const wrap = el(
				'label',
				'flex cursor-pointer items-start gap-3 text-sm text-foreground',
			)
			const input = el('input', 'mt-0.5 size-5 shrink-0 accent-primary')
			input.type = 'checkbox'
			input.name = name
			input.checked = checked
			wrap.append(input, el('span', undefined, text))
			return { wrap, input }
		}
		const sms = deps.smsAllowed ? checkbox('smsOptIn', labels.smsOptIn) : null
		const marketingEmail = checkbox(
			'marketingEmail',
			fillTemplate(labels.marketingEmail, { name: deps.orgName }),
		)
		const marketingSms = deps.smsAllowed
			? checkbox(
					'marketingSms',
					fillTemplate(labels.marketingSms, { name: deps.orgName }),
				)
			: null
		const consents = el('div', 'flex flex-col gap-3')
		if (sms) consents.append(sms.wrap)
		consents.append(marketingEmail.wrap)
		if (marketingSms) consents.append(marketingSms.wrap)
		form.append(
			consents,
			el(
				'p',
				'text-xs text-muted-foreground',
				fillTemplate(labels.contactNote, { name: deps.orgName }),
			),
		)

		const trap = el('div', 'hidden')
		trap.setAttribute('aria-hidden', 'true')
		const trapInput = el('input')
		trapInput.name = 'website'
		trapInput.tabIndex = -1
		trapInput.autocomplete = 'off'
		trap.append(trapInput)
		form.append(trap)

		const challengeBox = el('div')
		const challenge = createChallenge(challengeBox, deps.turnstileSiteKey)
		form.append(challengeBox)

		const bannerBox = el('div')
		const submit = el('button', primaryButtonClass, options.submitLabel)
		submit.type = 'submit'
		const actions = el('div', 'flex flex-wrap gap-3')
		actions.append(submit)
		if (options.onBack) {
			const back = el(
				'button',
				secondaryButtonClass,
				options.backLabel ?? labels.back,
			)
			back.type = 'button'
			back.addEventListener('click', options.onBack)
			actions.append(back)
		}
		form.append(bannerBox, actions)

		const fieldMap = {
			firstName: first,
			phone,
			email,
		} as const

		function banner(text: string | null) {
			bannerBox.replaceChildren()
			if (!text) return
			const note = el('p', bannerErrorClass, text)
			note.setAttribute('role', 'alert')
			bannerBox.append(note)
		}

		function showErrors(errors: DetailsErrors) {
			const text = (
				code: 'required' | 'invalid' | undefined,
				invalid: string,
			) =>
				code ? (code === 'required' ? labels.fieldRequired : invalid) : null
			showFieldError(
				first.input,
				first.error,
				text(errors.firstName, labels.fieldRequired),
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

		function read(): DetailsValues {
			return {
				guest: {
					firstName: first.input.value,
					lastName: last.input.value,
					phone: phone.input.value,
					email: email.input.value,
				},
				occasionTagId: occasionSelect?.value ?? '',
				requests: requests.value,
				dietaryNames: dietaryBoxes
					.filter((box) => box.input.checked)
					.map((box) => box.name),
				dietaryNotes: dietaryNotes.input.value,
				smsOptIn: sms?.input.checked ?? false,
				marketingEmail: marketingEmail.input.checked,
				marketingSms: marketingSms?.input.checked ?? false,
				honeypot: trapInput.value,
			}
		}

		form.addEventListener('submit', (event) => {
			event.preventDefault()
			banner(null)
			const values = read()
			const errors = validateDetails(values.guest)
			showErrors(errors)
			const firstBad = (['firstName', 'phone', 'email'] as const).find(
				(key) => errors[key],
			)
			if (firstBad) {
				banner(labels.fixFields)
				fieldMap[firstBad].input.focus()
				return
			}
			void options.onSubmit(values)
		})

		const prefill = deps.loadPrefill().then((profile) => {
			if (!profile) return
			const name = splitName(profile.name)
			if (!first.input.value) first.input.value = name.firstName
			if (!last.input.value) last.input.value = name.lastName
			if (!phone.input.value) phone.input.value = profile.phone
			if (!email.input.value) email.input.value = profile.email
			form.prepend(el('p', bannerInfoClass, labels.signedInNote))
		})
		void prefill

		return {
			element: form,
			challenge,
			banner,
			reset() {
				banner(null)
				showErrors({})
				submit.disabled = false
				submit.textContent = options.submitLabel
			},
			setBusy(busy: boolean, text?: string) {
				submit.disabled = busy
				submit.textContent = busy && text ? text : options.submitLabel
			},
			markServerFields(paths: string[]) {
				if (paths.some((path) => path.includes('phone'))) {
					showFieldError(phone.input, phone.error, labels.phoneInvalid)
				}
				if (paths.some((path) => path.includes('email'))) {
					showFieldError(email.input, email.error, labels.emailInvalid)
				}
				if (paths.some((path) => path.includes('firstName'))) {
					showFieldError(first.input, first.error, labels.fieldRequired)
				}
			},
		}
	}

	// Voice-agent resume: `#h=<holdToken>` continues a hold made on a call.
	const resumeToken = parseFragmentParam(deps.hash, 'h')
	if (resumeToken && deps.pageLocation && deps.history) {
		stripFragment(deps.pageLocation, deps.history)
	}
	if (resumeToken) {
		try {
			const current = await api.currentHold(resumeToken)
			const place = config.locations.find(
				(item) => item.id === current.locationId,
			)
			if (place) {
				location = place
				locationSelect.value = place.id
				partyValue = current.slot.partySize
				date = current.slot.date
				applyLocation()
				startHold({
					holdToken: resumeToken,
					expiresAt: current.expiresAt,
					now: current.now,
					locationId: place.id,
					slot: current.slot,
				})
				return
			}
		} catch {
			// An expired or unknown voice hold falls through to a normal search.
		}
	}

	await search({ announce: false })
}

function renderUnavailable(
	root: HTMLElement,
	labels: ReservationLabels,
	error: unknown,
) {
	root.replaceChildren()
	const card = el('section', cardClass)
	card.setAttribute('role', 'status')
	card.dataset.unavailable = ''
	card.append(
		el('h2', 'text-lg font-semibold text-foreground', labels.unavailableTitle),
		el('p', 'text-sm text-muted-foreground', labels.unavailableBody),
	)
	if (error && reservationErrorKey(error) === 'errorNetwork') {
		card.append(el('p', 'text-sm text-muted-foreground', labels.errorNetwork))
	}
	root.append(card)
}
