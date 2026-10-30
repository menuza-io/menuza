import { browserLocaleHref } from '~/lib/locale'

const ACCESS_TOKEN_KEY = 'tenant_access_token'
const REFRESH_TOKEN_KEY = 'tenant_refresh_token'

type OrgBinding = {
	slug?: string
	host?: string
}

function readStorage(key: string): string | null {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

function writeStorage(key: string, value: string | null) {
	try {
		if (value) localStorage.setItem(key, value)
		else localStorage.removeItem(key)
	} catch {
		// Private mode / disabled storage
	}
}

export function getAccessToken(): string | null {
	return readStorage(ACCESS_TOKEN_KEY)
}

export function getRefreshToken(): string | null {
	return readStorage(REFRESH_TOKEN_KEY)
}

export function setSessionTokens(tokens: {
	accessToken?: string
	refreshToken?: string
}) {
	if (tokens.accessToken) writeStorage(ACCESS_TOKEN_KEY, tokens.accessToken)
	if (tokens.refreshToken) writeStorage(REFRESH_TOKEN_KEY, tokens.refreshToken)
	if (tokens.accessToken) {
		document.documentElement.dataset.customerSession = '1'
	}
}

export function clearSessionTokens() {
	writeStorage(ACCESS_TOKEN_KEY, null)
	writeStorage(REFRESH_TOKEN_KEY, null)
	delete document.documentElement.dataset.customerSession
}

/**
 * The regional tenant-api origin the page was rendered with. A page without
 * one has no region to call: outside local development the call fails here
 * instead of sending the customer's token to another address.
 */
export function getBrowserTenantApiUrl(): string {
	const fromDom = document.documentElement.dataset.tenantApiUrl
	if (fromDom) return fromDom.replace(/\/$/, '')
	if (import.meta.env.DEV) return 'http://localhost:3007'
	throw new Error('region_unavailable')
}

export function getOrgBinding(): OrgBinding {
	const slug = document.documentElement.dataset.orgSlug
	const host = document.documentElement.dataset.customHost
	const binding: OrgBinding = {}
	if (host) binding.host = host
	else if (slug) binding.slug = slug
	return binding
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const part = token.split('.')[1]
		if (!part) return null
		const padded = part.replace(/-/g, '+').replace(/_/g, '/')
		const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
		return JSON.parse(json) as Record<string, unknown>
	} catch {
		return null
	}
}

export function getAccessTokenClaims(): {
	customerId?: string
	name?: string
	orgId?: string
} | null {
	const token = getAccessToken()
	if (!token) return null
	const payload = decodeJwtPayload(token)
	if (!payload) return null
	return {
		customerId:
			typeof payload.customerId === 'string'
				? payload.customerId
				: typeof payload.sub === 'string'
					? payload.sub
					: undefined,
		name: typeof payload.name === 'string' ? payload.name : undefined,
		orgId: typeof payload.orgId === 'string' ? payload.orgId : undefined,
	}
}

export function getCustomerIdFromAccessToken(): string | undefined {
	return getAccessTokenClaims()?.customerId
}

/** `transient`: the session is kept and may still be valid. */
type RefreshOutcome = 'refreshed' | 'refused' | 'transient'

// Refresh tokens are single-use: two tabs (or two parallel requests) that
// refresh at once would present the same token, trip the server's reuse
// detection, and sign the customer out everywhere. Share one in-flight call.
let inflightRefresh: Promise<RefreshOutcome> | null = null

// Across tabs the same rule needs a lock: the Web Locks API serializes refreshes
// so a second tab re-reads the already-rotated token from localStorage instead
// of replaying the old one. Browsers without it fall back to per-tab sharing.
function refreshSession(): Promise<RefreshOutcome> {
	if (inflightRefresh) return inflightRefresh
	const run: Promise<RefreshOutcome> = (async () => {
		if (typeof navigator !== 'undefined' && navigator.locks) {
			// `await` flattens the lock API's nested promise type.
			return await navigator.locks.request('tenant-session-refresh', () =>
				doRefreshSession(),
			)
		}
		return doRefreshSession()
	})()
	const tracked: Promise<RefreshOutcome> = run.finally(() => {
		inflightRefresh = null
	})
	inflightRefresh = tracked
	return tracked
}

async function doRefreshSession(): Promise<RefreshOutcome> {
	const refreshToken = getRefreshToken()
	const orgId = getAccessTokenClaims()?.orgId
	if (!refreshToken || !orgId) {
		clearSessionTokens()
		return 'refused'
	}

	try {
		const { ok, status, data } = await tenantJson('/auth/refresh', {
			refreshToken,
			orgId,
		})
		if (ok && typeof data.accessToken === 'string') {
			setSessionTokens({
				accessToken: data.accessToken,
				refreshToken:
					typeof data.refreshToken === 'string' ? data.refreshToken : undefined,
			})
			return 'refreshed'
		}
		// Only a definitive refusal burns the session: an invalid or reused
		// token (401), or an organization the region no longer serves. Any
		// other answer (400, another 403, 429, 5xx) or a lost connection keeps
		// the tokens so the next request tries again.
		if (status === 401 || isOrganizationInactive(status, data)) {
			clearSessionTokens()
			return 'refused'
		}
		return 'transient'
	} catch {
		return 'transient'
	}
}

