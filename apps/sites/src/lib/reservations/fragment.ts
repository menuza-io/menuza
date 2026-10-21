/**
 * Capability tokens (manage, voice hold) arrive in the URL fragment so they
 * never reach a server log, are copied into `sessionStorage` for reloads, and
 * are then removed from the address bar and history entry.
 */

export const MANAGE_TOKEN_STORAGE_KEY = 'rsv_manage_token'

type LocationLike = Pick<Location, 'hash' | 'pathname' | 'search'>
type HistoryLike = Pick<History, 'replaceState' | 'state'>
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function parseFragmentParam(hash: string, name: string): string | null {
	const params = new URLSearchParams(hash.replace(/^#/, ''))
	const value = params.get(name)?.trim()
	return value ? value : null
}

function safeStorage(storage?: StorageLike): StorageLike | null {
	if (storage) return storage
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage
	} catch {
		return null
	}
}

export function readStoredManageToken(storage?: StorageLike): string | null {
	try {
		return safeStorage(storage)?.getItem(MANAGE_TOKEN_STORAGE_KEY) ?? null
	} catch {
		return null
	}
}

export function storeManageToken(token: string, storage?: StorageLike) {
	try {
		safeStorage(storage)?.setItem(MANAGE_TOKEN_STORAGE_KEY, token)
	} catch {
		// Private mode: the token still works for this page load.
	}
}

export function clearStoredManageToken(storage?: StorageLike) {
	try {
		safeStorage(storage)?.removeItem(MANAGE_TOKEN_STORAGE_KEY)
	} catch {
		// Nothing to clear.
	}
}

/** Removes the fragment while keeping the path and query. */
export function stripFragment(location: LocationLike, history: HistoryLike) {
	if (!location.hash) return
	history.replaceState(
		history.state,
		'',
		`${location.pathname}${location.search}`,
	)
}

/**
 * Reads `#t=<token>` (falling back to the token kept for this tab), remembers
 * it for reloads and strips the fragment.
 */
export function takeManageToken(
	location: LocationLike,
	history: HistoryLike,
	storage?: StorageLike,
): string | null {
	const fromFragment = parseFragmentParam(location.hash, 't')
	if (fromFragment) {
		storeManageToken(fromFragment, storage)
		stripFragment(location, history)
		return fromFragment
	}
	return readStoredManageToken(storage)
}

export const WAITLIST_TOKEN_STORAGE_KEY = 'rsv_waitlist_token'

export function readStoredWaitlistToken(storage?: StorageLike): string | null {
	try {
		return safeStorage(storage)?.getItem(WAITLIST_TOKEN_STORAGE_KEY) ?? null
	} catch {
		return null
	}
}

export function storeWaitlistToken(token: string, storage?: StorageLike) {
	try {
		safeStorage(storage)?.setItem(WAITLIST_TOKEN_STORAGE_KEY, token)
	} catch {
		// Private mode: the status link still works from the address bar.
	}
}

export function clearStoredWaitlistToken(storage?: StorageLike) {
	try {
		safeStorage(storage)?.removeItem(WAITLIST_TOKEN_STORAGE_KEY)
	} catch {
		// Nothing to clear.
	}
}

/**
 * Reads `#t=<token>` (falling back to the token kept for this tab). Unlike a
 * manage link, the fragment stays in the address bar so the guest can bookmark
 * the status page; it never reaches a server.
 */
export function takeWaitlistToken(
	location: Pick<Location, 'hash'>,
	storage?: StorageLike,
): string | null {
	const fromFragment = parseFragmentParam(location.hash, 't')
	if (fromFragment) {
		storeWaitlistToken(fromFragment, storage)
		return fromFragment
	}
	return readStoredWaitlistToken(storage)
}

/** Puts the status token in the fragment and remembers it for reloads. */
export function publishWaitlistToken(
	token: string,
	location: LocationLike,
	history: HistoryLike,
	storage?: StorageLike,
) {
	storeWaitlistToken(token, storage)
	history.replaceState(
		history.state,
		'',
		`${location.pathname}${location.search}#t=${encodeURIComponent(token)}`,
	)
}

/** Drops the status token from the address bar and this tab's storage. */
export function forgetWaitlistToken(
	location: LocationLike,
	history: HistoryLike,
	storage?: StorageLike,
) {
	clearStoredWaitlistToken(storage)
	stripFragment(location, history)
}
