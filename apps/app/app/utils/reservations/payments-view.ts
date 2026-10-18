import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

/**
 * Pure display rules for reservation payments: which badge a payment state
 * gets, the labels of payment rows, and money formatting. Money is always
 * integer minor units in the location currency; it is only turned into text
 * here, with `Intl.NumberFormat` in the interface locale.
 */

export type PaymentBadgeVariant =
	'secondary' | 'warning' | 'success' | 'destructive' | 'outline'

export type PaymentBadgeInfo = {
	variant: PaymentBadgeVariant
	label: MessageDescriptor
}

/** The reservation `payment_status` values that get a badge (`none` gets none). */
export function paymentBadge(
	paymentStatus: string | null | undefined,
	options: { experience?: boolean } = {},
): PaymentBadgeInfo | null {
	switch (paymentStatus) {
		case 'pending':
			return { variant: 'warning', label: msg`Awaiting payment` }
		case 'guaranteed':
			return { variant: 'secondary', label: msg`Card on file` }
		case 'paid':
			return {
				variant: 'success',
				label: options.experience ? msg`Prepaid` : msg`Deposit paid`,
			}
		case 'refund_pending':
			return { variant: 'warning', label: msg`Refund pending` }
		case 'refunded':
			return { variant: 'outline', label: msg`Refunded` }
		case 'partially_refunded':
			return { variant: 'outline', label: msg`Partly refunded` }
		case 'fee_pending':
			return { variant: 'warning', label: msg`Fee due` }
		case 'fee_charged':
			return { variant: 'secondary', label: msg`Fee charged` }
		case 'fee_failed':
			return { variant: 'destructive', label: msg`Fee failed` }
		case 'review':
			return { variant: 'warning', label: msg`Payment needs review` }
		case 'disputed':
			return { variant: 'destructive', label: msg`Disputed` }
		default:
			return null
	}
}

export const PAYMENT_KIND_LABELS: Record<string, MessageDescriptor> = {
	card_setup: msg`Card guarantee`,
	hold_auth: msg`Card hold`,
	deposit_charge: msg`Deposit`,
	prepay_charge: msg`Prepayment`,
	cancel_fee_charge: msg`Late-cancel fee`,
	no_show_fee_charge: msg`No-show fee`,
	refund: msg`Refund`,
	release: msg`Hold released`,
}

export const PAYMENT_ROW_STATUS_LABELS: Record<string, MessageDescriptor> = {
	created: msg`Not started`,
	pending: msg`Awaiting payment`,
	charging: msg`Charging`,
	requires_action: msg`Needs card confirmation`,
	succeeded: msg`Succeeded`,
	failed: msg`Failed`,
	cancelled: msg`Cancelled`,
	expired: msg`Expired`,
	requested: msg`Refund queued`,
	refund_pending: msg`Refund processing`,
	refunded: msg`Refunded`,
	partially_refunded: msg`Partly refunded`,
	disputed: msg`Disputed`,
	review: msg`Needs review`,
}

/** Row statuses that are still moving, so the panel keeps refreshing. */
const IN_FLIGHT_ROW_STATUSES = new Set([
	'pending',
	'charging',
	'requested',
	'refund_pending',
])

export function hasInFlightPayment(
	rows: ReadonlyArray<{ status: string }>,
): boolean {
	return rows.some((row) => IN_FLIGHT_ROW_STATUSES.has(row.status))
}

export const PAYMENT_DECLINE_LABELS: Record<string, MessageDescriptor> = {
	card_declined: msg`The card was declined.`,
	insufficient_funds: msg`The card has insufficient funds.`,
	expired_card: msg`The card has expired.`,
	no_saved_card: msg`No card is saved for this booking.`,
	authentication_required: msg`The bank needs the guest to confirm the charge.`,
}

/** `409 fee_not_allowed` carries the reason the region refused the fee. */
export const FEE_NOT_ALLOWED_LABELS: Record<string, MessageDescriptor> = {
	status_not_eligible: msg`A fee can only be charged for a no-show or a late cancellation.`,
	no_policy: msg`This booking has no payment policy with a fee.`,
	no_guarantee: msg`This booking has no card on file.`,
	already_charged: msg`A fee was already charged for this booking.`,
	in_flight: msg`A fee is already being charged for this booking.`,
	retry_limit: msg`The fee was already retried once. Ask the guest to pay with a link instead.`,
	below_minimum: msg`That amount is below the minimum the card network allows.`,
	no_fee_configured: msg`The policy has no fee to charge.`,
	above_policy_fee: msg`That is more than the fee in the booking's policy. You can only lower it.`,
}

