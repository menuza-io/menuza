import {
	type LoginRequest,
	type JWTLoginApiResponse,
	type SignupRequest,
	type SignupApiResponse,
	type VerifyRequest,
	type VerifyApiResponse,
	type OnboardingRequest,
	type JWTOnboardingApiResponse,
	type SocialAuthRequest,
	type SocialAuthApiResponse,
	type JWTOAuthCallbackApiResponse,
	type JWTRefreshApiResponse,
	type LogoutApiResponse,
	type ApiResponse,
	type OrganizationsApiResponse,
	type OrganizationsApiError,
	type User,
} from '@repo/types'
import { JWTHttpClient } from './jwt-http-client'
import {
	RefreshFailedError,
	type RefreshedSession,
	refreshSessionOnce,
} from './session-refresh'

export interface JWTAuthApiConfig {
	baseUrl: string
	timeout?: number
	retryAttempts?: number
}

export interface AuthApiEndpoints {
	login: string
	signup: string
	verify: string
	onboarding: string
	logout: string
	refresh: string
	organizations: string
	createOrganization: string
	profile: string
	setDefaultOrganization: string
	socialAuth: (provider: string) => string
	socialCallback: (provider: string) => string
}

export class JWTAuthApi {
	private httpClient: JWTHttpClient
	private endpoints: AuthApiEndpoints

	constructor(config: JWTAuthApiConfig) {
		this.httpClient = new JWTHttpClient({
			baseUrl: config.baseUrl,
			timeout: config.timeout,
			retryAttempts: config.retryAttempts,
			onTokenRefresh: this.handleTokenRefresh.bind(this),
			onAuthError: this.handleAuthError.bind(this),
		})

		// Define API endpoints
		this.endpoints = {
			login: '/api/auth/login',
			signup: '/api/auth/signup',
			verify: '/api/auth/verify',
			onboarding: '/api/auth/onboarding',
			logout: '/api/auth/logout',
			refresh: '/api/auth/refresh',
			organizations: '/api/organizations',
			createOrganization: '/api/organizations/create',
			profile: '/api/profile',
			setDefaultOrganization: '/api/organizations/set-default',
			socialAuth: (provider: string) => `/api/auth/${provider}`,
			socialCallback: (provider: string) => `/api/auth/${provider}/callback`,
		}
	}

	/**
	 * Handle token refresh for the HTTP client: joins the app's single shared
	 * refresh, which reads the stored tokens itself.
	 */
	private async handleTokenRefresh(
		_accessToken: string,
		_refreshToken: string,
		_userId: string,
	): Promise<{
		accessToken: string
		refreshToken: string
		expiresIn: number
		expiresAt: string
	}> {
		return (await this.refreshSession()).tokens
	}

	/**
	 * Refreshes the stored session once for every concurrent caller. Throws a
	 * RefreshFailedError; only `endsSession` errors cleared the stored tokens.
	 */
	async refreshSession(): Promise<RefreshedSession> {
		const session = await refreshSessionOnce(
			this.httpClient.getConfig().baseUrl,
		)
		await this.httpClient.setAccessToken(session.tokens.accessToken)
		return session
	}

	/**
	 * Handle authentication errors (token refresh failed, etc.)
	 */
	private handleAuthError(): void {
		// This will be called when authentication fails
		// The auth context should handle this by logging out the user
	}

	/**
	 * Authenticates user with username/email and password
	 */
	async login(credentials: LoginRequest): Promise<JWTLoginApiResponse> {
		try {
			const response = await this.httpClient.postForm<
				JWTLoginApiResponse['data']
			>(this.endpoints.login, credentials)

			if (!response.success) {
				return {
					success: false,
					error: response.error,
					message: response.message,
					status: response.status,
				}
			}

			// Set the access token for future requests
			if (response.data?.accessToken) {
				await this.httpClient.setAccessToken(response.data.accessToken)
			}

			return {
				success: true,
				data: response?.data, // Use the response data directly
				status: response.status,
			}
		} catch (error) {
			return this.handleError(error as Error)
		}
	}

	/**
	 * Signs up a new user with email
	 */
	async signup(signupData: SignupRequest): Promise<SignupApiResponse> {
		try {
			const response = await this.httpClient.postForm<
				SignupApiResponse['data']
			>(this.endpoints.signup, signupData)

			if (!response.success) {
				return {
					success: false,
					error: response.error,
					message: response.message,
					status: response.status,
				}
			}

			return {
				success: true,
				data: response.data,
				status: response.status,
			}
		} catch (error) {
			return this.handleError(error as Error)
		}
	}

