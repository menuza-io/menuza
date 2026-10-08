/**
 * State machine for the success page's payment confirmation polling. Pure
 * functions so the behavior is unit-testable without a browser.
 *
 * The poll target is the Sites → App proxy (`POST /api/orders/payment-status`)
 * which returns `{ status, orderStatus, holdExpiresAt }`. A redirect back from
 * the hosted payment page is never trusted on its own.
 */

export const PAYMENT_POLL_INTERVAL_MS = 3_000
export const PAYMENT_POLL_TIMEOUT_MS = 120_000

export type PaymentPollOutcome =
	| { kind: 'paid' }
	| { kind: 'failed'; canRetry: boolean }
	| { kind: 'expired' }
	| { kind: 'pending' }

/** A null/unparseable hold means there is nothing to expire against. */
export function holdIsLive(
	holdExpiresAt: string | null | undefined,
	now: number,
): boolean {
	if (!holdExpiresAt) return true
	const instant = Date.parse(holdExpiresAt)
	return Number.isNaN(instant) ? true : instant > now
}

export function interpretPaymentStatus(input: {
	status?: string | null
	orderStatus?: string | null
	holdExpiresAt?: string | null
	now?: number
}): PaymentPollOutcome {
	const now = input.now ?? Date.now()
	if (input.status === 'paid') return { kind: 'paid' }
	if (input.status === 'failed') {
		return { kind: 'failed', canRetry: holdIsLive(input.holdExpiresAt, now) }
	}
	if (
		input.status === 'expired' ||
		input.orderStatus === 'expired' ||
		!holdIsLive(input.holdExpiresAt, now)
	) {
		return { kind: 'expired' }
	}
	return { kind: 'pending' }
}

export function shouldContinuePolling(
	elapsedMs: number,
	timeoutMs: number = PAYMENT_POLL_TIMEOUT_MS,
): boolean {
	return elapsedMs < timeoutMs
}
