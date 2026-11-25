const SECRET_KEY_PATTERN =
	/token|secret|password|authorization|cookie|api[-_]?key|private[-_]?key|signature|jwt|bearer|credential/i

const BEARER_PATTERN = /\bBearer\s+[^\s"',;)}\]]+/gi
const BASIC_PATTERN = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi
const HEADER_VALUE_PATTERN =
	/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token)\s*:\s*(?!Bearer\b|Basic\b)[^\s"',;\r\n]+/gi
const COOKIE_LINE_PATTERN =
	/(^|\r?\n)([ \t]*(?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi
const JWT_PATTERN =
	/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g
const JSON_SECRET_FIELD_PATTERN =
	/(['"])(access_token|refresh_token|id_token|client_secret|signing_secret|api_key|apikey|private_key|secret|password|token|authorization|cookie|signature|jwt|credential)\1\s*:\s*(['"])(?:\\.|[^'"\\])*\3/gi
const QUERY_OR_KV_SECRET_PATTERN =
	/(^|[?&\s,;({[])(access_token|refresh_token|id_token|client_secret|signing_secret|api_key|apikey|private_key|token|code|key|secret|password|signature|authorization)(\s*[=:]\s*)(?!Bearer\b|Basic\b)([^\s&"',;)}\]]+)/gi

const PROVIDER_SECRET_PATTERNS: RegExp[] = [
	/\bsq0(?:atp|csp|idp)-[A-Za-z0-9_-]{10,}\b/g,
	/\bEAAA[A-Za-z0-9_-]{16,}\b/g,
	/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bglpat-[A-Za-z0-9_-]{16,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
]

export const DEFAULT_RAW_RESPONSE_MAX_CHARS = 4000
const MAX_SAFE_ERROR_LENGTH = 300

/**
 * Strips Bearer tokens, JWTs, sensitive query/key-value parameters, HTTP auth
 * headers, and common provider secret formats from plain text.
 */
export function redactSecretsInText(text: string): string {
	if (!text) return text
	let result = text
		.replace(COOKIE_LINE_PATTERN, '$1$2[REDACTED]')
		.replace(BEARER_PATTERN, 'Bearer [REDACTED]')
		.replace(BASIC_PATTERN, 'Basic [REDACTED]')
		.replace(HEADER_VALUE_PATTERN, '$1: [REDACTED]')
		.replace(JWT_PATTERN, '[REDACTED]')
		.replace(JSON_SECRET_FIELD_PATTERN, '$1$2$1:$3[REDACTED]$3')
		.replace(QUERY_OR_KV_SECRET_PATTERN, '$1$2$3[REDACTED]')

	for (const pattern of PROVIDER_SECRET_PATTERNS) {
		result = result.replace(pattern, '[REDACTED]')
	}

	return result
}

function redactRecursive(value: unknown, seen: WeakSet<object>): unknown {
	if (value === null || value === undefined) return value
	if (typeof value === 'string') return redactSecretsInText(value)
	if (typeof value === 'number' || typeof value === 'boolean') return value
	if (typeof value === 'bigint') return value.toString()
	if (typeof value === 'symbol' || typeof value === 'function') return undefined
	if (value instanceof Date) return value

	if (value instanceof Error) {
		const status =
			'status' in value && typeof value.status === 'number'
				? value.status
				: undefined
		return {
			name: value.name,
			message: redactSecretsInText(value.message),
			...(status !== undefined ? { status } : {}),
		}
	}

	if (typeof value !== 'object') return value

	if (seen.has(value)) return '[Circular]'
	seen.add(value)

	if (Array.isArray(value)) {
		return value.map((item) => redactRecursive(item, seen))
	}

	const output: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value)) {
		if (entry === undefined) continue
		if (SECRET_KEY_PATTERN.test(key)) {
			output[key] = entry === null ? null : '[REDACTED]'
			continue
		}
		output[key] = redactRecursive(entry, seen)
	}
	return output
}

/**
 * Recursively redacts sensitive keys and secret-bearing string values from
 * structured data before persistence or serialization.
 */
export function redactSecrets<T>(value: T): T {
	return redactRecursive(value, new WeakSet()) as T
}

/**
 * Redacts secrets from a raw platform response and trims it for server-side
 * storage only. Never return the stored string to browser callers.
 */
export function trimRawResponse(
	value: unknown,
	maxChars = DEFAULT_RAW_RESPONSE_MAX_CHARS,
): string | null {
	if (value === undefined || value === null) return null
	const redacted = redactSecrets(value)
	const serialized =
		typeof redacted === 'string' ? redacted : JSON.stringify(redacted)
	if (serialized === undefined) return null
	if (serialized.length <= maxChars) return serialized
	if (maxChars <= 3) return serialized.slice(0, Math.max(0, maxChars))
	return `${serialized.slice(0, maxChars - 3)}...`
}

function statusFallbackMessage(status?: number): string {
	if (status === 401 || status === 403) {
		return 'Authorization expired. Reconnect and try again.'
	}
	if (status === 429) {
		return 'Rate limit reached. We will retry on the next sync.'
	}
	if (status === 409) {
		return 'The menu changed on the provider while syncing. Review the latest changes and try again.'
	}
	if (status === 503 || (typeof status === 'number' && status >= 500)) {
		return 'The provider is temporarily unavailable.'
	}
	return 'Sync failed due to an unexpected provider response.'
}

function isRawJsonDump(text: string): boolean {
	const trimmed = text.trim()
	if (
		(trimmed.startsWith('{') && trimmed.endsWith('}')) ||
		(trimmed.startsWith('[') && trimmed.endsWith(']'))
	) {
		try {
			JSON.parse(trimmed)
			return true
		} catch {
			return trimmed.length > 40
		}
	}
	return false
}

/**
 * Maps an error into a short, readable operator message while ensuring no
 * tokens, auth headers, or raw JSON payload dumps leak into logs or the UI.
 */
export function toSafeSyncErrorMessage(error: unknown): string {
	const status =
		error &&
		typeof error === 'object' &&
		'status' in error &&
		typeof (error as { status?: unknown }).status === 'number'
			? (error as { status: number }).status
			: undefined

	let raw: string
	if (error instanceof Error) {
		raw = error.message
	} else if (typeof error === 'string') {
		raw = error
	} else if (
		error &&
		typeof error === 'object' &&
		'message' in error &&
		typeof (error as { message?: unknown }).message === 'string'
	) {
		raw = (error as { message: string }).message
	} else if (error === undefined || error === null) {
		raw = ''
	} else if (typeof error === 'object') {
		return statusFallbackMessage(status)
	} else {
		raw = String(error)
	}

	const redacted = redactSecretsInText(raw).trim()
	if (!redacted) {
		return status !== undefined
			? statusFallbackMessage(status)
			: 'Unknown sync error.'
	}

	if (isRawJsonDump(redacted)) {
		return statusFallbackMessage(status)
	}

	// Strip appended raw JSON bodies like "Upstream failed: {\"error\":...}"
	const strippedJsonTail = redacted
		.replace(
			/\s*[-:–—]?\s*(\{\s*"[\s\S]{30,}\}|\[\s*(?:\{\s*"|")[\s\S]{30,}\])\s*$/,
			'',
		)
		.replace(/\s+/g, ' ')
		.trim()

	const finalText = strippedJsonTail || statusFallbackMessage(status)
	if (finalText.length <= MAX_SAFE_ERROR_LENGTH) return finalText
	return `${finalText.slice(0, MAX_SAFE_ERROR_LENGTH - 3)}...`
}
