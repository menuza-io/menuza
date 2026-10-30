/**
 * Stable machine-readable loyalty error codes. Domain code returns codes and
 * structured data, never user-facing English; clients translate the code.
 * Validation errors never echo the rejected value.
 */
export const LOYALTY_ERROR_CODES = [
	'loyalty_unavailable',
	'loyalty_disabled',
	'redemption_disabled',
	'program_not_found',
	'program_inactive',
	'member_not_found',
	'member_inactive',
	'reward_not_found',
	'reward_unavailable',
	'reward_not_applicable',
	'zero_value',
	'insufficient_points',
	'currency_mismatch',
	'stacking_not_allowed',
	'one_reward_per_order',
	'cart_changed',
	'stale_version',
	'idempotency_conflict',
	'redemption_not_found',
	'invalid_transition',
	'purchase_not_found',
	'already_claimed',
	'refund_exceeds_payment',
	'refund_not_online',
	'refund_not_paid',
	'code_invalid',
	'binding_invalid',
	'approval_not_found',
	'approval_expired',
	'approval_closed',
	'otp_unavailable',
	'otp_invalid',
	'otp_locked',
	'adjustment_invalid',
	'adjustment_limit',
	'config_invalid',
	'location_forbidden',
	'unauthorized_scope',
	'forbidden_grant',
	'rate_limited',
	'invalid_request',
] as const

export type LoyaltyErrorCode = (typeof LOYALTY_ERROR_CODES)[number]

export const LOYALTY_ERROR_HTTP_STATUS: Readonly<
	Record<LoyaltyErrorCode, number>
> = {
	loyalty_unavailable: 503,
	loyalty_disabled: 403,
	redemption_disabled: 403,
	program_not_found: 404,
	program_inactive: 409,
	member_not_found: 404,
	member_inactive: 409,
	reward_not_found: 404,
	reward_unavailable: 409,
	reward_not_applicable: 422,
	zero_value: 422,
	insufficient_points: 409,
	currency_mismatch: 422,
	stacking_not_allowed: 409,
	one_reward_per_order: 409,
	cart_changed: 409,
	stale_version: 409,
	idempotency_conflict: 409,
	redemption_not_found: 404,
	invalid_transition: 409,
	purchase_not_found: 404,
	already_claimed: 409,
	refund_exceeds_payment: 422,
	refund_not_online: 409,
	refund_not_paid: 409,
	code_invalid: 404,
	binding_invalid: 404,
	approval_not_found: 404,
	approval_expired: 410,
	approval_closed: 409,
	otp_unavailable: 409,
	otp_invalid: 422,
	otp_locked: 429,
	adjustment_invalid: 400,
	adjustment_limit: 429,
	config_invalid: 400,
	location_forbidden: 403,
	unauthorized_scope: 403,
	forbidden_grant: 403,
	rate_limited: 429,
	invalid_request: 400,
}

export class LoyaltyDomainError extends Error {
	readonly code: LoyaltyErrorCode
	readonly status: number
	readonly details?: Record<string, unknown>

	constructor(
		code: LoyaltyErrorCode,
		details?: Record<string, unknown>,
		status?: number,
	) {
		super(code)
		this.name = 'LoyaltyDomainError'
		this.code = code
		this.status = status ?? LOYALTY_ERROR_HTTP_STATUS[code]
		this.details = details
	}
}

export function isLoyaltyErrorCode(value: unknown): value is LoyaltyErrorCode {
	return (
		typeof value === 'string' &&
		(LOYALTY_ERROR_CODES as readonly string[]).includes(value)
	)
}
