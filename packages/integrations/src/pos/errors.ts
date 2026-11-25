/**
 * Error raised by POS adapters. `status` carries the upstream HTTP status so
 * callers can distinguish retryable (429/503) from permanent (400/404) failures,
 * and `retryAfterSeconds` carries a parsed `Retry-After` delay on 429 responses.
 */
export class PosError extends Error {
	status: number
	retryAfterSeconds?: number
	code?: string

	constructor(
		message: string,
		status = 502,
		options?: { retryAfterSeconds?: number; code?: string },
	) {
		super(message)
		this.name = 'PosError'
		this.status = status
		if (options?.code) {
			this.code = options.code
		}
		if (
			typeof options?.retryAfterSeconds === 'number' &&
			Number.isFinite(options.retryAfterSeconds) &&
			options.retryAfterSeconds > 0
		) {
			this.retryAfterSeconds = options.retryAfterSeconds
		}
	}
}

/**
 * Parses an HTTP `Retry-After` header (delta seconds or HTTP-date) into whole
 * positive seconds, or `undefined` when absent, invalid, or already elapsed.
 */
export function parseRetryAfterHeader(
	headerValue: string | null | undefined,
	nowMs = Date.now(),
): number | undefined {
	if (!headerValue) return undefined
	const trimmed = headerValue.trim()
	if (!trimmed) return undefined

	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		const seconds = Number(trimmed)
		return Number.isFinite(seconds) && seconds > 0
			? Math.ceil(seconds)
			: undefined
	}

	const targetMs = Date.parse(trimmed)
	if (Number.isNaN(targetMs)) return undefined
	const diffSeconds = Math.ceil((targetMs - nowMs) / 1000)
	return diffSeconds > 0 ? diffSeconds : undefined
}
