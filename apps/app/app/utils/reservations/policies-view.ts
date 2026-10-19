import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
	currencyFractionDigits,
	formatMoney,
	parseMoneyInput,
} from '#app/utils/reservations/payments-view.ts'
import {
	POLICY_LOCALES,
	type PolicyBody,
	type PolicyDto,
	type PolicyKind,
	type PolicyLocale,
	type PolicyRefundRule,
} from '#app/utils/reservations/policies-api.ts'

export const POLICY_KIND_LABELS: Record<PolicyKind, MessageDescriptor> = {
	none: msg`No payment`,
	card_guarantee: msg`Card guarantee`,
	deposit: msg`Deposit`,
	prepay: msg`Prepayment`,
}

export const POLICY_KIND_HINTS: Record<PolicyKind, MessageDescriptor> = {
	none: msg`Guests book without paying or leaving a card.`,
	card_guarantee: msg`Guests leave a card. Nothing is charged unless you charge a fee.`,
	deposit: msg`Guests pay a deposit to hold the table.`,
	prepay: msg`Guests pay in full to book.`,
}

export const POLICY_REFUND_RULE_LABELS: Record<
	PolicyRefundRule,
	MessageDescriptor
> = {
	full_before_window: msg`Full refund before the free-cancellation deadline`,
	partial: msg`Partial refund after the deadline`,
	none: msg`No refund`,
}

export const POLICY_LOCALE_LABELS: Record<PolicyLocale, MessageDescriptor> = {
	en: msg`English`,
	ar: msg`Arabic`,
	es: msg`Spanish`,
	fr: msg`French`,
	de: msg`German`,
	zh: msg`Chinese`,
}

export type PolicyFormValues = {
	name: string
	kind: PolicyKind
	amount: string
	perCover: boolean
	freeCancelHours: string
	lateCancelFee: string
	noShowFee: string
	feePerCover: boolean
	feeCap: string
	refundRule: PolicyRefundRule
	partialRefundPercent: string
	appliesPartyMin: string
	terms: Partial<Record<PolicyLocale, string>>
}

export type PolicyFormField =
	| 'name'
	| 'amount'
	| 'freeCancelHours'
	| 'lateCancelFee'
	| 'noShowFee'
	| 'feeCap'
	| 'partialRefundPercent'
	| 'appliesPartyMin'

export type PolicyFormErrors = Partial<
	Record<PolicyFormField, MessageDescriptor>
>

const MAX_FREE_CANCEL_HOURS = 720

/** Minor units -> the text a person types ("25.00"; "" for zero or empty). */
export function minorToInput(
	minor: number | null | undefined,
	currency: string,
): string {
	if (!minor) return ''
	const digits = currencyFractionDigits(currency)
	return (minor / 10 ** digits).toFixed(digits)
}

export function emptyPolicyForm(
	kind: PolicyKind = 'deposit',
): PolicyFormValues {
	return {
		name: '',
		kind,
		amount: '',
		perCover: true,
		freeCancelHours: '24',
		lateCancelFee: '',
		noShowFee: '',
		feePerCover: false,
		feeCap: '',
		refundRule: 'full_before_window',
		partialRefundPercent: '50',
		appliesPartyMin: '',
		terms: {},
	}
}

export function policyToForm(
	policy: PolicyDto,
	currency: string,
): PolicyFormValues {
	const terms: Partial<Record<PolicyLocale, string>> = {}
	for (const locale of POLICY_LOCALES) {
		const text = policy.termsI18n[locale]
		if (text) terms[locale] = text
	}
	return {
		name: policy.name,
		kind: policy.kind,
		amount: minorToInput(policy.amountMinor, currency),
		perCover: policy.perCover,
		freeCancelHours: String(policy.freeCancelUntilMin / 60),
		lateCancelFee: minorToInput(policy.lateCancelFeeMinor, currency),
		noShowFee: minorToInput(policy.noShowFeeMinor, currency),
		feePerCover: policy.feePerCover,
		feeCap: minorToInput(policy.feeCapMinor, currency),
		refundRule: policy.refundRule,
		partialRefundPercent: policy.partialRefundBp
			? String(policy.partialRefundBp / 100)
			: '50',
		appliesPartyMin:
			policy.appliesPartyMin === null ? '' : String(policy.appliesPartyMin),
		terms,
	}
}

