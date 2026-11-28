import { browserLocaleHref } from '~/lib/locale'

/**
 * "Sign in to favorite this dish" (#158) and "Start a group order" (#170) send a
 * signed-out guest to the login page; once they have signed in they should land
 * back where they were, not on the home page. The path is kept in session
 * storage for one visit and is only ever a same-site path.
 */
const KEY = 'menuza_return_after_login'

export function isSafeReturnPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 500 &&
		value.startsWith('/') &&
		!value.startsWith('//') &&
		!value.includes('\\') &&
		!/[\u0000-\u001f]/.test(value)
	)
}

export function rememberReturnPath(
	path = `${window.location.pathname}${window.location.search}`,
	storage: Pick<Storage, 'setItem'> | null = safeSession(),
) {
	if (!storage || !isSafeReturnPath(path)) return
	try {
		storage.setItem(KEY, path)
	} catch {
		// Private mode: the guest lands on the home page instead.
	}
}

/** The remembered path once, else `fallback`. */
export function takeReturnPath(
	fallback = '/',
	storage: Pick<Storage, 'getItem' | 'removeItem'> | null = safeSession(),
): string {
	let value: string | null = null
	try {
		value = storage?.getItem(KEY) ?? null
		storage?.removeItem(KEY)
	} catch {
		value = null
	}
	return isSafeReturnPath(value) ? value : fallback
}

/** `takeReturnPath`, in the page's language (the stored path already has one). */
export function returnHref(fallback = '/'): string {
	const path = takeReturnPath('')
	return path || browserLocaleHref(fallback)
}

/** Sends the guest to sign in and brings them back to this page afterwards. */
export function signInAndReturn() {
	rememberReturnPath()
	window.location.assign(browserLocaleHref('/login'))
}

function safeSession(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage
	} catch {
		return null
	}
}
