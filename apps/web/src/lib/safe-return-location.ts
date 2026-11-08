/** Same-origin Referer path to return to after a form POST, else `/`. */
export function getSafeReturnLocation(request: Request): string {
	const fallback = '/'
	const referer = request.headers.get('Referer')
	if (!referer) return fallback

	try {
		const requestUrl = new URL(request.url)
		const refererUrl = new URL(referer)
		if (requestUrl.origin !== refererUrl.origin) return fallback
		// A path such as `//evil.example/x` would make a scheme-relative Location
		// that leaves the site; collapse leading slashes and backslashes to one.
		const path = refererUrl.pathname.replace(/^[/\\]+/, '/')
		return `${path}${refererUrl.search}${refererUrl.hash}`
	} catch {
		return fallback
	}
}