type Parsed =
	{ ok: true; body: PolicyBody } | { ok: false; errors: PolicyFormErrors }

/**
 * Form text -> the request body, or the field errors to show. Money is parsed
 * from text into integer minor units (never through floats); the window is
 * typed in hours and stored in minutes. Mirrors what the region will accept so
 * the common mistakes are caught before the request.
 */
export function policyFormToBody(
	form: PolicyFormValues,
	currency: string,
): Parsed {
	const errors: PolicyFormErrors = {}
	const name = form.name.trim()
	if (!name) errors.name = msg`Enter a name for this policy.`

	const money = (
		text: string,
		field: PolicyFormField,
		required: boolean,
	): number => {
		if (!text.trim()) {
			if (required) errors[field] = msg`Enter an amount like 25.00.`
			return 0
		}
		const minor = parseMoneyInput(text, currency)
		if (minor === null) {
			errors[field] = msg`Enter an amount like 25.00.`
			return 0
		}
		return minor
	}

	const takesMoney = form.kind === 'deposit' || form.kind === 'prepay'
	const hasFees = form.kind !== 'none'
	const amountMinor = takesMoney ? money(form.amount, 'amount', true) : 0
	const lateCancelFeeMinor = hasFees
		? money(form.lateCancelFee, 'lateCancelFee', false)
		: 0
	const noShowFeeMinor = hasFees ? money(form.noShowFee, 'noShowFee', false) : 0
	const feeCapMinor =
		hasFees && form.feeCap.trim() ? money(form.feeCap, 'feeCap', false) : null

	const hoursText = form.freeCancelHours.trim()
	const hours = hoursText === '' ? 0 : Number(hoursText)
	if (
		!Number.isFinite(hours) ||
		hours < 0 ||
		hours > MAX_FREE_CANCEL_HOURS ||
		!Number.isInteger(hours * 60)
	) {
		errors.freeCancelHours = msg`Enter the hours before the booking, from 0 to 720.`
	}

	let partialRefundBp: number | null = null
	if (form.refundRule === 'partial') {
		const percent = Number(form.partialRefundPercent)
		if (
			!Number.isFinite(percent) ||
			percent < 0.01 ||
			percent > 100 ||
			!Number.isInteger(Math.round(percent * 100))
		) {
			errors.partialRefundPercent = msg`Enter a percentage from 1 to 100.`
		} else {
			partialRefundBp = Math.round(percent * 100)
		}
	}

	let appliesPartyMin: number | null = null
	if (form.appliesPartyMin.trim()) {
		const party = Number(form.appliesPartyMin)
		if (!Number.isInteger(party) || party < 1 || party > 99) {
			errors.appliesPartyMin = msg`Enter a party size from 1 to 99.`
		} else {
			appliesPartyMin = party
		}
	}

	if (Object.keys(errors).length > 0) return { ok: false, errors }

	const termsI18n: Partial<Record<PolicyLocale, string>> = {}
	for (const locale of POLICY_LOCALES) {
		const text = form.terms[locale]?.trim()
		if (text) termsI18n[locale] = text
	}

	return {
		ok: true,
		body: {
			name,
			kind: form.kind,
			amountMinor,
			perCover: takesMoney ? form.perCover : false,
			freeCancelUntilMin: Math.round(hours * 60),
			lateCancelFeeMinor,
			noShowFeeMinor,
			feePerCover: hasFees ? form.feePerCover : false,
			feeCapMinor: hasFees ? feeCapMinor : null,
			refundRule: takesMoney ? form.refundRule : 'full_before_window',
			partialRefundBp: takesMoney ? partialRefundBp : null,
			appliesPartyMin,
			termsI18n,
		},
	}
}

const ISSUE_FIELDS: Record<string, PolicyFormField> = {
	name: 'name',
	amountMinor: 'amount',
	freeCancelUntilMin: 'freeCancelHours',
	lateCancelFeeMinor: 'lateCancelFee',
	noShowFeeMinor: 'noShowFee',
	feeCapMinor: 'feeCap',
	partialRefundBp: 'partialRefundPercent',
	appliesPartyMin: 'appliesPartyMin',
}

