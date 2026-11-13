import { useCallback, useEffect, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'

/**
 * True when a JWT's `exp` has passed or is within `skewMs`. A token that
 * cannot be read counts as not expired, so a refusal of it is shown as an
 * error instead of asking the loader for new tokens in a loop.
 */
export function tokenExpired(
	token: string | undefined,
	now = Date.now(),
	skewMs = 60_000,
): boolean {
	const payload = token?.split('.')[1]
	if (!payload) return false
	try {
		const claims = JSON.parse(
			atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
		) as { exp?: unknown }
		return typeof claims.exp === 'number' && claims.exp * 1000 - skewMs <= now
	} catch {
		return false
	}
}

/**
 * A browser token that comes from the route loader. Every revalidation signs
 * a new one (new `exp`), so pages read it through `token()` instead of
 * listing it as an effect dependency: a revalidation then neither blanks the
 * page nor fetches again.
 *
 * When tenant-api answers 401, call `refreshIfExpired(token)`. If that token
 * has expired (a page left open past its lifetime) it revalidates the loader
 * once and returns true; `reloadKey` changes when the new token arrives, so an
 * effect that lists it fetches again. A refusal of a token that has not
 * expired returns false: show the error, do not loop.
 */
export function useLoaderToken(jwt: string | undefined) {
	const revalidator = useRevalidator()
	// Held in a ref so `refreshIfExpired` stays stable for effect dependencies.
	const revalidate = useRef(revalidator.revalidate)
	const latest = useRef(jwt)
	const awaitingToken = useRef(false)
	const [reloadKey, setReloadKey] = useState(0)

	useEffect(() => {
		revalidate.current = revalidator.revalidate
	})

	useEffect(() => {
		latest.current = jwt
		if (awaitingToken.current) {
			awaitingToken.current = false
			setReloadKey((key) => key + 1)
		}
	}, [jwt])

	const token = useCallback(() => latest.current, [])

	const refreshIfExpired = useCallback((failed: string | undefined) => {
		if (!tokenExpired(failed)) return false
		if (!awaitingToken.current) {
			awaitingToken.current = true
			void revalidate.current()
		}
		return true
	}, [])

	return { token, refreshIfExpired, reloadKey }
}
