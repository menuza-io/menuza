import { type TokenData, type User } from '../../types'
import { SecureStorage } from './secure-storage'

export interface TokenValidationResult {
	isValid: boolean
	isExpired: boolean
	needsRefresh: boolean
	tokens: TokenData | null
}

export interface TokenRefreshOptions {
	refreshToken: string
	userId: string
	onRefreshSuccess?: (newTokens: TokenData) => void
	onRefreshFailure?: (error: Error) => void
}

/**
 * TokenManager handles JWT token persistence, validation, and lifecycle management
 */
export class TokenManager {
	private static instance: TokenManager
	private storage: SecureStorage
	private refreshPromise: Promise<TokenData | null> | null = null

	private constructor() {
		this.storage = SecureStorage.getInstance()
	}

	/**
	 * Get singleton instance of TokenManager
	 */
	static getInstance(): TokenManager {
		if (!TokenManager.instance) {
			TokenManager.instance = new TokenManager()
		}
		return TokenManager.instance
	}

	/**
	 * Validate current tokens and check expiration
	 * @returns Token validation result
	 */
	async validateTokens(): Promise<TokenValidationResult> {
		try {
			const tokens = await this.storage.getTokens()

			if (!tokens) {
				return {
					isValid: false,
					isExpired: false,
					needsRefresh: false,
					tokens: null,
				}
			}

			const now = new Date()
			const expiresAt = new Date(tokens.expiresAt)
			const isExpired = now >= expiresAt

			// Consider tokens need refresh if they expire within 2 minutes
			const refreshThreshold = new Date(now.getTime() + 2 * 60 * 1000)
			const needsRefresh = expiresAt <= refreshThreshold

			return {
				isValid: !isExpired,
				isExpired,
				needsRefresh: needsRefresh && !isExpired,
				tokens,
			}
		} catch {
			return {
				isValid: false,
				isExpired: false,
				needsRefresh: false,
				tokens: null,
			}
		}
	}

