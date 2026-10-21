import { storeManageToken } from './fragment.ts'
import { formatHoldClock, holdRemainingMs } from './hold.ts'
import { type ReservationLabels } from './labels.ts'
import { formatMinor } from './money.ts'
import { createPaymentApi, PayApiError, storePay, type PayApi } from './pay.ts'
import { type BookingResponse, type HoldPolicy } from './types.ts'
import {
	bannerErrorClass,
	bannerInfoClass,
	errorTextClass,
	primaryButtonClass,
	secondaryButtonClass,
} from './ui.ts'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'

function amount(value: number, currency: string, locale: string) {
	const node = el(
		'bdi',
		'font-semibold tabular-nums',
		formatMinor(value, currency, locale),
	)
	node.dir = 'ltr'
	return node
}

/** `{amount}` placeholders become isolated, locale-formatted money nodes. */
function lineWithMoney(
	template: string,
	values: Record<string, string>,
	money: Record<string, HTMLElement>,
) {
	const p = el('p', 'text-sm text-foreground')
	const parts = template.split(/(\{\w+\})/)
	for (const part of parts) {
		const key = /^\{(\w+)\}$/.exec(part)?.[1]
		if (key && money[key]) p.append(money[key])
		else if (key && key in values)
			p.append(document.createTextNode(values[key]!))
		else if (part) p.append(document.createTextNode(part))
	}
	return p
}

export function freeCancelText(labels: ReservationLabels, minutes: number) {
	if (minutes <= 0) return labels.policyFreeCancelStart
	if (minutes % 1440 === 0) {
		return fillTemplate(labels.policyFreeCancelDays, { count: minutes / 1440 })
	}
	if (minutes % 60 === 0) {
		return fillTemplate(labels.policyFreeCancelHours, { count: minutes / 60 })
	}
	return fillTemplate(labels.policyFreeCancelMinutes, { count: minutes })
}

/** What the guest owes or guarantees, the terms text and the required consent. */
export function buildPolicyPanel(options: {
	labels: ReservationLabels
	policy: HoldPolicy
	locale: string
	partySize: number
	idPrefix?: string
}) {
	const { labels, policy, locale } = options
	const id = options.idPrefix ?? 'rsv'
	const box = el(
		'section',
		'flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4',
	)
	box.dataset.policyPanel = policy.purpose
	box.setAttribute('aria-labelledby', `${id}-policy-heading`)
	const heading = el(
		'h3',
		'text-base font-semibold text-foreground',
		labels.policyHeading,
	)
	heading.id = `${id}-policy-heading`
	box.append(heading)

	const money = (value: number) => amount(value, policy.currency, locale)
	if (policy.purpose === 'guarantee') {
		box.append(el('p', 'text-sm text-foreground', labels.policyGuarantee))
	} else {
		const template =
			policy.purpose === 'prepay'
				? labels.policyPayPrepay
				: policy.purpose === 'experience'
					? labels.policyPayExperience
					: labels.policyPayDeposit
		box.append(
			lineWithMoney(template, {}, { amount: money(policy.totalAmountMinor) }),
		)
		if (policy.perCover) {
			box.append(
				lineWithMoney(
					labels.policyPerCover,
					{ count: String(options.partySize) },
					{ unit: money(policy.amountMinor) },
				),
			)
		}
	}
	box.append(
		el(
			'p',
			'text-sm text-muted-foreground',
			freeCancelText(labels, policy.freeCancelUntilMin),
		),
	)
	if (policy.lateCancelFeeMinor > 0) {
		box.append(
			lineWithMoney(
				labels.policyLateCancelFee,
				{},
				{ amount: money(policy.lateCancelFeeMinor) },
			),
		)
	}
	if (policy.noShowFeeMinor > 0) {
		box.append(
			lineWithMoney(
				labels.policyNoShowFee,
				{},
				{ amount: money(policy.noShowFeeMinor) },
			),
		)
	}
	if (policy.terms) {
		const terms = el(
			'p',
			'whitespace-pre-line text-sm text-muted-foreground wrap-anywhere',
			policy.terms,
		)
		terms.dataset.policyTerms = ''
		box.append(terms)
	}

	const label = el(
		'label',
		'flex cursor-pointer items-start gap-3 text-sm text-foreground',
	)
	const consent = el('input', 'mt-0.5 size-5 shrink-0 accent-primary')
	consent.type = 'checkbox'
	consent.id = `${id}-policy-consent`
	consent.name = 'policyAccepted'
	consent.required = true
	label.append(consent, el('span', undefined, labels.policyConsent))
	const error = el('p', errorTextClass, labels.policyConsentRequired)
	error.id = `${id}-policy-consent-error`
	error.hidden = true
	box.append(label, error)
	consent.addEventListener('change', () => {
		if (consent.checked) {
			error.hidden = true
			consent.removeAttribute('aria-invalid')
			consent.removeAttribute('aria-describedby')
		}
	})
	return {
		element: box,
		consent,
		accepted: () => consent.checked,
		/** Marks the checkbox invalid and focuses it; returns whether it is accepted. */
		check(): boolean {
			if (consent.checked) return true
			error.hidden = false
			consent.setAttribute('aria-invalid', 'true')
			consent.setAttribute('aria-describedby', error.id)
			consent.focus()
			return false
		},
	}
}