export const PAYMENT_ERROR_LABELS: Record<string, MessageDescriptor> = {
	stale_version: msg`This booking changed while you were looking at it. It has been reloaded; check it and try again.`,
	fee_not_claimable: msg`This fee is already being charged or was charged.`,
	fee_claim_rejected: msg`The fee could not be charged. Check the booking and try again.`,
	fee_mismatch: msg`The fee does not match this booking. Reload and try again.`,
	refund_exceeds_paid: msg`That is more than what is left to refund.`,
	invalid: msg`Check the amount and try again.`,
	provider_unavailable: msg`The payment provider did not answer. Nothing was lost; try again in a moment.`,
	regional_unavailable: msg`The payment service did not answer. Nothing was lost; try again in a moment.`,
	impersonation_forbidden: msg`Payments cannot be changed while impersonating.`,
	forbidden: msg`You do not have permission to change payments.`,
	missing_grant: msg`You do not have permission to change payments.`,
}

/** Decimal digits of a currency (2 for USD and SAR, 0 for JPY, 3 for KWD). */
export function currencyFractionDigits(currency: string): number {
	try {
		return (
			new Intl.NumberFormat('en', {
				style: 'currency',
				currency,
			}).resolvedOptions().maximumFractionDigits ?? 2
		)
	} catch {
		return 2
	}
}

/** `2500` + `USD` -> "$25.00" in the interface locale. */
export function formatMoney(
	minor: number,
	currency: string,
	locale: string,
): string {
	const digits = currencyFractionDigits(currency)
	const value = minor / 10 ** digits
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		}).format(value)
	} catch {
		return `${value.toFixed(digits)} ${currency}`
	}
}

/**
 * Typed amount ("25.50") -> integer minor units, or null when it is not a
 * positive amount with at most the currency's decimals. Never uses floats for
 * the final value: the digits are split as text.
 */
export function parseMoneyInput(text: string, currency: string): number | null {
	const digits = currencyFractionDigits(currency)
	const normalized = text.trim().replace(/,/g, '.')
	const match = /^(\d{1,9})(?:\.(\d+))?$/.exec(normalized)
	if (!match) return null
	const fraction = match[2] ?? ''
	if (fraction.length > digits) return null
	const minor =
		Number(match[1]) * 10 ** digits +
		Number(fraction.padEnd(digits, '0') || '0')
	return Number.isSafeInteger(minor) && minor > 0 ? minor : null
}

export type PaymentRowLike = {
	id: string
	kind: string
	status: string
	amountMinor: number
	refundedMinor: number
	parentPaymentId?: string | null
}

/** Money still refundable on succeeded charges (after refunds already issued). */
export function refundableMinor(rows: readonly PaymentRowLike[]): number {
	return rows
		.filter(
			(row) =>
				(row.kind === 'deposit_charge' || row.kind === 'prepay_charge') &&
				(row.status === 'succeeded' || row.status === 'partially_refunded'),
		)
		.reduce(
			(sum, row) => sum + Math.max(0, row.amountMinor - row.refundedMinor),
			0,
		)
}

/** The fee a host can still charge: a no-show or a late cancel with a card on file. */
export function feeKindFor(reservation: {
	status: string
	lateCancel: boolean
}): 'no_show_fee' | 'late_cancel_fee' | null {
	if (reservation.status === 'no_show') return 'no_show_fee'
	if (reservation.status === 'cancelled' && reservation.lateCancel) {
		return 'late_cancel_fee'
	}
	return null
}

type ErrorBody = { error?: string; code?: string; reason?: string }

/** One translated sentence for a failed payment call (never echoes server text). */
export function paymentErrorMessage(
	err: unknown,
	translate: (descriptor: MessageDescriptor) => string,
	fallback: MessageDescriptor,
): string {
	const body =
		err && typeof err === 'object'
			? ((err as { body?: unknown }).body as ErrorBody | null | undefined)
			: null
	const status =
		err && typeof err === 'object'
			? (err as { status?: unknown }).status
			: undefined
	const code = body?.error ?? body?.code ?? null
	if (code === 'fee_not_allowed') {
		const reason = body?.reason ? FEE_NOT_ALLOWED_LABELS[body.reason] : null
		return translate(reason ?? FEE_NOT_ALLOWED_LABELS.status_not_eligible!)
	}
	if (code && PAYMENT_ERROR_LABELS[code]) {
		return translate(PAYMENT_ERROR_LABELS[code]!)
	}
	if (status === 403) return translate(PAYMENT_ERROR_LABELS.forbidden!)
	return translate(fallback)
}
