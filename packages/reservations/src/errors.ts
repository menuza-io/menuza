/**
 * Stable machine-readable reservation error codes (`architecture.md` §10.2, `VAL-FND-008`).
 * Pure domain errors carry codes and structured data — never user-facing English strings.
 */
export const RESERVATIONS_ERROR_CODES = [
	'reservations_disabled',
	'online_booking_disabled',
	'location_not_found',
	'service_closed',
	'slot_unavailable',
	'party_size_out_of_bounds',
	'large_party_request_required',
	'large_party_call_only',
	'beyond_booking_horizon',
	'below_min_notice',
	'hold_expired',
	'hold_conflict',
	'idempotency_conflict',
	'invalid_transition',
	'table_conflict',
	'combination_invalid',
	'config_invalid',
	'payment_required',
	'payment_failed',
	'cutoff_passed',
	'rate_limited',
	'turnstile_failed',
	'unauthorized_scope',
	'forbidden_grant',
] as const

export type ReservationsErrorCode = (typeof RESERVATIONS_ERROR_CODES)[number]

export const ERROR_HTTP_STATUS: Readonly<
	Record<ReservationsErrorCode, number>
> = {
	reservations_disabled: 403,
	online_booking_disabled: 403,
	location_not_found: 404,
	service_closed: 409,
	slot_unavailable: 409,
	party_size_out_of_bounds: 400,
	large_party_request_required: 409,
	large_party_call_only: 409,
	beyond_booking_horizon: 400,
	below_min_notice: 400,
	hold_expired: 410,
	hold_conflict: 409,
	idempotency_conflict: 409,
	invalid_transition: 409,
	table_conflict: 409,
	combination_invalid: 400,
	config_invalid: 400,
	payment_required: 402,
	payment_failed: 402,
	cutoff_passed: 409,
	rate_limited: 429,
	turnstile_failed: 403,
	unauthorized_scope: 403,
	forbidden_grant: 403,
}

export class ReservationsDomainError extends Error {
	readonly code: ReservationsErrorCode
	readonly status: number
	readonly details?: Record<string, unknown>

	constructor(
		code: ReservationsErrorCode,
		message?: string,
		status?: number,
		details?: Record<string, unknown>,
	) {
		super(message ?? code)
		this.name = 'ReservationsDomainError'
		this.code = code
		this.status = status ?? ERROR_HTTP_STATUS[code]
		this.details = details
	}
}