export type PaymentStepDeps = {
	labels: ReservationLabels
	locale: string
	booking: BookingResponse
	/** Server clock minus device clock, from the hold answer. */
	clockOffsetMs: number
	api?: PayApi
	redirect: (url: string) => void
	storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
	now?: () => number
	bookHref: string
	/** Called when the payment window runs out. */
	onExpired?: () => void
}

/**
 * Shown instead of the confirmation while a booking waits for payment. The
 * table stays held until `payment.expiresAt`; a confirmation only appears after
 * the status poll on the return page says the payment is settled.
 */
export function createPaymentStep(deps: PaymentStepDeps) {
	const { labels, locale, booking } = deps
	const payment = booking.payment!
	const now = deps.now ?? (() => Date.now())
	const api = deps.api ?? createPaymentApi()
	const root = el('div', 'flex flex-col gap-4')
	root.dataset.paymentStep = payment.purpose
	const heading = el(
		'h2',
		'text-xl font-semibold text-foreground',
		labels.payStepTitle,
	)
	heading.id = 'rsv-done-heading'
	root.append(
		heading,
		el('p', 'text-sm text-muted-foreground', labels.payStepBody),
	)

	const due = el('p', 'text-base text-foreground')
	if (payment.purpose === 'guarantee') {
		due.textContent = labels.payAmountCard
	} else {
		due.append(
			document.createTextNode(`${labels.payAmountDue}: `),
			amount(payment.amountMinor, payment.currency, locale),
		)
	}
	root.append(due)

	const timer = el(
		'p',
		'font-mono text-lg font-semibold tabular-nums text-foreground',
	)
	timer.dir = 'ltr'
	timer.setAttribute('role', 'timer')
	const target = Date.parse(payment.expiresAt) - deps.clockOffsetMs
	const bannerBox = el('div')
	bannerBox.setAttribute('aria-live', 'polite')
	const actions = el('div', 'flex flex-wrap gap-3')
	const go = el('button', primaryButtonClass, labels.payContinue)
	go.type = 'button'
	go.dataset.action = 'pay'
	actions.append(go)
	root.append(timer, bannerBox, actions)

	let interval: ReturnType<typeof setInterval> | undefined
	let busy = false
	let redirected = false

	function banner(text: string | null, kind: 'error' | 'info' = 'error') {
		bannerBox.replaceChildren()
		if (!text) return
		const note = el(
			'p',
			kind === 'error' ? bannerErrorClass : bannerInfoClass,
			text,
		)
		if (kind === 'error') note.setAttribute('role', 'alert')
		bannerBox.append(note)
	}

	function expire() {
		clearInterval(interval)
		go.disabled = true
		banner(labels.payStepExpired)
		const again = el('a', secondaryButtonClass, labels.bookAnother)
		again.href = deps.bookHref
		actions.replaceChildren(again)
		deps.onExpired?.()
	}

	function tick() {
		if (Number.isNaN(target)) {
			timer.hidden = true
			return
		}
		const remaining = holdRemainingMs(target, now())
		timer.textContent = fillTemplate(labels.payStepHeldFor, {
			time: formatHoldClock(remaining),
		})
		if (remaining <= 0) expire()
	}
	tick()
	interval = setInterval(tick, 1000)

	go.addEventListener('click', async () => {
		if (busy || redirected) return
		busy = true
		go.disabled = true
		banner(null)
		const reservationId = booking.reservation.id
		const ref = { kind: 'reservation' as const, id: reservationId }
		// The token is a capability: keep it per tab so the return page can use it,
		// and keep the manage token so the confirmation can link to the booking.
		storePay(
			ref,
			{
				token: payment.paymentToken,
				purpose: payment.purpose,
				amountMinor: payment.amountMinor,
				currency: payment.currency,
				expiresAt: payment.expiresAt,
				clockOffsetMs: deps.clockOffsetMs,
			},
			deps.storage,
		)
		storeManageToken(booking.manageToken, deps.storage)
		try {
			const result = await api.checkout(ref, {
				token: payment.paymentToken,
				purpose: payment.purpose,
				locale,
			})
			redirected = true
			clearInterval(interval)
			banner(labels.payRedirecting, 'info')
			deps.redirect(result.checkoutUrl)
		} catch (error) {
			busy = false
			go.disabled = false
			if (error instanceof PayApiError) {
				if (
					error.code === 'hold_expired' ||
					error.code === 'reservation_not_payable'
				) {
					expire()
					return
				}
				banner(
					error.status === 429
						? labels.errorRateLimited
						: error.status >= 500
							? labels.errorNetwork
							: labels.errorPaymentUnavailable,
				)
				return
			}
			banner(labels.errorNetwork)
		}
	})

	return {
		element: root,
		heading,
		destroy() {
			clearInterval(interval)
		},
	}
}
