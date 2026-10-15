import { safeRedirect } from 'remix-utils/safe-redirect'

/**
 * Turn a React Router single-fetch data path back into the page path.
 *
 * Client-side navigations load data from `/<path>.data` (and `/_.data` for an
 * index route). React Router only normalizes that for route matching: loaders
 * still see the raw `request.url`. A `redirectTo` built from it would send the
 * user to the raw data response after signing in. This mirrors React Router's
 * own `getNormalizedPath`: strip the `.data` suffix and the `_routes` param.
 */
export function toDocumentPath(path: string): string {
	const url = new URL(path, 'http://normalize.local')
	// URL parsing resolves dot segments and decodes `%2e`, so `/.//evil.com`
	// comes out as `//evil.com`, which a browser reads as another host.
	let pathname = url.pathname.replace(/^\/+/, '/')
	if (pathname.endsWith('/_.data')) {
		pathname = pathname.slice(0, -'_.data'.length)
	} else if (pathname.endsWith('.data')) {
		pathname = pathname.slice(0, -'.data'.length)
	}
	if (pathname.length > 1 && pathname.endsWith('/')) {
		pathname = pathname.slice(0, -1)
	}
	url.searchParams.delete('_routes')
	const search = url.searchParams.toString()
	return `${pathname || '/'}${search ? `?${search}` : ''}`
}

/** The page path (with search) a request is for, even for data requests. */
export function getRequestDocumentPath(request: Request): string {
	const url = new URL(request.url)
	return toDocumentPath(`${url.pathname}${url.search}`)
}

/** `safeRedirect` that also never lands on a single-fetch data path. */
export function safeDocumentRedirect(
	to: FormDataEntryValue | string | null | undefined,
	defaultRedirect = '/',
): string {
	const target = safeRedirect(to, defaultRedirect)
	if (target === defaultRedirect) return target
	// Check again after normalizing: it can turn a safe-looking path unsafe.
	return safeRedirect(toDocumentPath(target), defaultRedirect)
}
