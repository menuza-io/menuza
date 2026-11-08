import { type JWTRefreshApiResponse } from '@repo/types'
import { type TokenData } from '../../types'
import { TokenManager } from '../storage/session-manager'

/**
 * A refresh that did not produce new tokens. `status` is the HTTP status, or
 * 0 when the request never got an answer (offline, timeout).
 */
export class RefreshFailedError extends Error {
	readonly status: number

	constructor(message: string, status: number) {
		super(message)
		this.name = 'RefreshFailedError'
		this.status = status
	}

	/**
	 * The server refused this refresh token (or there is none), so it will
	 * never work again. Rate limits, server errors and lost connections say
	 * nothing about the session and keep it.
	 */
	get endsSession(): boolean {
		return this.status === 400 || this.status === 401
	}
}

export function endsSession(error: unknown): boolean {
	return error instanceof RefreshFailedError && error.endsSession
}

export interface RefreshedSession {
	tokens: TokenData
	user?: NonNullable<JWTRefreshApiResponse['data']>['user']
}

// Refresh tokens rotate: two refreshes presenting the same token would make
// the second one fail. Every caller in the app (the HTTP client's automatic
// refresh, the auth context, app start) shares this one in-flight refresh.
let inflight: Promise<RefreshedSession> | null = null

export function refreshSessionOnce(baseUrl: string): Promise<RefreshedSession> {
	if (inflight) return inflight
	const run = performRefresh(baseUrl).finally(() => {
		if (inflight === run) inflight = null
	})
	inflight = run
	return run
}

async function performRefresh(baseUrl: string): Promise<RefreshedSession> {
	const manager = TokenManager.getInstance()
	// Read the stored tokens even when the access token has expired: that is
	// exactly when a refresh is needed.
	const { tokens } = await manager.validateTokens()
	const user = await manager.getUser()
	if (!tokens?.refreshToken || !user?.id) {
		throw new RefreshFailedError('No session to refresh', 401)
	}

	let response: Response
	try {
		// One attempt, never retried automatically: if the answer is lost, a
		// later refresh presents the same token again and the server's grace
		// window hands back the same successor.
		response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/auth/refresh`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({
				refreshToken: tokens.refreshToken,
				userId: user.id,
			}),
		})
	} catch (error) {
		throw new RefreshFailedError(
			error instanceof Error ? error.message : 'Network error',
			0,
		)
	}

	const body = (await response
		.json()
		.catch(() => null)) as JWTRefreshApiResponse | null
	const data = body?.data
	if (!response.ok || !body?.success || !data?.accessToken) {
		const error = new RefreshFailedError(
			body?.message || 'Token refresh failed',
			response.ok ? 500 : response.status,
		)
		if (error.endsSession) await manager.clearTokens()
		throw error
	}

	const next: TokenData = {
		accessToken: data.accessToken,
		refreshToken: data.refreshToken,
		expiresIn: data.expiresIn,
		expiresAt: data.expiresAt,
	}
	await manager.storeTokens(next)
	return { tokens: next, user: data.user }
}
