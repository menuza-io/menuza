import { formatHoldClock, holdRemainingMs } from './hold.ts'
import { type ReservationLabels } from './labels.ts'
import { formatMinor } from './money.ts'
import { type PaymentPurpose } from './types.ts'
import {
	bannerErrorClass,
	bannerInfoClass,
	cardClass,
	primaryButtonClass,
	secondaryButtonClass,
} from './ui.ts'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'

/**
 * The payment hand-off page: `/reserve/pay#r=<reservationId>&t=<token>` (or
 * `#f=<feeId>&t=<token>` for a fee link), and its provider return page
 * `/reserve/pay/done?r=<id>&purpose=<p>`. The token never reaches a server log:
 * it arrives in the fragment, is kept in `sessionStorage` and is stripped from
 * the address bar. A redirect back from the provider never means paid: only a
 * status answer does.
 */

export type PayRef = { kind: 'reservation' | 'fee'; id: string }

export type StoredPay = {
	token: string
	purpose?: PaymentPurpose
	amountMinor?: number
	currency?: string
	expiresAt?: string
	/** Server `now` minus device `now` when the entry was written. */
	clockOffsetMs?: number
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const STORAGE_PREFIX = 'rsv_pay_'
const RESERVATION_PURPOSES: PaymentPurpose[] = [
	'deposit',
	'prepay',
	'experience',
	'guarantee',
]
const PURPOSES = new Set<string>([...RESERVATION_PURPOSES, 'fee'])

function storageKey(ref: PayRef) {
	return `${STORAGE_PREFIX}${ref.kind === 'fee' ? 'f' : 'r'}_${ref.id}`
}

function safeStorage(storage?: StorageLike): StorageLike | null {
	if (storage) return storage
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage
	} catch {
		return null
	}
}

export function storePay(ref: PayRef, value: StoredPay, storage?: StorageLike) {
	try {
		safeStorage(storage)?.setItem(storageKey(ref), JSON.stringify(value))
	} catch {
		// Private mode: the link still works from the address bar.
	}
}

export function readPay(ref: PayRef, storage?: StorageLike): StoredPay | null {
	try {
		const raw = safeStorage(storage)?.getItem(storageKey(ref))
		if (!raw) return null
		const value = JSON.parse(raw) as StoredPay
		return typeof value?.token === 'string' && value.token ? value : null
	} catch {
		return null
	}
}

export function clearPay(ref: PayRef, storage?: StorageLike) {
	try {
		safeStorage(storage)?.removeItem(storageKey(ref))
	} catch {
		// Nothing to clear.
	}
}

