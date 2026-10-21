import { generateIdempotencyKey } from './book-api.ts'
import { ReservationsApiError } from './reservations-client.ts'

/**
 * Idempotency key for a form that can be resubmitted. The key is kept while the
 * submitted content is unchanged, so a retry after a network error or a 5xx (the
 * server may have committed the first attempt) replays instead of booking twice.
 */
export type SubmitKeyRef = {
	current: { key: string; fingerprint: string | null }
}

export function newSubmitKey(prefix: string): SubmitKeyRef['current'] {
	return { key: generateIdempotencyKey(prefix), fingerprint: null }
}

/** The key for this submit: a new one when the content changed since the last. */
export function keyForSubmit(
	ref: SubmitKeyRef,
	prefix: string,
	payload: unknown,
): string {
	const fingerprint = JSON.stringify(payload)
	if (
		ref.current.fingerprint !== null &&
		ref.current.fingerprint !== fingerprint
	) {
		ref.current = newSubmitKey(prefix)
	}
	ref.current.fingerprint = fingerprint
	return ref.current.key
}

/**
 * A 4xx answer is a definite rejection (nothing was written), so the next
 * attempt may use a fresh key. A timeout (408), a 5xx or a network error leaves
 * the outcome unknown and keeps the key.
 */
export function isDefiniteRejection(error: unknown): boolean {
	return (
		error instanceof ReservationsApiError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 408
	)
}

/** Call after a failed submit. */
export function afterFailedSubmit(
	ref: SubmitKeyRef,
	prefix: string,
	error: unknown,
) {
	if (isDefiniteRejection(error)) ref.current = newSubmitKey(prefix)
}
