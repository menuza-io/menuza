/**
 * Errors from the platform APIs. `status` 0 means the request never got an
 * HTTP answer (offline, timeout) or was refused before it was sent; `code` is
 * a machine-readable reason when the server or the app supplies one.
 */
export class ApiError extends Error {
	readonly status: number
	readonly code: string | null

	constructor(status: number, message: string, code: string | null = null) {
		super(message)
		this.name = 'ApiError'
		this.status = status
		this.code = code
	}

	get isUnauthorized(): boolean {
		return this.status === 401
	}

	get isForbidden(): boolean {
		return this.status === 403
	}

	get isNotFound(): boolean {
		return this.status === 404
	}

	get isRateLimited(): boolean {
		return this.status === 429
	}

	get isTransportFailure(): boolean {
		return this.status === 0 && this.code === 'network'
	}

	/**
	 * The customer-session contract with tenant-api: only a 401, or a 403 that
	 * says the organization is gone, ends the session. Every other answer
	 * (including a bare 403 during a control-plane outage) is transient.
	 */
	get endsSession(): boolean {
		return (
			this.status === 401 ||
			(this.status === 403 && this.code === ORGANIZATION_INACTIVE)
		)
	}

	/**
	 * tenant-api answers `{ error, error_description?, code? }`; the App answers
	 * `{ error }` or a plain-text 404. Prefers the most specific message, and
	 * an explicit `code` over an `error` that looks like one.
	 */
	static from(status: number, body: string): ApiError {
		const object = parseObject(body)
		if (object) {
			const description = nonEmptyString(object.error_description)
			const error = nonEmptyString(object.error)
			const code = machineCode(object.code) ?? machineCode(error)
			if (description) return new ApiError(status, description, code)
			if (error) return new ApiError(status, error, code)
			const message = nonEmptyString(object.message)
			if (message) return new ApiError(status, message, code)
		}
		const text = body.trim()
		if (text && text.length < 200) return new ApiError(status, text)
		return new ApiError(status, `Request failed (${status})`)
	}
}

const ERROR_CODE = /^[a-z][a-z0-9_]*$/

export const ORGANIZATION_INACTIVE = 'organization_inactive'

function machineCode(value: unknown): string | null {
	return typeof value === 'string' && ERROR_CODE.test(value) ? value : null
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function parseObject(body: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(body)
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

export function isApiError(error: unknown): error is ApiError {
	return error instanceof ApiError
}

export function unauthorizedError(): ApiError {
	return new ApiError(401, 'Please sign in again.', 'unauthorized')
}

export function notBoundToTenantError(): ApiError {
	return new ApiError(
		0,
		'This app is not connected to a site yet.',
		'not_bound',
	)
}

export function regionUnavailableError(): ApiError {
	return new ApiError(
		0,
		'This app cannot reach the region that holds this site’s customer data.',
		'region_unavailable',
	)
}

export function transportError(error: unknown): ApiError {
	if (error instanceof ApiError) return error
	const name = error instanceof Error ? error.name : ''
	if (name === 'AbortError' || name === 'TimeoutError') {
		return new ApiError(0, 'The request timed out.', 'network')
	}
	const message = error instanceof Error && error.message ? error.message : ''
	return new ApiError(
		0,
		message || 'The network connection was lost.',
		'network',
	)
}
