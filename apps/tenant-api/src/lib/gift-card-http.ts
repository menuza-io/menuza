import { GiftCardDomainError } from '@repo/common/gift-cards'
import { type Context } from 'hono'
import { HttpError, NO_STORE } from './http.ts'
import { isGiftCardsKillSwitchOn } from './gift-card-switches.ts'
import {
	hashGiftCardRequest,
	type GiftCardIdempotency,
} from './gift-card-write.ts'
import { readIdempotencyKey } from './reservations-public-auth.ts'

/**
 * Shared HTTP plumbing for the gift-card route surfaces (`/gift-cards`,
 * `/operator/gift-cards`, `/pos/gift-cards`): one error mapping, one
 * idempotency-key rule, one kill-switch answer. Every response is
 * `private, no-store` and carries a stable machine-readable `code`; nothing
 * here logs or echoes codes, names or emails.
 */

export { NO_STORE }

export function giftCardDeny(
	status: number,
	code: string,
	details: Record<string, unknown> = {},
): Response {
	return Response.json(
		{ error: code, code, ...details },
		{ status, headers: NO_STORE },
	)
}

export function giftCardErrorResponse(error: unknown): Response {
	if (error instanceof Response) return error
	if (error instanceof GiftCardDomainError) {
		return giftCardDeny(error.status, error.code, error.details)
	}
	if (error instanceof HttpError) return error.toResponse()
	throw error
}

/**
 * The `Idempotency-Key` header of a mutation. Missing or malformed is a 400,
 * never a silent retry: the key is what makes a repeated call safe. `scope`
 * (route and subject) stops a key being replayed across routes or cards.
 */
export function giftCardIdempotency(
	c: Context,
	scope: string,
	payload: unknown,
): { idempotency: GiftCardIdempotency } | { error: Response } {
	const key = readIdempotencyKey(c)
	if (!key) {
		return {
			error: giftCardErrorResponse(
				new GiftCardDomainError('invalid_request', {
					message: 'Idempotency-Key header required',
				}),
			),
		}
	}
	return {
		idempotency: { scope, key, requestHash: hashGiftCardRequest(payload) },
	}
}

/** The node's kill switch, checked live: new sales and redemptions answer 503. */
export function giftCardKillSwitchResponse(): Response | null {
	if (!isGiftCardsKillSwitchOn()) return null
	return giftCardErrorResponse(new GiftCardDomainError('gift_cards_unavailable'))
}
