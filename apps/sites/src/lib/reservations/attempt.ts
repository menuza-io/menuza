import { randomUuid } from './uuid.ts'

/**
 * One Idempotency-Key per submission attempt. A retry of the same request
 * (network drop, double tap, expired human check) reuses the key so the server
 * answers with the first result; a changed request needs a fresh key or the
 * server rejects it as a conflict.
 */
export function createAttemptKeys(newKey: () => string = randomUuid) {
	let current: { signature: string; key: string } | null = null
	return {
		keyFor(signature: string): string {
			if (current?.signature !== signature) {
				current = { signature, key: newKey() }
			}
			return current.key
		},
		reset() {
			current = null
		},
	}
}
