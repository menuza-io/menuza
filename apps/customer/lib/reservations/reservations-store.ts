import * as Linking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import { AppState } from 'react-native'
import { type CustomerProfile } from '../api/public-site'
import { isTransportSafe } from '../config/configuration'
import { isValidPhone } from '../support/phone-number'
import {
	BookingFlow,
	type BookingFailure,
	type BookingFlowState,
	holdCountdownLabel,
	type KeyMaker,
	makeIdempotencyKey,
	manageActions,
	mapBookingFailure,
	PaymentPoll,
	reservationDateStrip,
	WaitlistFlow,
	type WaitlistFlowState,
} from './booking-flow'
import {
	interpretPaymentStatus,
	isFinalPaymentOutcome,
	type PaymentOutcome,
	parseServerTime,
	partyCeiling,
	ReservationApiError,
	makeGuestDetails,
	type ReservationAvailability,
	type ReservationBooking,
	type ReservationGuestDetails,
	type ReservationLocation,
	type ReservationManageView,
	type ReservationMine,
	type ReservationsConfig,
	type ReservationSlot,
} from './models'
import { type ReservationsClient } from './reservations-client'
import { type ReservationTokenStore } from './token-store'

// Drives the reservation screens. The rules live in `BookingFlow`,
// `WaitlistFlow` and `ReservationsClient`; this store calls the client, feeds
// each answer to the flows and publishes an immutable snapshot after every
// change. It knows nothing about React: subscribe with
// `useSyncExternalStore(store.subscribe, store.getSnapshot)`.
//
// Secrets (hold, manage and status tokens) stay in memory or in secure storage
// through `ReservationTokenStore`. Nothing here logs a token or guest detail.

export type ReservationsApi = Pick<
	ReservationsClient,
	| 'config'
	| 'availability'
	| 'createHold'
	| 'releaseHold'
	| 'book'
	| 'requestLargeParty'
	| 'mine'
	| 'manage'
	| 'manageAvailability'
	| 'modify'
	| 'cancel'
	| 'runningLate'
	| 'paymentStatus'
	| 'joinWaitlist'
	| 'waitlistStatus'
	| 'leaveWaitlist'
	| 'waitlistOnMyWay'
>

export type ReservationsLoadState =
	| { kind: 'idle' }
	| { kind: 'loading' }
	| { kind: 'ready' }
	/** Online reservations are switched off (or no location accepts them). */
	| { kind: 'unavailable' }
	| { kind: 'failed'; failure: BookingFailure }

