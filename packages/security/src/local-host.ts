/**
 * Loopback addresses and the special-use local names (`*.localhost`, and
 * `*.test` for the HTTPS dev proxy). Emulators, mock switches and placeholder
 * secret checks use this to tell a local deployment from a public one, so it
 * compares the parsed hostname exactly: `localhost.example.com` is public.
 * No dependencies, so any package can import `@repo/security/local-host`.
 */
export function isLocalHostname(hostname: string): boolean {
	const host = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
	return (
		host === 'localhost' ||
		host === '127.0.0.1' ||
		host === '::1' ||
		host.endsWith('.localhost') ||
		host.endsWith('.test')
	)
}

/**
 * `value` is a URL on a local host (see `isLocalHostname`). A missing or
 * unparseable value is not local: an unset variable never counts as local.
 */
export function isLocalUrl(value: string | null | undefined): boolean {
	if (!value) return false
	try {
		return isLocalHostname(new URL(value).hostname)
	} catch {
		return false
	}
}
