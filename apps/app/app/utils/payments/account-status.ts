/**
 * Pure payment-account health evaluation, plain-English requirement wording,
 * and deadline reminder bucketing (#269).
 *
 * No PII, bank details, or document contents are ever stored or returned here.
 */

export type PaymentAccountHealthState =
	'active' | 'action_needed' | 'payouts_paused' | 'cannot_take_payments'

export const UNKNOWN_REQUIREMENT_MESSAGE =
	'Your payment provider needs more information'

/**
 * Fixed map from provider requirement codes (Stripe Connect & Checkout.com)
 * to plain-English sentences. Any unknown code maps to
 * `UNKNOWN_REQUIREMENT_MESSAGE`.
 */
export const REQUIREMENT_CODE_LABELS: Record<string, string> = {
	external_account: 'Add or update your payout bank account',
	bank_account: 'Add or update your payout bank account',
	'business_profile.url': 'Confirm your restaurant website or profile URL',
	'business_profile.mcc': 'Confirm your business category',
	'business_profile.support_phone': 'Add a business support phone number',
	'company.tax_id': 'Provide your business tax identification number',
	'company.registration_number': 'Provide your business registration number',
	'company.address.line1': 'Confirm your business street address',
	'company.address.postal_code': 'Confirm your business postal code',
	'company.verification.document': 'Upload a business verification document',
	'company.owners_provided': 'Confirm the beneficial owners of the business',
	'company.directors_provided': 'Confirm the company directors',
	'individual.id_number': 'Provide the account owner identity number',
	'individual.ssn_last_4': 'Provide the last four digits of your SSN',
	'individual.verification.document': 'Upload a government-issued photo ID',
	'individual.verification.additional_document':
		'Upload an additional proof of address document',
	'representative.verification.document':
		'Upload a government-issued photo ID for your account representative',
	'tos_acceptance.date': 'Accept the payment provider terms of service',
	'tos_acceptance.ip': 'Accept the payment provider terms of service',
	// Checkout.com requirement codes
	identity_verification: 'Upload a government-issued photo ID',
	business_verification: 'Upload a business verification document',
	payout_instrument: 'Add or update your payout bank account',
	tax_information: 'Provide your business tax identification number',
}

export function describeRequirementCode(code: string): string {
	const normalized = code.trim()
	if (!normalized) return UNKNOWN_REQUIREMENT_MESSAGE
	if (REQUIREMENT_CODE_LABELS[normalized]) {
		return REQUIREMENT_CODE_LABELS[normalized]!
	}
	// Strip Stripe person prefix like `person_1234.verification.document`
	const withoutPerson = normalized.replace(/^person_[^.]+\./, 'individual.')
	if (REQUIREMENT_CODE_LABELS[withoutPerson]) {
		return REQUIREMENT_CODE_LABELS[withoutPerson]!
	}
	return UNKNOWN_REQUIREMENT_MESSAGE
}

export function describeRequirements(codes: readonly string[]): string[] {
	const seen = new Set<string>()
	const result: string[] = []
	for (const code of codes) {
		const label = describeRequirementCode(code)
		if (!seen.has(label)) {
			seen.add(label)
			result.push(label)
		}
	}
	return result
}

export type EvaluatedPaymentAccountStatus = {
	state: PaymentAccountHealthState
	/** Stable deduplication key: same state + same sorted requirement codes = one email. */
	stateKey: string
	deadline: Date | null
	requirementDescriptions: string[]
	isUrgent: boolean
}

export function evaluatePaymentAccountState(input: {
	chargesEnabled: boolean
	payoutsEnabled: boolean
	requirementsDue: readonly string[]
	deadline: Date | null
}): EvaluatedPaymentAccountStatus {
	const sortedCodes = [...new Set(input.requirementsDue.filter(Boolean))].sort()
	const requirementDescriptions = describeRequirements(sortedCodes)

	let state: PaymentAccountHealthState
	if (!input.chargesEnabled) {
		state = 'cannot_take_payments'
	} else if (!input.payoutsEnabled) {
		state = 'payouts_paused'
	} else if (sortedCodes.length > 0 || input.deadline !== null) {
		state = 'action_needed'
	} else {
		state = 'active'
	}

	const deadlineDay = input.deadline
		? input.deadline.toISOString().slice(0, 10)
		: 'none'
	const stateKey =
		state === 'active'
			? 'active'
			: `${state}:${deadlineDay}:${sortedCodes.join(',')}`

	return {
		state,
		stateKey,
		deadline: input.deadline,
		requirementDescriptions,
		isUrgent: state !== 'active',
	}
}

/**
 * Returns the reminder bucket due at `nowMs` for a deadline:
 * - `7`: within 7 days (and > 3 days) before deadline
 * - `3`: within 3 days (and > 1 day) before deadline
 * - `1`: within 1 day (and > 0) before deadline
 * - `0`: deadline has passed
 * - `null`: more than 7 days away or no deadline
 */
export function duePaymentAccountReminderBucket(
	deadline: Date | null,
	nowMs = Date.now(),
): 7 | 3 | 1 | 0 | null {
	if (!deadline) return null
	const diffMs = deadline.getTime() - nowMs
	const DAY_MS = 86_400_000
	if (diffMs <= 0) return 0
	if (diffMs <= 1 * DAY_MS) return 1
	if (diffMs <= 3 * DAY_MS) return 3
	if (diffMs <= 7 * DAY_MS) return 7
	return null
}

/**
 * Returns true when `nextBucket` should fire given `lastBucket` already sent.
 * Buckets decrease as the deadline approaches (7 -> 3 -> 1 -> 0).
 */
export function shouldSendReminderBucket(
	nextBucket: 7 | 3 | 1 | 0 | null,
	lastBucket: number | null | undefined,
): boolean {
	if (nextBucket === null) return false
	if (lastBucket === null || lastBucket === undefined) return true
	return nextBucket < lastBucket
}
