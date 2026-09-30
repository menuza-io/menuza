/**
 * Core integration provider interface and base implementation
 */

import {
	type Integration,
	type NoteIntegrationConnection,
} from './database-types'
import {
	type TokenData,
	type Channel,
	type MessageData,
	type OAuthCallbackParams,
	type ProviderType,
} from './types'
import { OAuthStateManager } from './oauth-manager'
import { TokenManager } from './token-manager'

/**
 * Core interface that all integration providers must implement
 */
export interface IntegrationProvider {
	/** Provider name (e.g., 'slack', 'teams', 'jira') */
	readonly name: string

	/** Provider type category */
	readonly type: ProviderType

	/** Provider display name for UI */
	readonly displayName: string

	/** Provider description */
	readonly description: string

	/** Provider logo URL or path */
	readonly logoPath: string

	// OAuth flow methods

	/**
	 * Generate OAuth authorization URL
	 * @param organizationId - Organization ID requesting authorization
	 * @param redirectUri - OAuth callback URI
	 * @param additionalParams - Provider-specific parameters
	 * @returns Promise resolving to authorization URL
	 */
	getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string>

	/**
	 * Handle OAuth callback and exchange code for tokens
	 * @param params - OAuth callback parameters
	 * @returns Promise resolving to token data
	 */
	handleCallback(params: OAuthCallbackParams): Promise<TokenData>

	/**
	 * Refresh expired access token
	 * @param refreshToken - Refresh token
	 * @returns Promise resolving to new token data
	 */
	refreshToken(refreshToken: string): Promise<TokenData>
	revokeToken?(token: string): Promise<void>

	// Provider-specific operations

	/**
	 * Get available channels/destinations for the integration
	 * @param integration - Integration instance with credentials
	 * @returns Promise resolving to available channels
	 */
	getAvailableChannels(integration: Integration): Promise<Channel[]>

	/**
	 * Post a message to a connected channel
	 * @param connection - Note-to-channel connection
	 * @param message - Message data to post
	 * @returns Promise that resolves when message is posted
	 */
	postMessage(
		connection: NoteIntegrationConnection & { integration: Integration },
		message: MessageData,
	): Promise<void>

	/**
	 * Validate that a connection is still active and accessible
	 * @param connection - Connection to validate
	 * @returns Promise resolving to validation result
	 */
	validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean>

	/**
	 * Optionally revoke an access token
	 * @param token - Access token to revoke
	 */
	revokeToken?: (token: string) => Promise<void>

	/**
	 * Get provider-specific configuration schema
	 * @returns Configuration schema for this provider
	 */
	getConfigSchema(): Record<string, any>
}

/**
 * Base abstract class providing common functionality for integration providers
 */
export abstract class BaseIntegrationProvider implements IntegrationProvider {
	abstract readonly name: string
	abstract readonly type: ProviderType
	abstract readonly displayName: string
	abstract readonly description: string
	abstract readonly logoPath: string

	// Abstract methods that must be implemented by concrete providers
	abstract getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string>

