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

export function getBrowserTenantApiUrl(): string {
	const fromDom = document.documentElement.dataset.tenantApiUrl
	if (fromDom) return fromDom.replace(/\/$/, '')
	// SSR should set data-tenant-api-url; localhost fallback for local dev only.
	return 'http://localhost:3007'
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

// Refresh tokens are single-use: two tabs (or two parallel requests) that
// refresh at once would present the same token, trip the server's reuse
// detection, and sign the customer out everywhere. Share one in-flight call.
let inflightRefresh: Promise<boolean> | null = null

function refreshSession(): Promise<boolean> {
	inflightRefresh ??= doRefreshSession().finally(() => {
		inflightRefresh = null
	})
	return inflightRefresh
}

async function doRefreshSession(): Promise<boolean> {
	const refreshToken = getRefreshToken()
	const orgId = getAccessTokenClaims()?.orgId
	if (!refreshToken || !orgId) {
		clearSessionTokens()
		return false
	}

	try {
		const { ok, data } = await tenantJson('/auth/refresh', {
			refreshToken,
			orgId,
		})
		if (!ok || typeof data.accessToken !== 'string') {
			clearSessionTokens()
			return false
		}
		setSessionTokens({
			accessToken: data.accessToken,
			refreshToken:
				typeof data.refreshToken === 'string' ? data.refreshToken : undefined,
		})
		return true
	} catch {
		clearSessionTokens()
		return false
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

export function redirectHomeIfSignedIn() {
	if (getAccessToken()) {
		window.location.replace(browserLocaleHref('/'))
	}
}

export async function tenantFetch(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers)
	const access = getAccessToken()
	if (access) headers.set('Authorization', `Bearer ${access}`)
	if (init.body && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json')
	}

	const request = () =>
		fetch(`${getBrowserTenantApiUrl()}${path}`, { ...init, headers })

	let res = await request()
	if (res.status === 401 && getRefreshToken()) {
		const refreshed = await refreshSession()
		if (refreshed) {
			const nextAccess = getAccessToken()
			if (nextAccess) headers.set('Authorization', `Bearer ${nextAccess}`)
			res = await request()
		}
	}
	return res
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
