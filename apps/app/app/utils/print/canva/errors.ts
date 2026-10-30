/** Errors of the Canva client, by what the Print shop does about them. */
export type CanvaErrorCode =
	| 'unauthorized'
	/** The grant itself is gone (revoked or expired): connect again. */
	| 'invalid_grant'
	| 'not_found'
	| 'license_required'
	| 'rate_limited'
	| 'too_large'
	| 'unavailable'
	| 'failed'

export class CanvaError extends Error {
	constructor(
		readonly code: CanvaErrorCode,
		message: string,
		readonly status?: number,
	) {
		super(message)
		this.name = 'CanvaError'
	}
}