	/**
	 * Verifies email with 6-digit code
	 */
	async verify(verifyData: VerifyRequest): Promise<VerifyApiResponse> {
		try {
			const response = await this.httpClient.postForm<
				VerifyApiResponse['data']
			>(this.endpoints.verify, verifyData)

			if (!response.success) {
				return {
					success: false,
					error: response.error,
					message: response.message,
					status: response.status,
				}
			}

			return {
				success: true,
				data: response.data,
				status: response.status,
			}
		} catch (error) {
			return this.handleError(error as Error)
		}
	}

	/**
	 * Completes onboarding with username, password, and name
	 */
	async onboarding(
		onboardingData: OnboardingRequest,
	): Promise<JWTOnboardingApiResponse> {
		try {
			const response = await this.httpClient.postForm<
				JWTOnboardingApiResponse['data']
			>(this.endpoints.onboarding, onboardingData)

			if (!response.success) {
				return {
					success: false,
					error: response.error,
					message: response.message,
					status: response.status,
				}
			}

			// Set the access token for future requests
			if (response.data?.accessToken) {
				await this.httpClient.setAccessToken(response.data.accessToken)
			}

			return {
				success: true,
				data: response.data,
				status: response.status,
			}
		} catch (error) {
			return this.handleError(error as Error)
		}
	}

	/**
	 * Initiates OAuth authentication with a social provider
	 */
	async socialAuth(
		provider: string,
		redirectTo?: string,
	): Promise<SocialAuthApiResponse> {
		try {
			const requestData: SocialAuthRequest = {
				provider,
				redirectTo,
			}

			const response = await this.httpClient.post<
				SocialAuthApiResponse['data']
			>(this.endpoints.socialAuth(provider), requestData)

			if (!response.success) {
				return {
					success: false,
					error: response.error,
					message: response.message,
					status: response.status,
				}
			}

			return {
				success: true,
				data: response.data,
				status: response.status,
			}
		} catch (error) {
			return this.handleError(error as Error)
		}
	}

	/**
	 * Handles OAuth callback after provider authentication
	 */
	async socialCallback(
		provider: string,
		code: string,
		state?: string,
		codeVerifier?: string,
	): Promise<JWTOAuthCallbackApiResponse> {
		try {
			const params = new URLSearchParams({ code })
			if (state) {
				params.append('state', state)
			}
			if (codeVerifier) {
				params.append('code_verifier', codeVerifier)
			}

			const callbackUrl = `/api/auth/${provider}/callback?${params.toString()}`
			const response =
				await this.httpClient.get<JWTOAuthCallbackApiResponse['data']>(
					callbackUrl,
				)

			if (response.success) {
				// Set the access token for future requests
				if (response.data?.accessToken) {
					await this.httpClient.setAccessToken(response.data.accessToken)
				}

				if (response.data?.user && response.data?.accessToken) {
					return {
						success: true,
						data: response.data,
						status: response.status,
					}
				}

				return {
					success: true,
					data: response.data,
					status: response.status,
				}
			}

			return {
				success: false,
				error: response.error || 'oauth_callback_failed',
				message: response.message || 'OAuth callback failed',
				status: response.status,
			}
		} catch (error) {
			if (error instanceof Error) {
				return {
					success: false,
					error: 'network_error',
					message: error.message,
					status: 0,
				}
			}

			return this.handleError(error as Error)
		}
	}

	/**
	 * Refreshes JWT tokens using refresh token
	 */
	async refreshTokens(
		_refreshToken: string,
		_userId: string,
	): Promise<JWTRefreshApiResponse> {
		// The stored tokens are what gets refreshed, through the shared refresh,
		// so a second caller never replays an already-rotated token.
		try {
			const { tokens, user } = await this.refreshSession()
			return {
				success: true,
				data: { ...tokens, user },
				status: 200,
			}
		} catch (error) {
			if (error instanceof RefreshFailedError) {
				return {
					success: false,
					error: error.endsSession ? 'invalid_refresh_token' : 'refresh_failed',
					message: error.message,
					status: error.status,
				}
			}
			return this.handleError(error as Error)
		}
	}

	/**
	 * Logs out the current user
	 */
	async logout(refreshToken?: string): Promise<LogoutApiResponse> {
		try {
			const response = await this.httpClient.post<LogoutApiResponse['data']>(
				this.endpoints.logout,
				{ refreshToken },
			)

			// Clear the access token regardless of response
			this.httpClient.clearAccessToken()

			if (!response.success) {
				return {
					success: false,
					error: response.error,
					message: response.message,
					status: response.status,
				}
			}

			return {
				success: true,
				data: response.data,
				status: response.status,
			}
		} catch (error) {
			// Clear the access token even on error
			this.httpClient.clearAccessToken()
			return this.handleError(error as Error)
		}
	}

