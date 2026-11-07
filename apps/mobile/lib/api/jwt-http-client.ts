import { type RequestConfig, type ApiResponse } from '@repo/types'
import { TokenManager } from '../storage/session-manager'
import { HttpClient } from './http-client'
import { RefreshFailedError, endsSession } from './session-refresh'

export interface JWTHttpClientConfig {
	baseUrl: string
	timeout?: number
	retryAttempts?: number
	onTokenRefresh?: (
		accessToken: string,
		refreshToken: string,
		userId: string,
	) => Promise<{
		accessToken: string
		refreshToken: string
		expiresIn: number
		expiresAt: string
	}>
	onAuthError?: () => void
}

/**
 * HTTP client that automatically handles JWT token authentication and refresh
 */
export class JWTHttpClient extends HttpClient {
	private tokenManager: TokenManager
	private onTokenRefresh?: JWTHttpClientConfig['onTokenRefresh']
	private onAuthError?: JWTHttpClientConfig['onAuthError']
	private refreshPromise: Promise<void> | null = null

	constructor(config: JWTHttpClientConfig) {
		super({
			baseUrl: config.baseUrl,
			timeout: config.timeout,
			retryAttempts: config.retryAttempts,
		})

		this.tokenManager = TokenManager.getInstance()
		this.onTokenRefresh = config.onTokenRefresh
		this.onAuthError = config.onAuthError
	}

	/**
	 * Override the request method to automatically add JWT token and handle refresh
	 */
	async request<T>(
		url: string,
		options: RequestConfig = {},
	): Promise<ApiResponse<T>> {
		// Skip token validation for authentication endpoints
		const isAuthEndpoint = this.isAuthenticationEndpoint(url)

		// Ensure we have a valid token before making the request (except for auth endpoints)
		if (!isAuthEndpoint) {
			await this.ensureValidToken()
		}

		// Authorization header is already set via setDefaultHeader in setAccessToken
		// No need to add it again per-request

		// Make the request
		let response = await super.request<T>(url, options)

		// If we get a 401, try to refresh the token and retry once (except for auth endpoints)
		if (
			!isAuthEndpoint &&
			!response.success &&
			response.status === 401 &&
			this.onTokenRefresh
		) {
			try {
				await this.refreshTokenIfNeeded(true) // Force refresh

				// Retry the request with the new token (already set via setDefaultHeader)
				response = await super.request<T>(url, options)
			} catch (error) {
				// Only a refused refresh token ends the session; offline, rate
				// limits and server errors leave it for the next attempt.
				if (endsSession(error)) this.onAuthError?.()
			}
		}

		return response
	}

	/**
	 * Check if the URL is an authentication endpoint that doesn't require tokens
	 */
	private isAuthenticationEndpoint(url: string): boolean {
		const authEndpoints = [
			'/api/auth/login',
			'/api/auth/signup',
			'/api/auth/verify',
			'/api/auth/onboarding',
			'/api/auth/refresh', // Refresh endpoint handles its own token logic
		]

		// Check if the URL ends with any of the auth endpoints
		return (
			authEndpoints.some((endpoint) => url.endsWith(endpoint)) ||
			(url.includes('/api/auth/') &&
				(url.includes('/callback') || url.includes('/social')))
		)
	}

	/**
	 * Ensure we have a valid access token, refreshing if necessary
	 */
	private async ensureValidToken(): Promise<void> {
		const validation = await this.tokenManager.validateTokens()

		if (!validation.isValid || validation.needsRefresh) {
			await this.refreshTokenIfNeeded()
		}
	}

	/**
	 * Refresh token if needed, preventing concurrent refresh attempts
	 */
	private async refreshTokenIfNeeded(force: boolean = false): Promise<void> {
		// If there's already a refresh in progress, wait for it
		if (this.refreshPromise) {
			return this.refreshPromise
		}

		const validation = await this.tokenManager.validateTokens()

		if (force || !validation.isValid || validation.needsRefresh) {
			this.refreshPromise = this.performTokenRefresh()

			try {
				await this.refreshPromise
			} finally {
				this.refreshPromise = null
			}
		}
	}

	/**
	 * Perform the actual token refresh
	 */
	private async performTokenRefresh(): Promise<void> {
		if (!this.onTokenRefresh) {
			throw new Error('No token refresh handler configured')
		}

		// The stored tokens, even when the access token has expired (that is
		// when a refresh is needed).
		const { tokens } = await this.tokenManager.validateTokens()
		const user = await this.tokenManager.getUser()

		if (!tokens?.refreshToken || !user?.id) {
			throw new RefreshFailedError('No refresh token or user ID available', 401)
		}

		try {
			const newTokens = await this.onTokenRefresh(
				tokens.accessToken,
				tokens.refreshToken,
				user.id,
			)

			// Store the new tokens
			await this.tokenManager.storeTokens(newTokens)
		} catch (error) {
			// Clear tokens only when the server refused the refresh token. A
			// network error, a rate limit or a 5xx keeps the session.
			if (endsSession(error)) await this.tokenManager.clearTokens()
			throw error
		}
	}

	/**
	 * Set the token refresh handler
	 */
	setTokenRefreshHandler(handler: JWTHttpClientConfig['onTokenRefresh']): void {
		this.onTokenRefresh = handler
	}

	/**
	 * Set the auth error handler
	 */
	setAuthErrorHandler(handler: JWTHttpClientConfig['onAuthError']): void {
		this.onAuthError = handler
	}

	/**
	 * Manually set the access token (useful after login)
	 */
	async setAccessToken(accessToken: string): Promise<void> {
		this.setDefaultHeader('Authorization', `Bearer ${accessToken}`)
	}

	/**
	 * Clear the access token
	 */
	clearAccessToken(): void {
		this.removeDefaultHeader('Authorization')
	}
}
