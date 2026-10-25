import { HostApiError } from './api.ts'

/**
 * Sends a write under the idempotency key of its form. One key per booking or
 * waitlist form: trying again after no answer sends the same key, so the
 * server records the guest once. A success, or a definite refusal, starts a
 * new key for the next form.
 *
 * - Success: the key is spent; the next send gets a fresh one.
 * - No answer, or an answer about the server rather than this request (a 5xx,
 *   a timeout, a rate limit, a sign-in that ended): the first send may have
 *   landed, so the key stays and the retry is the same request.
 * - The server already has this key (`idempotency_conflict`): the first one
 *   went through, so the key stays too.
 * - Any other refusal (a 4xx about the request, or an error that is not the
 *   server's): the request is dead, and the next send is a new one.
 */
export async function keyed(
	ref: { current: string },
	send: (key: string) => Promise<unknown>,
	newKey: () => string = () => crypto.randomUUID(),
): Promise<unknown> {
	try {
		const result = await send(ref.current)
		ref.current = newKey()
		return result
	} catch (error) {
		const keep =
			error instanceof HostApiError && (error.retryable || error.alreadyDone)
		if (!keep) ref.current = newKey()
		throw error
	}
}