	/**
	 * Fetches user organizations (protected endpoint example)
	 */
	async getOrganizations(): Promise<
		OrganizationsApiResponse | OrganizationsApiError
	> {
		try {
			const response = await this.httpClient.get<
				OrganizationsApiResponse['data']
			>(this.endpoints.organizations)

			if (!response.success) {
				return {
					success: false,
					error: response.error || 'unknown_error',
					message: response.message || 'Failed to fetch organizations',
					status: response.status,
				}
			}

			return {
				success: true,
				data: {
					organizations: response.data?.organizations || [],
				},
				status: response.status,
			}
		} catch (error) {
			return {
				success: false,
				error: 'network_error',
				message:
					error instanceof Error ? error.message : 'Network error occurred',
				status: 0,
			}
		}
	}

	/**
	 * Updates user profile
	 */
	async updateProfile(data: {
		name?: string
		username: string
	}): Promise<ApiResponse<{ user: User }>> {
		try {
			const response = await this.httpClient.postForm<{ user: User }>(
				this.endpoints.profile,
				{ ...data, intent: 'update-profile' },
			)

			if (!response.success) {
				return {
					success: false,
					error: response.error,
					message: response.message,
					status: response.status,
				}
			}

			return {
				success: true,
				data: response.data,
				status: response.status,
			}
		} catch (error) {
			return this.handleError(error as Error)
		}
	}

	/**
	 * Sets user's default organization
	 */
	async setDefaultOrganization(
		organizationId: string,
	): Promise<ApiResponse<{ success: boolean }>> {
		try {
			const response = await this.httpClient.postForm<{ success: boolean }>(
				this.endpoints.setDefaultOrganization,
				{ organizationId },
			)

			if (!response.success) {
				return {
					success: false,
					error: response.error,
					message: response.message,
					status: response.status,
				}
			}

			return {
				success: true,
				data: response.data,
				status: response.status,
			}
		} catch (error) {
			return this.handleError(error as Error)
		}
	}

	/**
	 * Creates a new organization
	 */
	async createOrganization(data: {
		name: string
		slug: string
		description?: string
	}): Promise<
		ApiResponse<{
			organization: {
				id: string
				name: string
				slug: string
				description?: string | null
			}
		}>
	> {
		try {
			const response = await this.httpClient.postForm<{
				organization: {
					id: string
					name: string
					slug: string
					description?: string | null
				}
			}>(this.endpoints.createOrganization, data)

			if (!response.success) {
				return {
					success: false,
					error: response.error,
					message: response.message,
					status: response.status,
				}
			}

			return {
				success: true,
				data: response.data,
				status: response.status,
			}
		} catch (error) {
			return this.handleError(error as Error)
		}
	}

	/**
	 * Sets the authorization header for authenticated requests
	 */
	async setAuthToken(token: string): Promise<void> {
		await this.httpClient.setAccessToken(token)
	}

	/**
	 * Removes the authorization header
	 */
	clearAuthToken(): void {
		this.httpClient.clearAccessToken()
	}

	/**
	 * Updates the base URL (useful for switching environments)
	 */
	updateBaseUrl(baseUrl: string): void {
		// Create a new HTTP client with the updated base URL
		const currentConfig = this.httpClient.getConfig()
		this.httpClient = new JWTHttpClient({
			...currentConfig,
			baseUrl,
			onTokenRefresh: this.handleTokenRefresh.bind(this),
			onAuthError: this.handleAuthError.bind(this),
		})
	}

	/**
	 * Gets the current HTTP client configuration
	 */
	getConfig(): JWTAuthApiConfig {
		const config = this.httpClient.getConfig()
		return {
			baseUrl: config.baseUrl,
			timeout: config.timeout,
			retryAttempts: config.retryAttempts,
		}
	}

	/**
	 * Handles errors and converts them to API response format
	 */
	private handleError(error: Error): ApiResponse {
		return {
			success: false,
			error: 'network_error',
			message: error.message || 'An unexpected error occurred',
			status: 0,
		}
	}
}

/**
 * Creates a new JWTAuthApi instance
 */
export function createJWTAuthApi(config: JWTAuthApiConfig): JWTAuthApi {
	return new JWTAuthApi(config)
}

/**
 * Default JWTAuthApi instance factory with common configuration
 */
export function createDefaultJWTAuthApi(baseUrl: string): JWTAuthApi {
	return createJWTAuthApi({
		baseUrl,
		timeout: 10000, // 10 seconds
		retryAttempts: 3,
	})
}