const POLICY_ERRORS: Record<string, MessageDescriptor> = {
	stale_version: msg`Someone else changed this policy first. Close this panel and open the policy again to see their changes; your edits were not saved.`,
	policy_unavailable: msg`Your payment setup does not support this kind of policy yet. Finish connecting payments first.`,
	feature_off: msg`Online payments are not turned on for this restaurant.`,
	not_found: msg`This policy no longer exists. The list has been reloaded.`,
	invalid: msg`Some fields need another look.`,
	forbidden: msg`You do not have permission to change payment policies.`,
	missing_grant: msg`You do not have permission to change payment policies.`,
}

export function policyErrorCode(err: unknown): string | null {
	if (!err || typeof err !== 'object') return null
	const body = (err as { body?: { error?: string; code?: string } }).body
	return body?.error ?? body?.code ?? null
}

export function policyErrorStatus(err: unknown): number | null {
	const status =
		err && typeof err === 'object' ? (err as { status?: unknown }).status : null
	return typeof status === 'number' ? status : null
}

/** One translated sentence for a failed policy call. Never echoes server text. */
export function policyErrorMessage(
	err: unknown,
	translate: (descriptor: MessageDescriptor) => string,
	fallback: MessageDescriptor,
): string {
	const code = policyErrorCode(err)
	if (code && POLICY_ERRORS[code]) return translate(POLICY_ERRORS[code]!)
	if (policyErrorStatus(err) === 403) return translate(POLICY_ERRORS.forbidden!)
	return translate(fallback)
}

/** Fields the region flagged (`issues[].path`), mapped onto form fields. */
export function policyIssueFields(err: unknown): PolicyFormField[] {
	if (!err || typeof err !== 'object') return []
	const issues = (err as { body?: { issues?: unknown } }).body?.issues
	if (!Array.isArray(issues)) return []
	return issues.flatMap((issue) => {
		const path = (issue as { path?: unknown } | null)?.path
		const field = typeof path === 'string' ? ISSUE_FIELDS[path] : undefined
		return field ? [field] : []
	})
}

/**
 * One plain-language sentence for the policy being edited, so a host can read
 * back what guests will experience ("Guests pay $10 per guest to book. Free
 * cancellation until 24 h before; after that the deposit is kept."). Returns
 * `null` while the form is too empty to describe. Pure; `translate` is the
 * Lingui `i18n._`.
 */
export function summarizePolicyForm(
	form: PolicyFormValues,
	currency: string,
	locale: string,
	translate: (descriptor: MessageDescriptor) => string,
): string | null {
	const parts: string[] = []
	const money = (text: string) => {
		const minor = parseMoneyInput(text, currency)
		return minor === null ? null : formatMoney(minor, currency, locale)
	}
	const hours = Number.parseInt(form.freeCancelHours, 10)
	const hasWindow = Number.isFinite(hours) && hours >= 0

	if (form.kind === 'none') {
		return translate(msg`Guests book without paying or leaving a card.`)
	}
	if (form.kind === 'card_guarantee') {
		parts.push(
			translate(msg`Guests leave a card to book. Nothing is charged up front.`),
		)
		const fee = money(form.lateCancelFee)
		const noShow = money(form.noShowFee)
		if (hasWindow && fee) {
			parts.push(
				translate(
					msg`Free cancellation until ${hours} h before; after that a ${fee} fee may be charged.`,
				),
			)
		}
		if (noShow) {
			parts.push(translate(msg`A no-show may be charged ${noShow}.`))
		}
		return parts.join(' ')
	}
	const amount = money(form.amount)
	if (!amount) return null
	parts.push(
		form.perCover
			? translate(
					form.kind === 'prepay'
						? msg`Guests prepay ${amount} per guest to book.`
						: msg`Guests pay ${amount} per guest to book.`,
				)
			: translate(
					form.kind === 'prepay'
						? msg`Guests prepay ${amount} per booking.`
						: msg`Guests pay ${amount} per booking to book.`,
				),
	)
	if (form.refundRule === 'none') {
		parts.push(translate(msg`The payment is not refundable.`))
	} else if (hasWindow) {
		const percent = Number.parseInt(form.partialRefundPercent, 10)
		parts.push(
			form.refundRule === 'partial' && Number.isFinite(percent)
				? translate(
						msg`Free cancellation until ${hours} h before; after that ${percent}% is refunded.`,
					)
				: translate(
						msg`Free cancellation until ${hours} h before; after that the payment is kept.`,
					),
		)
	}
	return parts.join(' ')
}
