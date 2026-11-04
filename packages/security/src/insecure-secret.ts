import { isLocalUrl } from './local-host.js'

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
	'super-duper-s3cret',
	'super-duper-s3cr3t',
	'test-session-secret',
]

export function isInsecureSecret(value: string) {
	const lower = value.toLowerCase()
	return INSECURE_SECRET_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * Whether this process is a real (non-local) production deploy: a production
 * build whose `BASE_URL` is not localhost. A production build that E2E or
 * `npm run build` + preview runs on localhost is not.
 */
export function isProductionLike() {
	if (process.env.NODE_ENV !== 'production') return false
	// `npm run build` + preview and E2E run a production build on localhost.
	// A missing or unparseable BASE_URL is not provably local, so enforce.
	return !isLocalUrl(process.env.BASE_URL)
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
