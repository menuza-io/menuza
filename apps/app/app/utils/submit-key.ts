/**
 * Deterministic idempotency keys for refund forms. A random key in a `useRef`
 * dies when the dialog unmounts, so a response lost mid-request (or a dialog
 * closed and reopened) made the next submit record the refund again. Deriving
 * the key from what is refunded instead replays the first attempt.
 */

/** cyrb53 (public domain): a stable string hash in two 32-bit halves. */
function hashText(text: string): string {
	let h1 = 0xdeadbeef
	let h2 = 0x41c6ce57
	for (let index = 0; index < text.length; index++) {
		const char = text.charCodeAt(index)
		h1 = Math.imul(h1 ^ char, 2654435761)
		h2 = Math.imul(h2 ^ char, 1597334677)
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909)
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909)
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)
}

/**
 * Key for recording one refund: `parts` must name the sale, what already came
 * back, and the form content. The same refund then always gets the same key,
 * even across a remount, so a retry replays. Once the refund lands, the
 * caller's refunded total changes, and so does the key.
 */
export function refundSubmitKey(prefix: string, parts: unknown): string {
	return `${prefix}-${hashText(JSON.stringify(parts))}`
}
