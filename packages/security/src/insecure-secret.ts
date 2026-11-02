/**
 * Placeholder secrets that ship in `.env.schema` defaults and examples. A
 * production deploy that forgot to set one would otherwise run on a value
 * anyone can read in the repository.
 */
const INSECURE_SECRET_MARKERS = [
	'your-jwt-secret',
	'do-not-use-in-prod',
	'change-me',
	'changeme',
	'super-duper-secret',
	'super-duper-s3cr3t',
	'test-session-secret',
]

export function isInsecureSecret(value: string) {
	const lower = value.toLowerCase()
	return INSECURE_SECRET_MARKERS.some((marker) => lower.includes(marker))
}

function isLocalHostname(hostname: string) {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.test')
	)
}

function isProductionLike() {
	if (process.env.NODE_ENV !== 'production') return false
	// `npm run build` + preview and E2E run a production build on localhost.
	// Compare the parsed hostname exactly: a substring test would treat
	// `https://localhost.evil.com` as local.
	try {
		return !isLocalHostname(new URL(process.env.BASE_URL ?? '').hostname)
	} catch {
		// Missing or unparseable BASE_URL: not provably local, so enforce.
		return true
	}
}

/**
 * Throws when `value` is a documented placeholder and the process is running
 * as a real (non-local) production deploy. Returns `value` for inline use.
 */
export function assertSecretNotPlaceholder(name: string, value: string) {
	if (isProductionLike() && isInsecureSecret(value)) {
		throw new Error(
			`${name} is set to a placeholder value. Generate a unique secret before running in production.`,
		)
	}
	return value
}
