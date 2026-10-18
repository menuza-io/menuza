import { type ReservationLabels } from './labels.ts'
import { latinDigits } from './time.ts'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'

export const chipClass =
	'inline-flex min-h-11 min-w-20 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-pressed:border-primary aria-pressed:bg-primary/10 disabled:opacity-50'

export const primaryButtonClass =
	'inline-flex h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50'

export const secondaryButtonClass =
	'inline-flex h-11 items-center justify-center rounded-md border border-input bg-background px-5 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50'

export const inputClass =
	'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 aria-[invalid=true]:border-destructive'

export const labelClass = 'text-sm font-medium leading-none text-foreground'

export const cardClass =
	'flex flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6'

export const errorTextClass = 'text-sm text-destructive'

export const bannerErrorClass =
	'rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive'

export const bannerInfoClass =
	'rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground'

export function guestsLabel(labels: ReservationLabels, count: number): string {
	return count === 1
		? labels.guestsOne
		: fillTemplate(labels.guestsMany, { count })
}

const STATUS_KEYS: Record<string, keyof ReservationLabels> = {
	booked: 'statusBooked',
	confirmed: 'statusBooked',
	requested: 'statusRequested',
	pending_approval: 'statusRequested',
	pending_payment: 'statusPendingPayment',
	arrived: 'statusArrived',
	partially_arrived: 'statusArrived',
	seated: 'statusSeated',
	partially_seated: 'statusSeated',
	finished: 'statusFinished',
	cancelled: 'statusCancelled',
	declined: 'statusDeclined',
	no_show: 'statusNoShow',
	expired: 'statusExpired',
}

export function statusLabel(labels: ReservationLabels, status: string): string {
	const key = STATUS_KEYS[status]
	return key ? labels[key] : status
}

const PAYMENT_STATUS_KEYS: Record<string, keyof ReservationLabels> = {
	paid: 'payStatusPaid',
	guaranteed: 'payStatusGuaranteed',
	pending: 'payStatusPending',
	refund_pending: 'payStatusRefundPending',
	refunded: 'payStatusRefunded',
	partially_refunded: 'payStatusPartiallyRefunded',
	fee_pending: 'payStatusFeePending',
	fee_charged: 'payStatusFeeCharged',
	fee_failed: 'payStatusFeeFailed',
	review: 'payStatusReview',
	disputed: 'payStatusDisputed',
}

/** The guest-facing word for a payment state, or `null` when there is nothing to say. */
export function paymentStatusLabel(
	labels: ReservationLabels,
	status: string | null | undefined,
): string | null {
	if (!status || status === 'none') return null
	const key = PAYMENT_STATUS_KEYS[status]
	return key ? labels[key] : null
}

/** A labelled input with an inline error slot tied to it by `aria-describedby`. */
export function field(options: {
	id: string
	name: string
	label: string
	type?: string
	hint?: string
	optional?: string
	autocomplete?: string
	maxLength?: number
	dir?: 'ltr' | 'rtl' | 'auto'
	required?: boolean
	value?: string
}) {
	const wrapper = el('div', 'flex flex-col gap-2')
	const label = el('label', labelClass, options.label)
	label.htmlFor = options.id
	if (options.optional) {
		label.append(
			el('span', 'font-normal text-muted-foreground', ` ${options.optional}`),
		)
	}
	const input = el('input', inputClass)
	input.id = options.id
	input.name = options.name
	input.type = options.type ?? 'text'
	if (options.autocomplete)
		input.setAttribute('autocomplete', options.autocomplete)
	if (options.maxLength) input.maxLength = options.maxLength
	if (options.dir) input.dir = options.dir
	if (options.required) input.required = true
	if (options.value) input.value = options.value
	const describedBy: string[] = []
	wrapper.append(label, input)
	if (options.hint) {
		const hint = el('p', 'text-xs text-muted-foreground', options.hint)
		hint.id = `${options.id}-hint`
		describedBy.push(hint.id)
		wrapper.append(hint)
	}
	const error = el('p', errorTextClass)
	error.id = `${options.id}-error`
	error.hidden = true
	wrapper.append(error)
	if (describedBy.length)
		input.setAttribute('aria-describedby', describedBy.join(' '))
	return { wrapper, input, error }
}

export function showFieldError(
	input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
	error: HTMLElement,
	message: string | null,
) {
	const base = (input.getAttribute('aria-describedby') ?? '')
		.split(' ')
		.filter((id) => id && id !== error.id)
	if (message) {
		error.textContent = message
		error.hidden = false
		input.setAttribute('aria-invalid', 'true')
		input.setAttribute('aria-describedby', [...base, error.id].join(' '))
	} else {
		error.textContent = ''
		error.hidden = true
		input.removeAttribute('aria-invalid')
		if (base.length) input.setAttribute('aria-describedby', base.join(' '))
		else input.removeAttribute('aria-describedby')
	}
}

/** `Tue, Jun 3` style label for an ISO instant, in the restaurant's zone. */
export function formatInstant(
	iso: string,
	timeZone: string,
	locale: string,
): string {
	try {
		return new Intl.DateTimeFormat(latinDigits(locale), {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			timeZone,
		}).format(new Date(iso))
	} catch {
		return iso
	}
}

/** Downloads a Blob as a file without leaving the page. */
export function downloadBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = filename
	document.body.append(link)
	link.click()
	link.remove()
	setTimeout(() => URL.revokeObjectURL(url), 1000)
}

type TurnstileApi = {
	render: (
		container: HTMLElement,
		options: {
			sitekey: string
			action?: string
			callback: (token: string) => void
			'expired-callback'?: () => void
			'error-callback'?: () => void
		},
	) => string
	reset: (widgetId?: string) => void
}

/** Human-check widget. A no-op (always `null`) when the site has no key. */
export function createChallenge(
	container: HTMLElement,
	siteKey: string,
	action = 'reservations',
) {
	let token: string | null = null
	let widgetId: string | undefined
	if (siteKey) {
		let tries = 0
		const mount = () => {
			const turnstile = (globalThis as { turnstile?: TurnstileApi }).turnstile
			if (!turnstile) {
				if (tries++ < 50) setTimeout(mount, 200)
				return
			}
			widgetId = turnstile.render(container, {
				sitekey: siteKey,
				action,
				callback: (value) => {
					token = value
				},
				'expired-callback': () => {
					token = null
				},
				'error-callback': () => {
					token = null
				},
			})
		}
		mount()
	}
	return {
		enabled: Boolean(siteKey),
		token: () => token,
		reset() {
			token = null
			const turnstile = (globalThis as { turnstile?: TurnstileApi }).turnstile
			if (widgetId !== undefined) turnstile?.reset(widgetId)
		},
	}
}
