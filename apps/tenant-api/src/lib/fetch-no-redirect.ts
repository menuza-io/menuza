/**
 * `fetch` that never follows a redirect and refuses to hand one back.
 *
 * `redirect: 'error'` is the obvious way to say that, but Cloudflare Workers
 * does not implement it: `fetch` throws `TypeError: Invalid redirect value`
 * before it sends anything (see docs/security.md). On Workers the only
 * options are `follow` and `manual`, so ask for `manual` and treat a 3xx as a
 * failure here. Callers keep the old "a redirect throws" contract on Node and
 * Workers alike, so a caller that forgets to check `response.ok` cannot take a
 * redirect for a result or read its `Location`.
 *
 * This is a copy of `packages/security/src/fetch-no-redirect.ts`: this node does
 * not depend on `@repo/security`. `fetch-no-redirect.test.ts` runs the same
 * cases against both, so keep them in step.
 */
export class RedirectBlockedError extends Error {
	readonly status: number

	constructor(status: number) {
		super(`Redirect blocked (${status})`)
		this.name = 'RedirectBlockedError'
		this.status = status
	}
}

function isRedirect(status: number) {
	// 304 is a 3xx but not a redirect.
	return status >= 300 && status < 400 && status !== 304
}

export async function fetchNoRedirect(
	input: string | URL | Request,
	init: RequestInit = {},
): Promise<Response> {
	const response = await fetch(input, { ...init, redirect: 'manual' })
	if (isRedirect(response.status)) {
		// An unread body can hold the connection open on Workers.
		await response.body?.cancel().catch(() => {})
		throw new RedirectBlockedError(response.status)
	}
	return response
}