	/**
	 * Store tokens securely
	 * @param tokens - Token data to store
	 */
	async storeTokens(tokens: TokenData): Promise<void> {
		try {
			await this.storage.storeTokens(tokens)
		} catch (error) {
			throw new Error(
				`Failed to store tokens: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Store user data separately from session
	 * @param user - User data to store
	 */
	async storeUser(user: User): Promise<void> {
		try {
			await this.storage.storeUser(user)
		} catch (error) {
			throw new Error(
				`Failed to store user: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
	}

	/**
	 * Get stored user data
	 * @returns User data or null
	 */
	async getUser(): Promise<User | null> {
		try {
			return await this.storage.getUser()
		} catch {
			return null
		}
	}

	/**
	 * Get current tokens if valid, otherwise return null
	 * @returns Valid token data or null
	 */
	async getCurrentTokens(): Promise<TokenData | null> {
		const validation = await this.validateTokens()
		return validation.isValid ? validation.tokens : null
	}

	/**
	 * Refresh tokens using stored refresh token
	 * @param refreshCallback - Function to call backend refresh endpoint
	 * @returns New token data or null if refresh failed
	 */
	async refreshTokens(
		refreshCallback: (
			refreshToken: string,
			userId: string,
		) => Promise<TokenData>,
	): Promise<TokenData | null> {
		// Prevent multiple concurrent refresh attempts
		if (this.refreshPromise) {
			return this.refreshPromise
		}

		this.refreshPromise = this._performRefresh(refreshCallback)

		try {
			const result = await this.refreshPromise
			return result
		} finally {
			this.refreshPromise = null
		}
	}

	/**
	 * Internal method to perform token refresh
	 */
	private async _performRefresh(
		refreshCallback: (
			refreshToken: string,
			userId: string,
		) => Promise<TokenData>,
	): Promise<TokenData | null> {
		try {
			const tokens = await this.storage.getTokens()
			const user = await this.storage.getUser()

			if (!tokens?.refreshToken || !user?.id) {
				await this.clearTokens()
				return null
			}

			const newTokens = await refreshCallback(tokens.refreshToken, user.id)

			// Store new tokens
			await this.storeTokens(newTokens)

			return newTokens
		} catch (error) {
			// If refresh fails, clear all token data
			await this.clearTokens()
			throw error
		}
	}

	/**
	 * Clear all token data (logout)
	 */
	async clearTokens(): Promise<void> {
		try {
			await this.storage.clearAll()
		} catch (error) {
			throw new Error(
				`Failed to clear tokens: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
		}
		// Wherever the session ends (sign-out, a refresh token that died), photos
		// still waiting to upload (#222) belong to the member who took them and
		// must never upload under the next account.
		await dropQueuedPhotos()
	}

	/**
	 * Check if user has stored tokens
	 * @returns Boolean indicating if tokens exist
	 */
	async hasStoredTokens(): Promise<boolean> {
		try {
			const tokens = await this.storage.getTokens()
			return tokens !== null
		} catch {
			return false
		}
	}

	/**
	 * Update token expiration time
	 * @param newExpirationTime - New expiration time
	 */
	async updateTokenExpiration(newExpirationTime: string): Promise<void> {
		try {
			const tokens = await this.storage.getTokens()

			if (!tokens) {
				throw new Error('No active tokens to update')
			}

			const updatedTokens: TokenData = {
				...tokens,
				expiresAt: newExpirationTime,
			}

			await this.storage.storeTokens(updatedTokens)
		} catch {
			throw new Error('Failed to update token expiration')
		}
	}

	/**
	 * Get token time remaining in milliseconds
	 * @returns Time remaining or 0 if expired/no tokens
	 */
	async getTokenTimeRemaining(): Promise<number> {
		try {
			const tokens = await this.storage.getTokens()

			if (!tokens) {
				return 0
			}

			const now = new Date()
			const expiresAt = new Date(tokens.expiresAt)
			const timeRemaining = expiresAt.getTime() - now.getTime()

			return Math.max(0, timeRemaining)
		} catch {
			return 0
		}
	}

	/**
	 * Check if tokens need refresh based on time threshold
	 * @param thresholdMinutes - Minutes before expiration to trigger refresh (default: 2)
	 * @returns Boolean indicating if refresh is needed
	 */
	async needsRefresh(thresholdMinutes: number = 2): Promise<boolean> {
		try {
			const timeRemaining = await this.getTokenTimeRemaining()
			const thresholdMs = thresholdMinutes * 60 * 1000

			return timeRemaining > 0 && timeRemaining <= thresholdMs
		} catch {
			return false
		}
	}

	/**
	 * Perform automatic token cleanup for expired tokens
	 * This should be called on app startup or periodically
	 */
	async performCleanup(): Promise<void> {
		try {
			const validation = await this.validateTokens()

			if (validation.isExpired) {
				await this.clearTokens()
			}
		} catch {
			// If there's an error validating, clear the tokens to be safe
			await this.clearTokens()
		}
	}

	/**
	 * Get token metadata without sensitive data
	 * @returns Token metadata or null
	 */
	async getTokenMetadata(): Promise<{
		expiresAt: string
		expiresIn: number
	} | null> {
		try {
			const tokens = await this.storage.getTokens()

			if (!tokens) {
				return null
			}

			return {
				expiresAt: tokens.expiresAt,
				expiresIn: tokens.expiresIn,
			}
		} catch {
			return null
		}
	}
}

// Export both names for backward compatibility
export const SessionManager = TokenManager

async function dropQueuedPhotos() {
	try {
		const { clearPhotoQueue } = await import('../photo-queue/runtime')
		await clearPhotoQueue()
	} catch (error) {
		console.error(
			'Could not clear the photo queue when the session ended:',
			error,
		)
	}
}
