import { LoyaltyDomainError } from '@repo/loyalty'
import { type Context } from 'hono'
import { HttpError, NO_STORE } from './http.ts'
import { hashLoyaltyRequest, type LoyaltyIdempotency } from './loyalty-write.ts'
import { isLoyaltyKillSwitchOn } from './loyalty-switches.ts'
import { readIdempotencyKey } from './reservations-public-auth.ts'

/**
 * Shared HTTP plumbing for the three loyalty route surfaces
 * (`/loyalty`, `/operator/loyalty`, `/pos/loyalty`): one error mapping, one
 * idempotency-key rule, one kill-switch answer. Every response is
 * `private, no-store` and carries a stable machine-readable `code`; nothing
 * here logs or echoes customer data.
 */

export { NO_STORE }

export function loyaltyErrorResponse(error: unknown): Response {
	if (error instanceof Response) return error
	if (error instanceof LoyaltyDomainError) {
		return Response.json(
			{ error: error.code, code: error.code, ...error.details },
			{ status: error.status, headers: NO_STORE },
		)
	}
	if (error instanceof HttpError) return error.toResponse()
	throw error
}

/**
 * Reads the `Idempotency-Key` header for a mutation. Missing or malformed is
 * a 400, never a silent retry: the key is what makes a repeated call safe.
 * `scope` (per route and subject) stops a key being replayed across routes
 * or members.
 */
export function loyaltyIdempotency(
	c: Context,
	scope: string,
	payload: unknown,
): { idempotency: LoyaltyIdempotency } | { error: Response } {
	const key = readIdempotencyKey(c)
	if (!key) {
		return {
			error: loyaltyErrorResponse(
				new LoyaltyDomainError('invalid_request', {
					message: 'Idempotency-Key header required',
				}),
			),
		}
	}
	return {
		idempotency: { scope, key, requestHash: hashLoyaltyRequest(payload) },
	}
}

/**
 * The node's kill switch, checked live (never from a cached context or a
 * token claim). New loyalty operations answer 503 `loyalty_unavailable`;
 * reconciliation, refunds, review decisions and the tick never consult it.
 */
export function loyaltyKillSwitchResponse(): Response | null {
	if (!isLoyaltyKillSwitchOn()) return null
	return loyaltyErrorResponse(new LoyaltyDomainError('loyalty_unavailable'))
}