	abstract handleCallback(params: OAuthCallbackParams): Promise<TokenData>
	abstract refreshToken(refreshToken: string): Promise<TokenData>
	revokeToken?(token: string): Promise<void>
	abstract getAvailableChannels(integration: Integration): Promise<Channel[]>
	abstract postMessage(
		connection: NoteIntegrationConnection & { integration: Integration },
		message: MessageData,
	): Promise<void>
	abstract validateConnection(
		connection: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean>
	abstract getConfigSchema(): Record<string, any>

	// Common utility methods

	/**
	 * Generate a secure random state string for OAuth
	 * @param organizationId - Organization ID
	 * @param additionalData - Additional data to include in state
	 * @returns Secure state string
	 */
	protected generateOAuthState(
		organizationId: string,
		additionalData?: Record<string, any>,
	): string {
		// Import here to avoid circular dependencies
		return OAuthStateManager.generateState(
			organizationId,
			this.name,
			undefined,
			additionalData,
		)
	}

	/**
	 * Parse OAuth state during `handleCallback`. The nonce is consumed once in
	 * `oauthFlow.complete` before the provider runs; do not consume it again here.
	 */
	protected parseOAuthState(state: string): {
		organizationId: string
		providerName: string
		timestamp: number
		[key: string]: any
	} {
		return OAuthStateManager.parseState(state)
	}

	/**
	 * Check if a token is expired or about to expire
	 * @param expiresAt - Token expiration date
	 * @param bufferMinutes - Minutes before expiration to consider expired
	 * @returns True if token is expired or about to expire
	 */
	protected isTokenExpired(
		expiresAt?: Date,
		bufferMinutes: number = 5,
	): boolean {
		if (!expiresAt) return false
		return TokenManager.isTokenExpired(expiresAt, bufferMinutes)
	}

	/**
	 * Make an authenticated HTTP request to the provider's API.
	 * Resolves a valid access token from TokenManager, injects Authorization header,
	 * and performs automatic 401 retry after forced token refresh.
	 */
	protected async makeAuthenticatedRequest(
		integration: Integration,
		endpoint: string,
		options: RequestInit = {},
	): Promise<Response> {
		const { tokenManager } = await import('./token-manager')
		let accessToken = await tokenManager.getValidAccessToken(integration, this)

		if (!accessToken) {
			throw new Error(
				`Failed to obtain access token for integration ${integration.id}`,
			)
		}

		const headers = new Headers(options.headers || {})
		headers.set('Authorization', `Bearer ${accessToken}`)

		let response = await fetch(endpoint, {
			...options,
			headers,
		})

		// On 401 Unauthorized, force token refresh and retry request once
		if (response.status === 401 && integration.refreshToken) {
			try {
				const refreshResult = await tokenManager.refreshToken(
					integration,
					this,
					integration.refreshToken,
				)
				if (refreshResult.success && refreshResult.tokenData?.accessToken) {
					headers.set(
						'Authorization',
						`Bearer ${refreshResult.tokenData.accessToken}`,
					)
					response = await fetch(endpoint, {
						...options,
						headers,
					})
				}
			} catch (refreshError) {
				console.warn('Auto-refresh after 401 failed:', refreshError)
			}
		}

		return response
	}

	/**
	 * Handle API errors and convert to appropriate error types
	 * @param response - HTTP response
	 * @param context - Error context for logging
	 */
	protected async handleApiError(
		response: Response,
		context: string,
	): Promise<never> {
		const errorText = await response.text()
		let errorMessage = `${context}: ${response.status} ${response.statusText}`

		try {
			const errorData = JSON.parse(errorText) as any
			if (errorData?.error || errorData?.message) {
				errorMessage += ` - ${errorData.error || errorData.message}`
			}
		} catch {
			// If response is not JSON, include raw text
			if (errorText) {
				errorMessage += ` - ${errorText}`
			}
		}

		throw new Error(errorMessage)
	}

	/**
	 * Format task title from message data with emoji
	 * @param message - Message data
	 * @returns Formatted title with emoji
	 */
	protected formatTaskTitle(message: MessageData): string {
		const emoji = this.getChangeEmoji(message.changeType)
		const truncatedTitle = this.truncateText(message.title, 100)
		return `${emoji} ${truncatedTitle}`
	}

	/**
	 * Get emoji for change type
	 * @param changeType - Type of change
	 * @returns Appropriate emoji
	 */
	protected getChangeEmoji(changeType: string): string {
		switch (changeType) {
			case 'created':
				return '✨'
			case 'updated':
				return '📝'
			case 'deleted':
				return '🗑️'
			default:
				return '📄'
		}
	}

	/**
	 * Truncate text to specified length
	 * @param text - Text to truncate
	 * @param maxLength - Maximum length
	 * @returns Truncated text with ellipsis if needed
	 */
	protected truncateText(text: string, maxLength: number): string {
		if (text.length <= maxLength) {
			return text
		}
		return text.substring(0, maxLength - 3) + '...'
	}
}

/**
 * Registry for managing integration providers
 */
export class ProviderRegistry {
	private providers = new Map<string, IntegrationProvider>()

	/**
	 * Register a new integration provider
	 * @param provider - Provider instance to register
	 */
	register(provider: IntegrationProvider): void {
		this.providers.set(provider.name, provider)
	}

	/**
	 * Get a provider by name
	 * @param name - Provider name
	 * @returns Provider instance
	 * @throws Error if provider not found
	 */
	get(name: string): IntegrationProvider {
		const provider = this.providers.get(name)
		if (!provider) {
			throw new Error(`Integration provider '${name}' not found`)
		}
		return provider
	}

	/**
	 * Get all registered providers
	 * @returns Array of all providers
	 */
	getAll(): IntegrationProvider[] {
		return Array.from(this.providers.values())
	}

	/**
	 * Get providers by type
	 * @param type - Provider type to filter by
	 * @returns Array of providers matching the type
	 */
	getByType(type: ProviderType): IntegrationProvider[] {
		return this.getAll().filter((provider) => provider.type === type)
	}

	/**
	 * Check if a provider is registered
	 * @param name - Provider name
	 * @returns True if provider is registered
	 */
	has(name: string): boolean {
		return this.providers.has(name)
	}

	/**
	 * Unregister a provider
	 * @param name - Provider name to unregister
	 */
	unregister(name: string): void {
		this.providers.delete(name)
	}
}

// Global provider registry instance
export const providerRegistry = new ProviderRegistry()