export function parsePayLocation(hash: string, search: string) {
	const fragment = new URLSearchParams(hash.replace(/^#/, ''))
	const query = new URLSearchParams(search.replace(/^\?/, ''))
	const pick = (key: string) =>
		(fragment.get(key) ?? query.get(key))?.trim() || null
	const feeId = pick('f')
	const reservationId = pick('r')
	const idPattern = /^[A-Za-z0-9_:.-]{1,128}$/
	const id = feeId ?? reservationId
	const ref: PayRef | null =
		id && idPattern.test(id)
			? { kind: feeId ? 'fee' : 'reservation', id }
			: null
	const purpose = pick('purpose')
	return {
		ref,
		// The token only travels in the fragment.
		token: fragment.get('t')?.trim() || null,
		purpose:
			purpose && PURPOSES.has(purpose) ? (purpose as PaymentPurpose) : null,
	}
}

// Client ---------------------------------------------------------------------

export class PayApiError extends Error {
	readonly status: number
	readonly code: string
	readonly retryable: boolean
	constructor(status: number, code: string, retryable: boolean) {
		super(code)
		this.name = 'PayApiError'
		this.status = status
		this.code = code
		this.retryable = retryable
	}
}

export type PayStatus = {
	paymentStatus: string
	reservationStatus: string
	expiresAt?: string
	purpose?: string
	mode?: string
}

export type PayCheckout = {
	checkoutUrl: string
	sessionId?: string
	processor?: string
	purpose?: string
	mode?: string
}

export function createPaymentApi(
	options: { fetchImpl?: typeof fetch; base?: string } = {},
) {
	const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
	const base = options.base ?? ''
	async function post<T>(
		path: string,
		ref: PayRef,
		input: { token: string; purpose: PaymentPurpose; locale?: string },
		signal?: AbortSignal,
	): Promise<T> {
		const res = await fetchImpl(`${base}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...(ref.kind === 'fee' ? { feeId: ref.id } : { reservationId: ref.id }),
				paymentToken: input.token,
				purpose: input.purpose,
				...(input.locale ? { locale: input.locale } : {}),
			}),
			signal,
		})
		const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
		if (!res.ok) {
			throw new PayApiError(
				res.status,
				typeof data.error === 'string' ? data.error : 'error',
				data.retryable === true,
			)
		}
		return data as T
	}
	return {
		checkout: (
			ref: PayRef,
			input: { token: string; purpose: PaymentPurpose; locale?: string },
		) => post<PayCheckout>('/api/reservations/payment', ref, input),
		status: (
			ref: PayRef,
			input: { token: string; purpose: PaymentPurpose; locale?: string },
			signal?: AbortSignal,
		) =>
			post<PayStatus>('/api/reservations/payment-status', ref, input, signal),
	}
}

export type PayApi = ReturnType<typeof createPaymentApi>

// State ----------------------------------------------------------------------

const PAID = new Set(['paid', 'guaranteed', 'fee_charged'])
const DEAD = new Set([
	'cancelled',
	'expired',
	'declined',
	'no_show',
	'finished',
])

export type PayOutcome =
	'paid' | 'expired' | 'failed' | 'review' | 'refunded' | 'pending'

/** Maps a status answer to what the guest sees. Only the answer can say "paid". */
export function interpretPay(
	status: Pick<PayStatus, 'paymentStatus' | 'reservationStatus'>,
	purpose: PaymentPurpose,
): PayOutcome {
	if (PAID.has(status.paymentStatus)) return 'paid'
	if (status.paymentStatus === 'fee_failed') return 'failed'
	if (
		status.paymentStatus === 'review' ||
		status.paymentStatus === 'disputed'
	) {
		return 'review'
	}
	if (
		status.paymentStatus === 'refunded' ||
		status.paymentStatus === 'partially_refunded' ||
		status.paymentStatus === 'refund_pending'
	) {
		return 'refunded'
	}
	if (purpose !== 'fee' && DEAD.has(status.reservationStatus)) return 'expired'
	return 'pending'
}

/** Candidate purposes, the known one first (the pay link does not carry it). */
export function purposeCandidates(
	ref: PayRef,
	known: PaymentPurpose | null | undefined,
): PaymentPurpose[] {
	if (ref.kind === 'fee') return ['fee']
	return known && known !== 'fee'
		? [known, ...RESERVATION_PURPOSES.filter((item) => item !== known)]
		: [...RESERVATION_PURPOSES]
}

export const POLL_DELAYS_MS = [1500, 2500, 4000, 6000, 10000]
export const POLL_MAX_MS = 180_000
const STOP_STATUSES = new Set([401, 403, 404])

export type Poller = { start(): void; stop(): void; pollNow(): void }

/**
 * Polls with back-off. A newer request supersedes an older one in flight, so a
 * slow answer can never overwrite a newer one. It stops for good on 401, 403 and
 * 404 and after `maxMs`.
 */
export function createPoller<T>(options: {
	fetch: () => Promise<T>
	onResult: (value: T) => boolean
	onError?: (error: unknown, stopped: boolean) => void
	onTimeout?: () => void
	delays?: number[]
	maxMs?: number
	now?: () => number
	schedule?: (fn: () => void, ms: number) => unknown
	cancel?: (handle: unknown) => void
}): Poller {
	const delays = options.delays ?? POLL_DELAYS_MS
	const maxMs = options.maxMs ?? POLL_MAX_MS
	const now = options.now ?? (() => Date.now())
	const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
	const cancel =
		options.cancel ?? ((handle) => clearTimeout(handle as number | undefined))
	let seq = 0
	let attempt = 0
	let handle: unknown
	let startedAt = 0
	let running = false

	async function run() {
		handle = undefined
		if (!running) return
		const mine = ++seq
		let stopNow = false
		try {
			const value = await options.fetch()
			if (mine !== seq || !running) return
			attempt = 0
			if (options.onResult(value)) {
				running = false
				return
			}
		} catch (error) {
			if (mine !== seq || !running) return
			stopNow =
				typeof (error as { status?: unknown })?.status === 'number' &&
				STOP_STATUSES.has((error as { status: number }).status)
			options.onError?.(error, stopNow)
			if (stopNow) {
				running = false
				return
			}
			attempt += 1
		}
		if (now() - startedAt >= maxMs) {
			running = false
			options.onTimeout?.()
			return
		}
		const delay = delays[Math.min(attempt, delays.length - 1)]!
		handle = schedule(() => void run(), delay)
	}

	return {
		start() {
			running = true
			startedAt = now()
			attempt = 0
			if (handle !== undefined) cancel(handle)
			void run()
		},
		stop() {
			running = false
			seq += 1
			if (handle !== undefined) cancel(handle)
			handle = undefined
		},
		pollNow() {
			if (!running) {
				running = true
				startedAt = now()
			}
			if (handle !== undefined) cancel(handle)
			void run()
		},
	}
}

// Page -----------------------------------------------------------------------

export type PayPageDeps = {
	api: PayApi
	labels: ReservationLabels
	locale: string
	hash: string
	search: string
	/** `true` on `/reserve/pay/done`, the provider's return page. */
	done: boolean
	pageLocation: Pick<Location, 'hash' | 'pathname' | 'search'>
	history: Pick<History, 'replaceState' | 'state'>
	storage?: StorageLike
	redirect: (url: string) => void
	bookHref: string
	manageHref: string
	now?: () => number
	pollMaxMs?: number
	pollDelays?: number[]
	schedule?: (fn: () => void, ms: number) => unknown
	cancel?: (handle: unknown) => void
}

const PURPOSE_LABEL: Record<PaymentPurpose, keyof ReservationLabels> = {
	deposit: 'payPurposeDeposit',
	prepay: 'payPurposePrepay',
	experience: 'payPurposeExperience',
	guarantee: 'payPurposeGuarantee',
	fee: 'payPurposeFee',
}

export function checkoutErrorView(
	error: unknown,
):
	'invalid' | 'expired' | 'unavailable' | 'paid' | 'busy' | 'rate' | 'network' {
	if (!(error instanceof PayApiError)) return 'network'
	if (error.status === 429) return 'rate'
	if (error.code === 'already_paid') return 'paid'
	if (
		error.code === 'hold_expired' ||
		error.code === 'reservation_not_payable'
	) {
		return 'expired'
	}
	if (error.code === 'session_in_progress') return 'busy'
	if (error.status === 404 || error.code === 'payment_not_found')
		return 'invalid'
	if (error.status >= 500) return 'network'
	return 'unavailable'
}

export async function initPayPage(root: HTMLElement, deps: PayPageDeps) {
	const { api, labels, locale } = deps
	const now = deps.now ?? (() => Date.now())
	root.replaceChildren()

	const parsed = parsePayLocation(deps.hash, deps.search)
	const ref = parsed.ref
	const stored = ref ? readPay(ref, deps.storage) : null
	const token = parsed.token ?? stored?.token ?? null
	if (ref && parsed.token) {
		storePay(ref, { ...stored, token: parsed.token }, deps.storage)
	}
	if (parsed.token && deps.pageLocation.hash) {
		// Drop the secret but keep the non-secret reference (and purpose) so a
		// reload can still pair it with the token saved above.
		const kept = new URLSearchParams()
		if (ref) kept.set(ref.kind === 'fee' ? 'f' : 'r', ref.id)
		if (parsed.purpose) kept.set('purpose', parsed.purpose)
		const keptHash = kept.toString()
		deps.history.replaceState(
			deps.history.state,
			'',
			`${deps.pageLocation.pathname}${deps.pageLocation.search}${keptHash ? `#${keptHash}` : ''}`,
		)
	}

	const statusBox = el('div')
	statusBox.setAttribute('aria-live', 'polite')
	const card = el('section', cardClass)
	card.setAttribute('aria-labelledby', 'rsv-pay-heading')
	root.append(statusBox, card)

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

	function view(
		title: string,
		body: string | null,
		...extra: Array<HTMLElement | null>
	) {
		card.replaceChildren()
		const heading = el('h2', 'text-xl font-semibold text-foreground', title)
		heading.id = 'rsv-pay-heading'
		heading.tabIndex = -1
		card.append(heading)
		if (body) card.append(el('p', 'text-sm text-muted-foreground', body))
		for (const node of extra) if (node) card.append(node)
		heading.focus({ preventScroll: true })
	}

	function link(href: string, text: string, primary = false) {
		const a = el('a', primary ? primaryButtonClass : secondaryButtonClass, text)
		a.href = href
		return a
	}

	function button(text: string, onClick: () => void, primary = true) {
		const b = el(
			'button',
			primary ? primaryButtonClass : secondaryButtonClass,
			text,
		)
		b.type = 'button'
		b.addEventListener('click', onClick)
		return b
	}

	if (!ref || !token) {
		view(
			labels.payInvalidTitle,
			labels.payInvalidBody,
			link(deps.bookHref, labels.bookAnother),
		)
		return
	}
	const payRef: PayRef = ref
	const payToken: string = token

	let purpose: PaymentPurpose | null = stored?.purpose ?? parsed.purpose ?? null
	let last: PayStatus | null = null
	let poller: Poller | null = null
	let redirecting = false

	function remember(patch: Partial<StoredPay>) {
		storePay(
			payRef,
			{ ...(readPay(payRef, deps.storage) ?? { token: payToken }), ...patch },
			deps.storage,
		)
	}

	/** Finds the purpose the pay link belongs to, then reads the status. */
	async function probe(signal?: AbortSignal): Promise<PayStatus> {
		const candidates = purposeCandidates(payRef, purpose)
		let lastError: unknown = null
		for (const candidate of candidates) {
			try {
				const result = await api.status(
					payRef,
					{ token: payToken, purpose: candidate, locale },
					signal,
				)
				if (purpose !== candidate) {
					purpose = candidate
					remember({ purpose: candidate })
				}
				return result
			} catch (error) {
				lastError = error
				if (error instanceof PayApiError && error.code === 'purpose_mismatch') {
					continue
				}
				throw error
			}
		}
		throw lastError ?? new PayApiError(404, 'payment_not_found', false)
	}

	function money(amountMinor?: number, currency?: string) {
		if (amountMinor === undefined || !currency) return null
		const value = el(
			'bdi',
			'font-semibold tabular-nums',
			formatMinor(amountMinor, currency, locale),
		)
		value.dir = 'ltr'
		return value
	}

	function settledView(outcome: PayOutcome) {
		poller?.stop()
		const kind = purpose ?? 'deposit'
		if (outcome === 'paid') {
			const title =
				kind === 'guarantee'
					? labels.paySuccessGuaranteeTitle
					: kind === 'fee'
						? labels.paySuccessFeeTitle
						: labels.paySuccessTitle
			view(
				title,
				kind === 'fee' ? labels.paySuccessFeeBody : labels.paySuccessBody,
				kind === 'fee'
					? null
					: link(deps.manageHref, labels.payViewReservation, true),
			)
			say(null)
			card.dataset.state = 'paid'
			return
		}
		if (outcome === 'expired') {
			view(
				labels.payExpiredTitle,
				labels.payExpiredBody,
				link(deps.bookHref, labels.bookAnother, true),
			)
			card.dataset.state = 'expired'
			return
		}
		if (outcome === 'review') {
			view(labels.payReviewTitle, labels.payReviewBody)
			card.dataset.state = 'review'
			return
		}
		view(
			labels.payStatusRefunded,
			null,
			link(deps.bookHref, labels.bookAnother),
		)
		card.dataset.state = 'refunded'
	}

	let countdownTimer: ReturnType<typeof setInterval> | undefined
	function readyView(status: PayStatus, failed: boolean) {
		poller?.stop()
		const kind = purpose ?? 'deposit'
		const info = readPay(payRef, deps.storage) ?? stored
		const amount = money(info?.amountMinor, info?.currency)
		const lines: Array<HTMLElement | null> = []
		const purposeLine = el(
			'p',
			'text-sm font-medium text-foreground',
			labels[PURPOSE_LABEL[kind]],
		)
		lines.push(purposeLine)
		if (kind === 'guarantee') {
			lines.push(el('p', 'text-sm text-muted-foreground', labels.payAmountCard))
		} else if (amount) {
			const row = el('p', 'text-sm text-foreground')
			row.append(document.createTextNode(`${labels.payAmountDue}: `), amount)
			lines.push(row)
		}
		const expiresAt = status.expiresAt ?? info?.expiresAt
		const timer = el(
			'p',
			'font-mono text-lg font-semibold tabular-nums text-foreground',
		)
		timer.dir = 'ltr'
		timer.setAttribute('role', 'timer')
		let timerVisible = false
		if (expiresAt && kind !== 'fee') {
			const target = Date.parse(expiresAt) - (info?.clockOffsetMs ?? 0)
			if (!Number.isNaN(target)) {
				timerVisible = true
				const tick = () => {
					const remaining = holdRemainingMs(target, now())
					timer.textContent = fillTemplate(labels.payExpiresIn, {
						time: formatHoldClock(remaining),
					})
					if (remaining <= 0) {
						clearInterval(countdownTimer)
						settledView('expired')
					}
				}
				tick()
				clearInterval(countdownTimer)
				countdownTimer = setInterval(tick, 1000)
			}
		}
		if (timerVisible) lines.push(timer)
		const go = button(
			failed ? labels.payTryAgain : labels.payContinue,
			() => void startCheckout(go),
		)
		go.dataset.action = 'pay'
		view(
			failed ? labels.payFailedTitle : labels.payPageTitle,
			failed ? labels.payFailedBody : labels.payPageSubtitle,
			...lines,
			go,
		)
		card.dataset.state = failed ? 'failed' : 'ready'
		if (!failed) say(null)
	}

	async function startCheckout(trigger: HTMLButtonElement) {
		if (redirecting || !purpose) return
		trigger.disabled = true
		say(null)
		try {
			const result = await api.checkout(payRef, {
				token: payToken,
				purpose,
				locale,
			})
			redirecting = true
			clearInterval(countdownTimer)
			say(labels.payRedirecting)
			deps.redirect(result.checkoutUrl)
		} catch (error) {
			trigger.disabled = false
			const kind = checkoutErrorView(error)
			if (kind === 'paid') {
				await refresh()
				return
			}
			if (kind === 'expired') return settledView('expired')
			if (kind === 'invalid') {
				return view(
					labels.payInvalidTitle,
					labels.payInvalidBody,
					link(deps.bookHref, labels.bookAnother),
				)
			}
			if (kind === 'busy') {
				say(labels.payChecking)
				startPolling()
				return
			}
			say(
				kind === 'rate'
					? labels.errorRateLimited
					: kind === 'network'
						? labels.errorNetwork
						: labels.errorPaymentUnavailable,
				'error',
			)
		}
	}

	function applyStatus(status: PayStatus): boolean {
		last = status
		const outcome = interpretPay(status, purpose ?? 'deposit')
		if (outcome === 'pending') return false
		if (outcome === 'failed') {
			readyView(status, true)
			return true
		}
		settledView(outcome)
		return true
	}

	function processingView(note: string | null = null) {
		view(
			labels.payChecking,
			labels.payPendingBody,
			note ? el('p', bannerInfoClass, note) : null,
		)
		card.dataset.state = 'processing'
	}

	function startPolling() {
		poller?.stop()
		poller = createPoller<PayStatus>({
			fetch: () => probe(),
			onResult: (status) => {
				const settled = applyStatus(status)
				if (!settled) processingView()
				return settled
			},
			onError: (_error, stopped) => {
				if (stopped) {
					view(
						labels.payInvalidTitle,
						labels.payInvalidBody,
						link(deps.bookHref, labels.bookAnother),
					)
					return
				}
				say(labels.payNetworkNote)
			},
			onTimeout: () => {
				view(
					labels.payPendingTitle,
					labels.payStillProcessing,
					button(labels.payCheckAgain, () => {
						processingView()
						startPolling()
					}),
				)
				card.dataset.state = 'stuck'
			},
			delays: deps.pollDelays,
			maxMs: deps.pollMaxMs,
			now,
			schedule: deps.schedule,
			cancel: deps.cancel,
		})
		poller.start()
	}

	async function refresh() {
		try {
			const status = await probe()
			if (applyStatus(status)) return
			if (deps.done) {
				processingView()
				startPolling()
			} else readyView(status, false)
		} catch (error) {
			if (error instanceof PayApiError && error.status === 404) {
				view(
					labels.payInvalidTitle,
					labels.payInvalidBody,
					link(deps.bookHref, labels.bookAnother),
				)
				return
			}
			if (error instanceof PayApiError && error.status === 401) {
				view(labels.payInvalidTitle, labels.payInvalidBody)
				return
			}
			const kind = checkoutErrorView(error)
			view(
				kind === 'network' ? labels.payChecking : labels.payUnavailableTitle,
				kind === 'network' ? labels.errorNetwork : labels.payUnavailableBody,
				button(labels.payTryAgain, () => void refresh()),
			)
		}
	}

	processingView()
	await refresh()
	void last
}
