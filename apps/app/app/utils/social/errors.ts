/**
 * `unauthorized`: Meta refused the token or a permission is missing; the
 * account must be connected again. `rejected`: Meta refused this post.
 * `rate_limited` and `unavailable` are passing. The message is either Meta's
 * own text or one of our codes (`SOCIAL_TARGET_ERROR_LABELS`), stored on the
 * target and translated when shown.
 */
export type SocialErrorCode =
	| 'unauthorized'
	| 'rejected'
	| 'rate_limited'
	| 'unavailable'

export class SocialError extends Error {
	constructor(
		public code: SocialErrorCode,
		message: string,
		public status?: number,
	) {
		super(message)
		this.name = 'SocialError'
	}
}
