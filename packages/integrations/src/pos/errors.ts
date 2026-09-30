/**
 * Error raised by POS adapters. `status` carries the upstream HTTP status so
 * callers can distinguish retryable (429/503) from permanent (400/404) failures.
 */
export class PosError extends Error {
	status: number

	constructor(message: string, status = 502) {
		super(message)
		this.name = 'PosError'
		this.status = status
	}
}