function isOrganizationInactive(status: number, body: unknown): boolean {
	return (
		status === 403 &&
		Boolean(body) &&
		typeof body === 'object' &&
		(body as Record<string, unknown>).code === 'organization_inactive'
	)
}

/**
 * What the customer's session is after a `tenantFetch`:
 * - `ok`: the session stands (or was not needed); `response` is the route's
 *   own answer, which may still be an error for the caller to show.
 * - `signed_out`: the region refused the session for good (or there was
 *   none); the tokens are gone, except a half session the login page forgets.
 * - `transient`: the session could not be checked for now (refresh failed
 *   with a 5xx, 429 or lost connection, or the region answered
 *   `temporarily_unavailable`). The tokens are kept; treat it like a network
 *   error and never as a sign-out.
 */
export type TenantSession = 'ok' | 'signed_out' | 'transient'

export type TenantFetchResult = { session: TenantSession; response: Response }

/** A `tenantFetchResponse` call whose session could not be checked for now. */
export class TenantSessionUnavailableError extends Error {
	constructor() {
		super('session_unavailable')
		this.name = 'TenantSessionUnavailableError'
	}
}

export async function tenantJson(
	path: string,
	body: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
	const res = await fetch(`${getBrowserTenantApiUrl()}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
	return { ok: res.ok, status: res.status, data }
}

export function tenantErrorMessage(
	data: Record<string, unknown>,
	fallback: string,
) {
	if (typeof data.error_description === 'string') return data.error_description
	if (typeof data.error === 'string') return data.error
	return fallback
}

/** Sends the customer to sign in again, in the page's language. */
export function redirectToLogin() {
	window.location.replace(browserLocaleHref('/login'))
}

export function redirectHomeIfSignedIn() {
	if (getAccessToken()) {
		window.location.replace(browserLocaleHref('/'))
	}
}

/**
 * Calls the regional tenant-api as the signed-in customer, refreshing an
 * expired access token once. Rejects like `fetch` when the region cannot be
 * reached at all. `isNotSessionRefusal` lets a caller whose request carries
 * its own credentials (a table or tab code) recognize a 401 that is about
 * those, so it neither refreshes nor ends the customer's session.
 */
export async function tenantFetch(
	path: string,
	init: RequestInit = {},
	options: { isNotSessionRefusal?: (body: unknown) => boolean } = {},
): Promise<TenantFetchResult> {
	const headers = new Headers(init.headers)
	const access = getAccessToken()
	if (access) headers.set('Authorization', `Bearer ${access}`)
	if (init.body && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json')
	}

	const request = () =>
		fetch(`${getBrowserTenantApiUrl()}${path}`, { ...init, headers })

	let res = await request()
	if (res.status === 401 && options.isNotSessionRefusal) {
		// A 401 about something other than the customer's token (a capability
		// the caller sent) says nothing about the session: keep it as it is.
		const body: unknown = await res
			.clone()
			.json()
			.catch(() => null)
		if (options.isNotSessionRefusal(body)) {
			return { session: 'ok', response: res }
		}
	}
	if (res.status === 401) {
		if (!getRefreshToken()) return { session: 'signed_out', response: res }
		const outcome = await refreshSession()
		if (outcome === 'refused') return { session: 'signed_out', response: res }
		if (outcome === 'transient') return { session: 'transient', response: res }
		const nextAccess = getAccessToken()
		if (nextAccess) headers.set('Authorization', `Bearer ${nextAccess}`)
		res = await request()
		if (res.status === 401) {
			// A token the region issued a moment ago is refused: refreshing
			// again would loop, so the session ends here.
			clearSessionTokens()
			return { session: 'signed_out', response: res }
		}
	}
	if (res.status === 403 || res.status === 503) {
		const body: unknown = await res
			.clone()
			.json()
			.catch(() => null)
		if (isOrganizationInactive(res.status, body)) {
			clearSessionTokens()
			return { session: 'signed_out', response: res }
		}
		if (
			res.status === 503 &&
			body &&
			typeof body === 'object' &&
			(body as Record<string, unknown>).code === 'temporarily_unavailable'
		) {
			return { session: 'transient', response: res }
		}
	}
	return { session: 'ok', response: res }
}

/**
 * `tenantFetch` for code that works with a plain `Response` (injected fetch
 * seams). A session that could not be checked rejects with
 * `TenantSessionUnavailableError`, so it fails like the network instead of
 * reading as a 401 sign-out.
 */
export async function tenantFetchResponse(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const { session, response } = await tenantFetch(path, init)
	if (session === 'transient') throw new TenantSessionUnavailableError()
	return response
}
export async function logoutTenantSession() {
	const refreshToken = getRefreshToken()
	const orgId = getAccessTokenClaims()?.orgId
	try {
		if (refreshToken && orgId) {
			await tenantJson('/auth/logout', { refreshToken, orgId })
		}
	} catch {
		// Still clear local session
	} finally {
		clearSessionTokens()
	}
}