export type ReservationsTimers = {
	setTimeout(callback: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

/** Whether the app is in front; the waitlist stops polling while it is not. */
export type AppActivity = {
	isActive(): boolean
	subscribe(listener: (active: boolean) => void): () => void
}

const deviceActivity: AppActivity = {
	isActive: () => AppState.currentState !== 'background',
	subscribe(listener) {
		const subscription = AppState.addEventListener('change', (state) =>
			listener(state !== 'background'),
		)
		return () => subscription.remove()
	},
}

export type ReservationsStoreOptions = {
	client: ReservationsApi
	tokens: ReservationTokenStore
	/** The app language, kept current with `setLocale`. */
	localeCode: string
	/** Device clock in epoch milliseconds. */
	now?: () => number
	timers?: ReservationsTimers
	/** Opens the payment page; defaults to the in-app browser. */
	openBrowser?: (url: string) => Promise<unknown>
	/** Opens a `tel:` link; defaults to the system handler. */
	openUrl?: (url: string) => Promise<unknown>
	makeKey?: KeyMaker
	appActivity?: AppActivity
}

export type PartyRange = { readonly min: number; readonly max: number }

/** A booking's payment followed outside the booking flow (after a relaunch, or from its detail screen). */
export type PendingPayment = {
	readonly reservationId: string
	/** `null` until the first status answer. */
	readonly outcome: PaymentOutcome | null
	readonly isPolling: boolean
}

/** Bookings that can no longer change: their manage tokens are not kept. */
const OVER_STATUSES = new Set([
	'cancelled',
	'declined',
	'expired',
	'no_show',
	'finished',
])

export type ReservationsSnapshot = {
	readonly loadState: ReservationsLoadState
	readonly config: ReservationsConfig | null
	readonly location: ReservationLocation | null
	readonly flow: BookingFlowState
	readonly waitlist: WaitlistFlowState
	readonly isBusy: boolean
	/** Device time of the last tick, in epoch milliseconds. */
	readonly now: number
	/** Server time minus device time, from the last answer that carried `now`. */
	readonly serverOffsetMs: number
	readonly searchFailure: BookingFailure | null
	/** The time the guest chose was just taken: the search shows the alternatives with a notice. */
	readonly takenNotice: boolean
	readonly mine: ReservationMine | null
	readonly manage: ReservationManageView | null
	readonly manageFailure: BookingFailure | null
	readonly manageNotice: 'rsv.detail.lateSent' | null
	readonly isPolling: boolean
	readonly pendingPayment: PendingPayment | null
	/** The booking form, shared by the details and review screens. */
	readonly draft: ReservationGuestDetails
	/** The guest ticked the consent box of a payment policy. */
	readonly consented: boolean
	readonly partySize: number
	readonly date: string
	/** Preferred time of a large-party request, in minutes after midnight. */
	readonly requestMinute: number
	/** The times the request picker offers. */
	readonly requestMinutes: readonly number[]
	readonly localeCode: string
	/** The days the date strip offers, today first, in the location's time zone. */
	readonly days: readonly string[]
	/** The party stepper range; above the online maximum the guest sends a request. */
	readonly partyRange: PartyRange | null
	readonly holdRemainingMs: number | null
	readonly holdCountdown: string | null
	readonly paymentRemainingMs: number | null
	readonly offersRequest: boolean
	/** No hold and the availability asks for a request: details send the request directly. */
	readonly isRequest: boolean
	readonly needsPolicyConsent: boolean
	readonly canReview: boolean
	readonly isRequestReady: boolean
}

const TICK_MS = 1000
const WAITLIST_REFRESH_MS = 10_000
const WAITLIST_MAX_BACKOFF_MS = 160_000
const DEFAULT_REQUEST_MINUTE = 19 * 60

const defaultTimers: ReservationsTimers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** 11:00 to 23:00 on the location's booking grid (never finer than 5 minutes). */
export function requestMinuteOptions(
	location: ReservationLocation | null,
): number[] {
	const step = Math.max(location?.intervalMin ?? 15, 5)
	const minutes: number[] = []
	for (let minute = 11 * 60; minute <= 23 * 60; minute += step)
		minutes.push(minute)
	return minutes
}

/** First word and the rest, the way the profile name fills the booking form. */
export function splitProfileName(name: string): {
	firstName: string
	lastName: string
} {
	const trimmed = name.replace(/^ +/, '')
	const space = trimmed.indexOf(' ')
	if (space < 0) return { firstName: trimmed, lastName: '' }
	return {
		firstName: trimmed.slice(0, space),
		lastName: trimmed.slice(space + 1),
	}
}

export class ReservationsStore {
	readonly #client: ReservationsApi
	readonly #tokens: ReservationTokenStore
	readonly #now: () => number
	readonly #timers: ReservationsTimers
	readonly #openBrowser: (url: string) => Promise<unknown>
	readonly #openUrl: (url: string) => Promise<unknown>
	readonly #makeKey: KeyMaker
	readonly #activity: AppActivity
	readonly #listeners = new Set<() => void>()

	#loadState: ReservationsLoadState = { kind: 'idle' }
	#config: ReservationsConfig | null = null
	#location: ReservationLocation | null = null
	#flow: BookingFlow
	#waitlist: WaitlistFlow
	#isBusy = false
	#nowMs: number
	#serverOffsetMs = 0
	#searchFailure: BookingFailure | null = null
	#takenNotice = false
	#mine: ReservationMine | null = null
	#manage: ReservationManageView | null = null
	#manageFailure: BookingFailure | null = null
	#manageNotice: 'rsv.detail.lateSent' | null = null
	#isPolling = false
	#draft: ReservationGuestDetails = makeGuestDetails()
	#consented = false
	#didPrefill = false
	#partySize = 2
	#date = ''
	#requestMinute = DEFAULT_REQUEST_MINUTE
	#localeCode: string

	#ticker: unknown = null
	#pollRun = 0
	#pollWake: (() => void) | null = null
	#pollTimer: unknown = null
	#pendingPayment: PendingPayment | null = null
	#pendingRun = 0
	#pendingWake: (() => void) | null = null
	#pendingTimer: unknown = null
	#waitlistRun = 0
	#waitlistWatching = false
	#waitlistWake: (() => void) | null = null
	#waitlistTimer: unknown = null
	#stopWatchingActivity: (() => void) | null = null
	/** The waitlist entry whose status token `waitlist` holds (to forget it later). */
	#waitlistEntryId: string | null = null
	#isRestoringWaitlist = false
	/** Bumped by `reset()`: an answer that arrives after sign-out is dropped. */
	#generation = 0
	#snapshot: ReservationsSnapshot

	constructor(options: ReservationsStoreOptions) {
		this.#client = options.client
		this.#tokens = options.tokens
		this.#localeCode = options.localeCode
		this.#now = options.now ?? Date.now
		this.#timers = options.timers ?? defaultTimers
		this.#openBrowser =
			options.openBrowser ?? ((url) => WebBrowser.openBrowserAsync(url))
		this.#openUrl = options.openUrl ?? ((url) => Linking.openURL(url))
		this.#makeKey = options.makeKey ?? makeIdempotencyKey
		this.#activity = options.appActivity ?? deviceActivity
		this.#flow = new BookingFlow(this.#makeKey)
		this.#waitlist = new WaitlistFlow(this.#makeKey)
		this.#nowMs = this.#now()
		this.#snapshot = this.#buildSnapshot()
	}

	// Observation

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	getSnapshot = (): ReservationsSnapshot => this.#snapshot

	#emit(): void {
		this.#snapshot = this.#buildSnapshot()
		for (const listener of this.#listeners) listener()
	}

	#buildSnapshot(): ReservationsSnapshot {
		const flow = this.#flow
		const hold = flow.hold
		const location = this.#location
		const offersRequest = flow.offersRequest
		const isRequest = hold === null && offersRequest
		return Object.freeze({
			loadState: this.#loadState,
			config: this.#config,
			location,
			flow: flow.state,
			waitlist: this.#waitlist.state,
			isBusy: this.#isBusy,
			now: this.#nowMs,
			serverOffsetMs: this.#serverOffsetMs,
			searchFailure: this.#searchFailure,
			takenNotice: this.#takenNotice,
			mine: this.#mine,
			manage: this.#manage,
			manageFailure: this.#manageFailure,
			manageNotice: this.#manageNotice,
			isPolling: this.#isPolling,
			pendingPayment: this.#pendingPayment,
			draft: this.#draft,
			consented: this.#consented,
			partySize: this.#partySize,
			date: this.#date,
			requestMinute: this.#requestMinute,
			requestMinutes: requestMinuteOptions(location),
			localeCode: this.#localeCode,
			days: location
				? reservationDateStrip(
						this.#now() + this.#serverOffsetMs,
						location.timeZone,
						14,
						location.horizonDays,
					)
				: [],
			partyRange: location
				? { min: location.partySize.min, max: partyCeiling(location) }
				: null,
			holdRemainingMs: flow.remainingMs(this.#nowMs),
			holdCountdown: hold ? holdCountdownLabel(hold, this.#nowMs) : null,
			paymentRemainingMs: flow.paymentRemainingMs(
				this.#nowMs,
				this.#serverOffsetMs,
			),
			offersRequest,
			isRequest,
			needsPolicyConsent: flow.needsPolicyConsent,
			canReview: flow.canReview(this.#draft, this.#consented),
			isRequestReady:
				isRequest &&
				this.#draft.firstName.trim() !== '' &&
				isValidPhone(this.#draft.phone),
		})
	}

	setLocale(localeCode: string): void {
		if (localeCode === this.#localeCode) return
		this.#localeCode = localeCode
		this.#emit()
	}

	// Config

	async loadConfig(): Promise<void> {
		if (this.#loadState.kind === 'loading') return
		this.#loadState = { kind: 'loading' }
		this.#emit()
		const generation = this.#generation
		try {
			const config = await this.#client.config(this.#localeCode)
			if (generation !== this.#generation) return
			this.#noteServerTime(config.now)
			this.#config = config
			if (config.locations.length === 0) {
				this.#loadState = { kind: 'unavailable' }
				this.#emit()
				return
			}
			this.#loadState = { kind: 'ready' }
			const only =
				config.locations.length === 1 ? config.locations[0] : undefined
			if (this.#location === null && only) this.selectLocation(only)
			this.#emit()
			await this.restoreWaitlist()
			await this.resumePendingPayment()
		} catch (error) {
			if (generation !== this.#generation) return
			const failure = mapBookingFailure(error)
			this.#loadState =
				failure.kind === 'notFound' || failure.kind === 'paused'
					? { kind: 'unavailable' }
					: { kind: 'failed', failure }
			this.#emit()
		}
	}

	selectLocation(location: ReservationLocation): void {
		this.#location = location
		// Above the online maximum is allowed: the guest sends a request instead.
		this.#partySize = Math.min(
			Math.max(this.#partySize, location.partySize.min),
			partyCeiling(location),
		)
		this.#date =
			reservationDateStrip(
				this.#now() + this.#serverOffsetMs,
				location.timeZone,
				1,
				location.horizonDays,
			)[0] ?? ''
		this.#emit()
	}

	/** Home's "Join the waitlist": without a location, the first one with an online waitlist. */
	prepareWaitlistFromHome(): void {
		if (this.#location !== null) return
		const first = this.#config?.locations.find(
			(location) => location.waitlist.online,
		)
		if (first) this.selectLocation(first)
	}

	// Search

	/** The search screen opened: searches for the current day and party. */
	async enterSearch(): Promise<void> {
		await this.search()
	}

	/**
	 * The guest came back to the times from a later step: re-reads them without
	 * resetting the flow, with the notice when the chosen time was taken.
	 */
	async returnToSearch(): Promise<void> {
		if (this.#isFailedSlot()) {
			this.#takenNotice = true
			this.#emit()
		}
		await this.refreshAvailability()
	}

	/** The guest changed the day or the party on the search screen: searches again. */
	async changeSearch(change: {
		date?: string
		partySize?: number
	}): Promise<void> {
		if (change.date !== undefined) this.#date = change.date
		if (change.partySize !== undefined)
			this.#partySize = this.#clampParty(change.partySize)
		this.#takenNotice = false
		this.#emit()
		await this.search()
	}

	/** Sets the party without searching (the waitlist form). */
	setPartySize(partySize: number): void {
		this.#partySize = this.#clampParty(partySize)
		this.#emit()
	}

	setDate(date: string): void {
		this.#date = date
		this.#emit()
	}

	chooseAlternativeDate(date: string): Promise<void> {
		return this.changeSearch({ date })
	}

	#clampParty(partySize: number): number {
		const location = this.#location
		if (!location) return Math.max(1, Math.round(partySize))
		return Math.min(
			Math.max(Math.round(partySize), location.partySize.min),
			partyCeiling(location),
		)
	}

	async search(): Promise<void> {
		const location = this.#location
		if (!location) return
		await this.#releasePendingHold()
		this.#searchFailure = null
		this.#flow.beginSearch(location.id, this.#date, this.#partySize)
		this.#resetDetailsForm()
		this.#isBusy = true
		this.#emit()
		try {
			const availability = await this.#client.availability({
				locationId: location.id,
				date: this.#date,
				partySize: this.#partySize,
				locale: this.#localeCode,
			})
			this.#noteServerTime(availability.now)
			this.#flow.receiveAvailability(availability)
		} catch (error) {
			this.#searchFailure = mapBookingFailure(error)
		}
		this.#emit()
		await this.#releasePendingHold()
		this.#isBusy = false
		this.#emit()
	}

	/** Re-reads the times without resetting the flow. */
	async refreshAvailability(): Promise<void> {
		const location = this.#location
		if (!location) return
		try {
			const availability = await this.#client.availability({
				locationId: location.id,
				date: this.#flow.date === '' ? this.#date : this.#flow.date,
				partySize: this.#partySize,
				locale: this.#localeCode,
			})
			this.#noteServerTime(availability.now)
			this.#flow.receiveAvailability(availability)
		} catch (error) {
			this.#searchFailure = mapBookingFailure(error)
		}
		this.#emit()
	}

	setRequestMinute(localMin: number): void {
		this.#requestMinute = localMin
		this.#emit()
	}

	/** "Send a request" on the search screen: a large party asks for a time instead of holding one. */
	startRequest(): void {
		this.#flow.setRequestTime(this.#requestMinute)
		this.#resetDetailsForm()
		this.#emit()
	}

	/** A large party asks for a time instead of holding one. */
	setRequestTime(localMin: number): void {
		this.#flow.setRequestTime(localMin)
		this.#emit()
	}

	// Hold

	async choose(slot: ReservationSlot): Promise<void> {
		const location = this.#location
		if (!location) return
		this.#flow.select(slot)
		this.#isBusy = true
		this.#emit()
		try {
			const hold = await this.#client.createHold({
				locationId: location.id,
				date: this.#flow.date,
				localMin: slot.localMin,
				partySize: this.#partySize,
				serviceId: slot.serviceId,
				areaId: slot.areaId,
				replaceHoldToken: this.#flow.replaceableHoldToken,
			})
			this.#noteServerTime(hold.now)
			this.#flow.receiveHold(hold, this.#now())
			if (this.#flow.phase.kind === 'details') this.#resetDetailsForm()
			this.#startTicker()
		} catch (error) {
			this.#receiveFlowError(error)
		}
		this.#emit()
		await this.#releasePendingHold()
		this.#isBusy = false
		this.#emit()
	}

	proceedToReview(): void {
		this.#flow.proceedToReview()
		this.#emit()
	}

	backToDetails(): void {
		this.#flow.backToDetails()
		this.#emit()
	}

	/** A back gesture off the review screen returns to the form with the hold still counting down. */
	leaveReview(): void {
		if (this.#flow.phase.kind === 'reviewing') this.backToDetails()
	}

	/** The guest leaves the booking: the held table is released. */
	async cancelBooking(): Promise<void> {
		this.#stopTicker()
		this.stopPolling()
		this.#flow.reset()
		this.#resetDetailsForm()
		this.#emit()
		await this.#releasePendingHold()
	}

	/** Home appeared: a table that is still only held is released. */
	async leaveBookingSteps(): Promise<void> {
		if (this.#flow.hold !== null) await this.cancelBooking()
	}

	/** "Done" on the confirmation: back to a fresh flow and an up-to-date list. */
	async finishBooking(): Promise<void> {
		await this.cancelBooking()
		await this.loadMine()
	}

	async #releasePendingHold(): Promise<void> {
		const token = this.#flow.holdToRelease
		if (token === null) return
		this.#flow.acknowledgeRelease()
		try {
			await this.#client.releaseHold(token)
		} catch {
			// Best effort: the server lets an abandoned hold run out on its own.
		}
	}

	#isFailedSlot(): boolean {
		const phase = this.#flow.phase
		return phase.kind === 'failed' && phase.failure.kind === 'slotUnavailable'
	}

	#receiveFlowError(error: unknown): void {
		this.#flow.receiveError(error)
		if (this.#isFailedSlot()) this.#takenNotice = true
	}

	// Details

	updateDraft(change: Partial<ReservationGuestDetails>): void {
		this.#draft = { ...this.#draft, ...change }
		this.#emit()
	}

	setConsented(consented: boolean): void {
		this.#consented = consented
		this.#draft = {
			...this.#draft,
			policyTermsVersion: consented ? this.#flow.policyTermsVersion : null,
		}
		this.#emit()
	}

	/**
	 * Name from the profile, phone from the verified account, language from
	 * the app. The name is filled once per visit of the form.
	 */
	prefillDraft(profile: CustomerProfile | null): void {
		let draft: ReservationGuestDetails = {
			...this.#draft,
			phone: profile?.phone ?? '',
			locale: this.#localeCode,
		}
		if (!this.#didPrefill && profile) {
			const name = splitProfileName(profile.name ?? '')
			draft = { ...draft, ...name, email: profile.email ?? '' }
			this.#didPrefill = true
		}
		this.#draft = draft
		this.#emit()
	}

	/** The details button: a request is sent right away, a booking goes to review. */
	async continueFromDetails(): Promise<void> {
		const snapshot = this.#snapshot
		if (!snapshot.canReview && !snapshot.isRequestReady) return
		this.#draft = {
			...this.#draft,
			policyTermsVersion: this.#consented
				? this.#flow.policyTermsVersion
				: null,
		}
		if (snapshot.isRequest) {
			this.#emit()
			await this.submit(this.#draft)
		} else {
			this.proceedToReview()
		}
	}

	/** A new visit of the details form starts unticked and is filled from the profile again. */
	#resetDetailsForm(): void {
		this.#consented = false
		this.#didPrefill = false
		if (this.#draft.policyTermsVersion !== null) {
			this.#draft = { ...this.#draft, policyTermsVersion: null }
		}
	}

	// Submit

	async submit(details: ReservationGuestDetails = this.#draft): Promise<void> {
		const location = this.#location
		if (!location) return
		const isRequest =
			this.#flow.phase.kind === 'choosingTime' && this.#flow.offersRequest
		const key = this.#flow.beginSubmit(details, isRequest)
		if (key === null) return
		const generation = this.#generation
		this.#isBusy = true
		this.#emit()
		try {
			let booking: ReservationBooking
			const slot = this.#flow.selectedSlot
			const hold = this.#flow.hold
			if (isRequest && slot) {
				booking = await this.#client.requestLargeParty({
					locationId: location.id,
					date: this.#flow.date,
					localMin: slot.localMin,
					partySize: this.#partySize,
					details,
					idempotencyKey: key,
				})
			} else if (hold) {
				booking = await this.#client.book({
					holdToken: hold.token,
					details,
					idempotencyKey: key,
				})
			} else {
				this.#receiveFlowError(new ReservationApiError(410, 'hold_expired'))
				return
			}
			if (generation !== this.#generation) return
			void this.#tokens.rememberManage(
				booking.reservation.id,
				booking.manageToken,
			)
			this.#flow.receiveBooking(booking)
			if (this.#flow.phase.kind === 'awaitingPayment') {
				void this.#tokens.rememberPayment(booking.reservation.id)
				// The payment window counts down on the same ticker as the hold.
				this.#startTicker()
				this.startPolling()
			} else {
				this.#stopTicker()
			}
		} catch (error) {
			if (generation !== this.#generation) return
			this.#receiveFlowError(error)
		} finally {
			if (generation === this.#generation) {
				this.#isBusy = false
				this.#emit()
			}
		}
	}

	// Payment

	/** "Pay now": the payment page opens in the browser while the status poll runs. */
	async openPayment(): Promise<void> {
		const url = this.#flow.booking?.payment?.payUrl
		// The page asks for card details: only a secure URL (https, or http on
		// loopback in development) ever reaches the browser. The poll keeps
		// running, so a payment made another way still settles.
		if (!url || !isTransportSafe(url)) return
		// The URL carries the payment token in its fragment: it goes to the
		// browser and is never written anywhere else.
		const opened = this.#openBrowser(url)
		this.startPolling()
		try {
			await opened
		} catch {
			return
		}
		// Back from the browser: check straight away.
		this.resumePolling()
	}

	/**
	 * Polls `GET /reservations/manage/payment` with the schedule Sites uses and
	 * stops on a final answer, a dead link or after three minutes. Call again
	 * when the app returns to the foreground (`resumePolling`).
	 */
	startPolling(): void {
		const token = this.#flow.booking?.manageToken
		if (this.#flow.phase.kind !== 'awaitingPayment' || !token) return
		this.#cancelPoll()
		const run = this.#pollRun
		const generation = this.#generation
		this.#isPolling = true
		this.#emit()
		void this.#poll(run, generation, token)
	}

	async #poll(run: number, generation: number, token: string): Promise<void> {
		const live = () => run === this.#pollRun && generation === this.#generation
		const started = this.#now()
		const reservationId = this.#flow.booking?.reservation.id ?? null
		const settle = () => {
			if (reservationId !== null) void this.#tokens.forgetPayment(reservationId)
		}
		let attempt = 0
		while (live()) {
			try {
				const status = await this.#client.paymentStatus(token)
				if (!live()) return
				this.#noteServerTime(status.now)
				const outcome = this.#flow.receivePaymentStatus(status)
				this.#emit()
				if (isFinalPaymentOutcome(outcome)) {
					settle()
					break
				}
			} catch (error) {
				if (!live()) return
				if (PaymentPoll.stops(error)) {
					settle()
					break
				}
			}
			if (PaymentPoll.hasTimedOut(started, this.#now())) break
			const delay = PaymentPoll.delayAfterAttempt(attempt)
			attempt += 1
			await this.#pollSleep(delay)
		}
		if (!live()) return
		this.#isPolling = false
		this.#emit()
	}

	#pollSleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.#pollWake = resolve
			this.#pollTimer = this.#timers.setTimeout(() => {
				this.#pollTimer = null
				this.#pollWake = null
				resolve()
			}, ms)
		})
	}

	#cancelPoll(): void {
		this.#pollRun += 1
		if (this.#pollTimer !== null) this.#timers.clearTimeout(this.#pollTimer)
		this.#pollTimer = null
		const wake = this.#pollWake
		this.#pollWake = null
		wake?.()
	}

	/** The app came back to the foreground. */
	resumePolling(): void {
		if (this.#flow.phase.kind === 'awaitingPayment') this.startPolling()
		else void this.resumePendingPayment()
	}

	/**
	 * A payment started on this device that was not settled when the app was
	 * killed: its status poll picks up again with the booking's manage token.
	 */
	async resumePendingPayment(): Promise<void> {
		if (this.#flow.phase.kind === 'awaitingPayment') return
		if (this.#pendingPayment?.isPolling) return
		const generation = this.#generation
		const stored = await this.#tokens.load()
		if (generation !== this.#generation || stored.payment === undefined) return
		const reservationId = stored.payment
		const token = await this.manageToken(reservationId)
		if (token === null) {
			void this.#tokens.forgetPayment(reservationId)
			return
		}
		this.watchPayment(reservationId, token)
	}

	/**
	 * Follows the payment of a booking that is still `pending_payment`
	 * (the detail screen, or a resumed payment) until it is final.
	 */
	watchPayment(reservationId: string, token: string): void {
		const booking = this.#flow.booking
		if (
			this.#flow.phase.kind === 'awaitingPayment' &&
			booking?.reservation.id === reservationId
		) {
			this.startPolling()
			return
		}
		const current = this.#pendingPayment
		if (current?.reservationId === reservationId && current.isPolling) return
		this.#cancelPendingPayment()
		this.#pendingPayment = { reservationId, outcome: null, isPolling: true }
		void this.#tokens.rememberPayment(reservationId)
		this.#emit()
		void this.#pollPendingPayment(
			this.#pendingRun,
			this.#generation,
			reservationId,
			token,
		)
	}

	stopWatchingPayment(): void {
		this.#cancelPendingPayment()
		if (this.#pendingPayment?.isPolling) {
			this.#pendingPayment = { ...this.#pendingPayment, isPolling: false }
			this.#emit()
		}
	}

	async #pollPendingPayment(
		run: number,
		generation: number,
		reservationId: string,
		token: string,
	): Promise<void> {
		const live = () =>
			run === this.#pendingRun && generation === this.#generation
		const started = this.#now()
		let attempt = 0
		let outcome: PaymentOutcome | null = null
		let settled = false
		while (live()) {
			try {
				const status = await this.#client.paymentStatus(token)
				if (!live()) return
				this.#noteServerTime(status.now)
				outcome = interpretPaymentStatus(status)
				this.#pendingPayment = { reservationId, outcome, isPolling: true }
				this.#emit()
				if (isFinalPaymentOutcome(outcome)) {
					settled = true
					break
				}
			} catch (error) {
				if (!live()) return
				if (PaymentPoll.stops(error)) {
					settled = true
					break
				}
			}
			if (PaymentPoll.hasTimedOut(started, this.#now())) break
			const delay = PaymentPoll.delayAfterAttempt(attempt)
			attempt += 1
			await new Promise<void>((resolve) => {
				this.#pendingWake = resolve
				this.#pendingTimer = this.#timers.setTimeout(() => {
					this.#pendingTimer = null
					this.#pendingWake = null
					resolve()
				}, delay)
			})
		}
		if (!live()) return
		this.#pendingPayment = { reservationId, outcome, isPolling: false }
		this.#emit()
		// Unsettled (the poll gave up): kept, so the next launch checks again.
		if (!settled) return
		void this.#tokens.forgetPayment(reservationId)
		await this.loadMine()
		if (this.#manage?.reservation.id === reservationId)
			await this.loadManage(token)
	}

	#cancelPendingPayment(): void {
		this.#pendingRun += 1
		if (this.#pendingTimer !== null)
			this.#timers.clearTimeout(this.#pendingTimer)
		this.#pendingTimer = null
		const wake = this.#pendingWake
		this.#pendingWake = null
		wake?.()
	}

	stopPolling(): void {
		this.#cancelPoll()
		if (this.#isPolling) {
			this.#isPolling = false
			this.#emit()
		}
	}

	// Countdown

	#startTicker(): void {
		this.#stopTicker()
		this.#nowMs = this.#now()
		this.#scheduleTick()
	}

	#scheduleTick(): void {
		this.#ticker = this.#timers.setTimeout(() => {
			this.#ticker = null
			this.#nowMs = this.#now()
			const expired = this.#flow.tick(this.#nowMs)
			const needed =
				this.#flow.hold !== null || this.#flow.phase.kind === 'awaitingPayment'
			if (!expired && needed) this.#scheduleTick()
			this.#emit()
		}, TICK_MS)
	}

	#stopTicker(): void {
		if (this.#ticker !== null) this.#timers.clearTimeout(this.#ticker)
		this.#ticker = null
	}

	// My reservations and manage

	async loadMine(): Promise<void> {
		const generation = this.#generation
		try {
			const result = await this.#client.mine()
			if (generation !== this.#generation) return
			this.#noteServerTime(result.now)
			this.#mine = result
			// Recover tokens after a reinstall: `/mine` re-derives every manage
			// token. Only bookings that can still change keep theirs on the
			// device; the rest stay reachable through this list.
			const over = new Set(result.past.map((entry) => entry.id))
			for (const entry of result.upcoming) {
				if (OVER_STATUSES.has(entry.status)) over.add(entry.id)
				else void this.#tokens.rememberManage(entry.id, entry.manageToken)
			}
			if (over.size > 0) void this.#tokens.forgetManageMany(over)
			this.#emit()
		} catch {
			// The list is a convenience; the booking flow does not depend on it.
		}
	}

	async manageToken(reservationId: string): Promise<string | null> {
		const tokens = await this.#tokens.load()
		if (Object.prototype.hasOwnProperty.call(tokens.manage, reservationId))
			return tokens.manage[reservationId] ?? null
		const listed = [
			...(this.#mine?.upcoming ?? []),
			...(this.#mine?.past ?? []),
		].find((entry) => entry.id === reservationId)
		return listed?.manageToken ?? null
	}

	/** The detail screen: loads the booking, recovering its token through `/mine` when this device has none. */
	async reloadReservation(reservationId: string): Promise<void> {
		const token = await this.manageToken(reservationId)
		if (token !== null) {
			await this.loadManage(token)
			return
		}
		await this.loadMine()
		const recovered = await this.manageToken(reservationId)
		if (recovered !== null) await this.loadManage(recovered)
	}

	async loadManage(token: string): Promise<void> {
		this.#manageFailure = null
		this.#manageNotice = null
		this.#emit()
		const generation = this.#generation
		try {
			const view = await this.#client.manage(token)
			if (generation !== this.#generation) return
			this.#noteServerTime(view.now)
			this.#manage = view
		} catch (error) {
			if (generation !== this.#generation) return
			this.#manageFailure = mapBookingFailure(error)
		}
		this.#emit()
	}

	modify(
		token: string,
		params: { date: string; localMin: number; partySize?: number | null },
	): Promise<boolean> {
		return this.#mutate(null, () =>
			this.#client.modify(token, {
				date: params.date,
				localMin: params.localMin,
				partySize: params.partySize,
			}),
		)
	}

	/** The modify sheet picked a time: on success the list is refreshed and the sheet closes (`true`). */
	async applyModification(
		token: string,
		params: { date: string; localMin: number; partySize?: number | null },
	): Promise<boolean> {
		await this.modify(token, params)
		if (this.#manageFailure !== null) return false
		await this.loadMine()
		return true
	}

	cancelReservation(token: string): Promise<boolean> {
		return this.#mutate(null, () => this.#client.cancel(token))
	}

	/** The cancel confirmation: cancels, then refreshes the list. */
	async confirmCancellation(token: string): Promise<void> {
		await this.cancelReservation(token)
		await this.loadMine()
	}

	runningLate(token: string, minutes: number): Promise<boolean> {
		return this.#mutate('rsv.detail.lateSent', () =>
			this.#client.runningLate(token, minutes),
		)
	}

	/** `true` when the server took the change. */
	async #mutate(
		notice: 'rsv.detail.lateSent' | null,
		call: () => Promise<ReservationManageView>,
	): Promise<boolean> {
		const generation = this.#generation
		this.#isBusy = true
		this.#manageFailure = null
		this.#manageNotice = null
		this.#emit()
		try {
			const view = await call()
			if (generation !== this.#generation) return false
			this.#noteServerTime(view.now)
			this.#manage = view
			this.#manageNotice = notice
			return true
		} catch (error) {
			if (generation !== this.#generation) return false
			this.#manageFailure = mapBookingFailure(error)
			return false
		} finally {
			if (generation === this.#generation) {
				this.#isBusy = false
				this.#emit()
			}
		}
	}

	/** The times a booking can move to (its own table excluded by the server). */
	async availability(
		token: string,
		date: string,
		partySize: number,
	): Promise<ReservationAvailability | null> {
		try {
			return await this.#client.manageAvailability(token, { date, partySize })
		} catch (error) {
			this.#manageFailure = mapBookingFailure(error)
			this.#emit()
			return null
		}
	}

	/** "Call the restaurant" for a live booking; `false` when there is nothing to call. */
	async callVenue(): Promise<boolean> {
		const view = this.#manage
		const url = view ? venueTelUrl(view) : null
		if (!url) return false
		try {
			await this.#openUrl(url)
			return true
		} catch {
			return false
		}
	}

	// Waitlist

	/** Joins with the verified phone; the name is trimmed and must not be empty. */
	async joinWaitlist(params: {
		name: string
		phone: string
		smsOptIn: boolean
	}): Promise<void> {
		const location = this.#location
		const name = params.name.trim()
		if (!location || name === '') return
		const key = this.#waitlist.beginJoin(location.id, name, this.#partySize)
		const generation = this.#generation
		this.#isBusy = true
		this.#emit()
		try {
			const joined = await this.#client.joinWaitlist({
				locationId: location.id,
				name,
				partySize: this.#partySize,
				phone: params.phone,
				smsOptIn: params.smsOptIn,
				locale: this.#localeCode,
				idempotencyKey: key,
			})
			if (generation !== this.#generation) return
			void this.#tokens.rememberWaitlist(joined.entry.id, joined.statusToken)
			this.#waitlistEntryId = joined.entry.id
			this.#waitlist.receiveJoin(joined)
			this.#emit()
			await this.refreshWaitlist()
			this.#restartWaitlistUpdates()
		} catch (error) {
			if (generation !== this.#generation) return
			this.#waitlist.receiveError(error)
		} finally {
			if (generation === this.#generation) {
				this.#isBusy = false
				this.#emit()
			}
		}
	}

	/**
	 * After a relaunch secure storage still holds the status token of an entry
	 * the guest joined. It goes back into the flow so the guest can follow,
	 * refresh and leave it (joining again would answer `already_on_waitlist`). A
	 * token the server no longer knows, or an entry that is over, is forgotten
	 * so the guest can join again.
	 */
	async restoreWaitlist(): Promise<void> {
		if (this.#waitlist.statusToken !== null || this.#isRestoringWaitlist) return
		this.#isRestoringWaitlist = true
		const generation = this.#generation
		try {
			const saved = (await this.#tokens.load()).waitlist
			if (generation !== this.#generation) return
			for (const entryId of Object.keys(saved).sort()) {
				const token = saved[entryId]
				if (token === undefined) continue
				try {
					const status = await this.#client.waitlistStatus(token)
					if (generation !== this.#generation) return
					this.#noteServerTime(status.now)
					if (WaitlistFlow.isFinished(status.status)) {
						void this.#tokens.forgetWaitlist(entryId)
						continue
					}
					this.#waitlist.restore(token)
					this.#waitlist.receiveStatus(status)
					this.#waitlistEntryId = entryId
					this.#emit()
					this.#restartWaitlistUpdates()
					return
				} catch (error) {
					if (generation !== this.#generation) return
					if (mapBookingFailure(error).kind === 'notFound') {
						void this.#tokens.forgetWaitlist(entryId)
						continue
					}
					// Offline or a transient failure: keep the capability and show the
					// status screen; the screen's refresh loop retries.
					this.#waitlist.restore(token)
					this.#waitlistEntryId = entryId
					this.#emit()
					this.#restartWaitlistUpdates()
					return
				}
			}
		} finally {
			if (generation === this.#generation) this.#isRestoringWaitlist = false
		}
	}

	async refreshWaitlist(): Promise<void> {
		const token = this.#waitlist.statusToken
		if (token === null) return
		const generation = this.#generation
		try {
			const status = await this.#client.waitlistStatus(token)
			if (generation !== this.#generation) return
			this.#noteServerTime(status.now)
			this.#waitlist.receiveStatus(status)
			this.#forgetWaitlistTokenIfFinished()
		} catch (error) {
			if (generation !== this.#generation) return
			this.#waitlist.receiveError(error)
			if (this.#waitlist.phase.kind === 'linkInvalid')
				this.#forgetWaitlistToken()
		}
		this.#emit()
	}

	leaveWaitlist(): Promise<void> {
		return this.#waitlistAction((token) => this.#client.leaveWaitlist(token))
	}

	waitlistOnMyWay(): Promise<void> {
		return this.#waitlistAction((token) => this.#client.waitlistOnMyWay(token))
	}

	async #waitlistAction(
		call: (token: string) => ReturnType<ReservationsApi['leaveWaitlist']>,
	): Promise<void> {
		const token = this.#waitlist.statusToken
		if (token === null) return
		const generation = this.#generation
		this.#isBusy = true
		this.#emit()
		try {
			const status = await call(token)
			if (generation !== this.#generation) return
			this.#waitlist.receiveStatus(status)
			this.#forgetWaitlistTokenIfFinished()
		} catch (error) {
			if (generation !== this.#generation) return
			this.#waitlist.receiveError(error)
			if (this.#waitlist.phase.kind === 'linkInvalid')
				this.#forgetWaitlistToken()
		} finally {
			if (generation === this.#generation) {
				this.#isBusy = false
				this.#emit()
			}
		}
	}

	/** "Done" after a dead link: the guest can join again. */
	resetWaitlist(): void {
		this.#forgetWaitlistToken()
		this.#waitlist = new WaitlistFlow(this.#makeKey)
		this.#emit()
	}

	/**
	 * While the waitlist screen is open and the app is in front, the position
	 * refreshes every 10 seconds until the entry is over. Failed refreshes
	 * back off (20, 40, 80, then 160 seconds) until one answers again.
	 */
	startWaitlistUpdates(): void {
		this.#waitlistWatching = true
		if (!this.#stopWatchingActivity) {
			this.#stopWatchingActivity = this.#activity.subscribe((active) => {
				if (active) this.#restartWaitlistUpdates()
				else this.#cancelWaitlistUpdates()
			})
		}
		this.#restartWaitlistUpdates()
	}

	stopWaitlistUpdates(): void {
		this.#waitlistWatching = false
		this.#stopWatchingActivity?.()
		this.#stopWatchingActivity = null
		this.#cancelWaitlistUpdates()
	}

	#restartWaitlistUpdates(): void {
		if (!this.#waitlistWatching) return
		this.#cancelWaitlistUpdates()
		if (!this.#activity.isActive()) return
		void this.#watchWaitlist(this.#waitlistRun, this.#generation)
	}

	async #watchWaitlist(run: number, generation: number): Promise<void> {
		const live = () =>
			run === this.#waitlistRun && generation === this.#generation
		let failures = 0
		while (live() && this.#waitlist.statusToken !== null) {
			await this.refreshWaitlist()
			const phase = this.#waitlist.phase.kind
			if (phase === 'left' || phase === 'seated' || phase === 'linkInvalid')
				return
			if (!live()) return
			failures = this.#waitlist.refreshFailure ? failures + 1 : 0
			const delay = Math.min(
				WAITLIST_REFRESH_MS * 2 ** failures,
				WAITLIST_MAX_BACKOFF_MS,
			)
			await new Promise<void>((resolve) => {
				this.#waitlistWake = resolve
				this.#waitlistTimer = this.#timers.setTimeout(() => {
					this.#waitlistTimer = null
					this.#waitlistWake = null
					resolve()
				}, delay)
			})
		}
	}

	#cancelWaitlistUpdates(): void {
		this.#waitlistRun += 1
		if (this.#waitlistTimer !== null)
			this.#timers.clearTimeout(this.#waitlistTimer)
		this.#waitlistTimer = null
		const wake = this.#waitlistWake
		this.#waitlistWake = null
		wake?.()
	}

	#forgetWaitlistTokenIfFinished(): void {
		const status = this.#waitlist.status
		if (status && WaitlistFlow.isFinished(status.status))
			this.#forgetWaitlistToken()
	}

	/**
	 * Drops the persisted status token of the current entry (the in-memory flow
	 * keeps showing its final state until the guest leaves the screen).
	 */
	#forgetWaitlistToken(): void {
		if (this.#waitlistEntryId !== null)
			void this.#tokens.forgetWaitlist(this.#waitlistEntryId)
		this.#waitlistEntryId = null
	}

	// Helpers

	#noteServerTime(raw: string): void {
		const server = parseServerTime(raw)
		if (server !== null) this.#serverOffsetMs = server - this.#now()
	}

	/**
	 * Sign-out and account switch: wipes the persisted capability tokens and
	 * every in-memory piece of the previous customer's session (manage,
	 * waitlist, hold, payment poll, bookings, guest details), so the next
	 * customer who signs in on this device starts from nothing. Answers still in
	 * flight are dropped. Resolves once the stored tokens are gone.
	 */
	reset(): Promise<boolean> {
		this.#generation += 1
		this.#stopTicker()
		this.stopPolling()
		this.stopWaitlistUpdates()
		this.#cancelPendingPayment()
		this.#pendingPayment = null
		// The held table of the leaving customer is released, best effort.
		this.#flow.reset()
		const heldToken = this.#flow.holdToRelease
		const cleared = this.#tokens.clear()
		this.#flow = new BookingFlow(this.#makeKey)
		this.#waitlist = new WaitlistFlow(this.#makeKey)
		this.#waitlistEntryId = null
		this.#isRestoringWaitlist = false
		this.#loadState = { kind: 'idle' }
		this.#config = null
		this.#location = null
		this.#isBusy = false
		this.#searchFailure = null
		this.#takenNotice = false
		this.#mine = null
		this.#manage = null
		this.#manageFailure = null
		this.#manageNotice = null
		this.#draft = makeGuestDetails()
		this.#consented = false
		this.#didPrefill = false
		this.#partySize = 2
		this.#date = ''
		this.#requestMinute = DEFAULT_REQUEST_MINUTE
		this.#serverOffsetMs = 0
		this.#emit()
		if (heldToken !== null) {
			this.#client.releaseHold(heldToken).catch(() => undefined)
		}
		return cleared
	}

	/** Stops every timer (the store is no longer used). */
	dispose(): void {
		this.#stopTicker()
		this.stopPolling()
		this.stopWaitlistUpdates()
		this.#cancelPendingPayment()
		this.#listeners.clear()
	}
}

const TEL_CHARACTERS = /[0-9+\u0660-\u0669\u06F0-\u06F9]/

/** `tel:` link to the location of a live booking; null without a phone. */
export function venueTelUrl(view: ReservationManageView): string | null {
	const phone = view.reservation.location.phone
	if (!phone || !manageActions(view).isLive) return null
	return `tel:${Array.from(phone)
		.filter((character) => TEL_CHARACTERS.test(character))
		.join('')}`
}
