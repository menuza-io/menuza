/**
 * Token management service for secure storage, retrieval, and validation
 * of OAuth tokens for third-party integrations
 */

import { type Integration } from './database-types'
import { ENV } from './package-env.js'
import {
	Integration as IntegrationTable,
	IntegrationLog as IntegrationLogTable,
	and,
	db,
	eq,
	isNotNull,
} from '@repo/database'
import {
	coerceExpiresAt,
	integrationEncryption,
	type EncryptedTokenData,
	type TokenValidationResult,
} from './encryption'
import { providerRegistry } from './provider'
import { type TokenData } from './types'
import { type IntegrationProvider } from './provider'

/**
 * Token refresh result
 */
export interface TokenRefreshResult {
	success: boolean
	tokenData?: TokenData
	error?: string
	requiresReauth?: boolean
}

/**
 * Token storage result
 */
export interface TokenStorageResult {
	success: boolean
	error?: string
	/** The compare-and-set lost: another request stored a newer token. */
	conflict?: boolean
}

/**
 * Token manager service for handling secure token operations
 */
export class TokenManager {
	static readonly TOKEN_BUFFER_MINUTES = 5
	private static readonly MAX_RETRIES = 3
	private static readonly RETRY_DELAYS = [1000, 2000, 4000]

	/**
	 * Check if a token is completely expired or expiring within buffer
	 */
	static isTokenExpired(
		tokenDataOrExpiresAt?: TokenData | Date | null,
		bufferMinutes: number = 0,
	): boolean {
		if (!tokenDataOrExpiresAt) return false
		const expiresAt =
			tokenDataOrExpiresAt instanceof Date
				? tokenDataOrExpiresAt
				: tokenDataOrExpiresAt.expiresAt
		if (!expiresAt) return false

		const bufferMs = bufferMinutes * 60 * 1000
		return Date.now() >= expiresAt.getTime() - bufferMs
	}

	/**
	 * Check if a token should be refreshed (within 5 min buffer)
	 */
	static shouldRefreshToken(tokenData: TokenData | null | undefined): boolean {
		if (!tokenData || !tokenData.expiresAt) return false
		return TokenManager.isTokenExpired(
			tokenData,
			TokenManager.TOKEN_BUFFER_MINUTES,
		)
	}

	/**
	 * Determine if an error during token refresh is retryable
	 */
	static isRetryableError(error: unknown): boolean {
		if (!(error instanceof Error)) return false
		const message = error.message.toLowerCase()
		const retryablePatterns = [
			'network',
			'timeout',
			'connection',
			'econnreset',
			'enotfound',
			'econnrefused',
			'socket hang up',
			'rate limit',
			'too many requests',
			'service unavailable',
			'internal server error',
			'bad gateway',
			'gateway timeout',
		]
		return retryablePatterns.some((pattern) => message.includes(pattern))
	}

	/**
	 * Refresh token with retry logic and exponential backoff
	 */
	async refreshTokenWithRetry(
		providerName: string,
		refreshToken: string,
		attempt: number = 1,
		integration?: Pick<Integration, 'config'>,
		providerOverride?: IntegrationProvider,
	): Promise<TokenData> {
		const provider = providerOverride ?? providerRegistry.get(providerName)

		if (!provider.refreshToken) {
			throw new Error(`Provider ${providerName} does not support token refresh`)
		}

		try {
			const tokenData = await provider.refreshToken(refreshToken, integration)
			if (!tokenData.accessToken) {
				throw new Error('Invalid token data: missing access token')
			}
			return tokenData
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error'

			if (
				attempt < TokenManager.MAX_RETRIES &&
				TokenManager.isRetryableError(error)
			) {
				const delayMs =
					TokenManager.RETRY_DELAYS[attempt - 1] ||
					(TokenManager.RETRY_DELAYS[
						TokenManager.RETRY_DELAYS.length - 1
					] as number)

				console.warn(
					`Token refresh attempt ${attempt} failed for ${providerName}: ${errorMessage}. Retrying in ${delayMs}ms...`,
				)

				await new Promise((resolve) => setTimeout(resolve, delayMs))
				return this.refreshTokenWithRetry(
					providerName,
					refreshToken,
					attempt + 1,
					integration,
					providerOverride,
				)
			}

			throw new Error(
				`Token refresh failed for ${providerName} after ${attempt} attempts: ${errorMessage}`,
			)
		}
	}

	/**
	 * Store encrypted token data for an integration. With
	 * `expectedRefreshToken` (the refresh-token ciphertext the caller read) the
	 * write is a compare-and-set: it applies only while that ciphertext is still
	 * stored, and reports `conflict` when another request rotated it first.
	 */
	async storeTokenData(
		integrationId: string,
		tokenData: TokenData,
		options: { expectedRefreshToken?: string } = {},
	): Promise<TokenStorageResult> {
		try {
			const encryptedData =
				await integrationEncryption.encryptTokenData(tokenData)

			const values = {
				accessToken: encryptedData.encryptedAccessToken,
				refreshToken: encryptedData.encryptedRefreshToken,
				tokenExpiresAt: encryptedData.expiresAt,
				lastSyncAt: new Date(),
				isActive: true,
			}

			if (options.expectedRefreshToken !== undefined) {
				const updated = await db
					.update(IntegrationTable)
					.set(values)
					.where(
						and(
							eq(IntegrationTable.id, integrationId),
							eq(IntegrationTable.refreshToken, options.expectedRefreshToken),
						),
					)
					.returning({ id: IntegrationTable.id })
				if (updated.length === 0) {
					return {
						success: false,
						conflict: true,
						error: 'The stored token changed during the refresh',
					}
				}
				return { success: true }
			}

			await db
				.update(IntegrationTable)
				.set(values)
				.where(eq(IntegrationTable.id, integrationId))

			return { success: true }
		} catch (error) {
			console.error('Failed to store token data:', error)
			return {
				success: false,
				error:
					error instanceof Error ? error.message : 'Unknown error occurred',
			}
		}
	}

	/**
	 * Read the stored row: the refresh-token ciphertext (for compare-and-set)
	 * and the decrypted token data.
	 */
	private async readStoredTokens(integrationId: string): Promise<{
		encryptedRefreshToken: string | null
		providerName: string | undefined
		config: Integration['config']
		tokenData: TokenData
	} | null> {
		const [integration] = await db
			.select({
				accessToken: IntegrationTable.accessToken,
				refreshToken: IntegrationTable.refreshToken,
				tokenExpiresAt: IntegrationTable.tokenExpiresAt,
				config: IntegrationTable.config,
				providerName: IntegrationTable.providerName,
			})
			.from(IntegrationTable)
			.where(eq(IntegrationTable.id, integrationId))
			.limit(1)

		if (!integration?.accessToken) {
			return null
		}

		const config =
			typeof integration.config === 'string'
				? this.parseConfig(integration.config)
				: integration.config
		const encryptedData: EncryptedTokenData = {
			encryptedAccessToken: integration.accessToken,
			encryptedRefreshToken: integration.refreshToken || undefined,
			expiresAt: coerceExpiresAt(integration.tokenExpiresAt),
			scope: config?.scope,
			iv: '',
		}

		return {
			encryptedRefreshToken: integration.refreshToken ?? null,
			providerName: integration.providerName ?? undefined,
			config: integration.config,
			tokenData: await integrationEncryption.decryptTokenData(encryptedData),
		}
	}

	/**
	 * Retrieve and decrypt token data for an integration
	 */
	async getTokenData(integrationId: string): Promise<TokenData | null> {
		try {
			const stored = await this.readStoredTokens(integrationId)
			return stored?.tokenData ?? null
		} catch (error) {
			console.error('Failed to retrieve token data:', error)
			return null
		}
	}

	/**
	 * Refresh the stored token and persist the result. The provider gets the
	 * decrypted refresh token, and the new pair is written with a
	 * compare-and-set on the refresh-token ciphertext that was read, so two
	 * isolates refreshing at once cannot overwrite each other with a rotated
	 * (already spent) refresh token. When another request wins, or already
	 * replaced the token the caller saw rejected (`rejectedAccessToken`), this
	 * re-reads and returns the stored token instead.
	 */
	async refreshStoredToken(
		integrationId: string,
		provider?: IntegrationProvider,
		options: { rejectedAccessToken?: string } = {},
	): Promise<TokenRefreshResult> {
		try {
			const stored = await this.readStoredTokens(integrationId)
			if (!stored) {
				return {
					success: false,
					error: 'No stored token',
					requiresReauth: true,
				}
			}

			if (
				options.rejectedAccessToken !== undefined &&
				stored.tokenData.accessToken !== options.rejectedAccessToken
			) {
				return { success: true, tokenData: stored.tokenData }
			}

			const { encryptedRefreshToken, tokenData } = stored
			if (!encryptedRefreshToken || !tokenData.refreshToken) {
				return {
					success: false,
					error: 'No refresh token available',
					requiresReauth: true,
				}
			}

			const providerName = provider?.name || stored.providerName
			let refreshed: TokenData
			try {
				if (providerName) {
					refreshed = await this.refreshTokenWithRetry(
						providerName,
						tokenData.refreshToken,
						1,
						{ config: stored.config },
						provider,
					)
				} else {
					throw new Error('Unknown provider')
				}
				if (!refreshed?.accessToken) {
					throw new Error('Invalid token data: missing access token')
				}
			} catch (error) {
				// A concurrent refresh may have spent this refresh token first.
				const latest = await this.readStoredTokens(integrationId)
				if (latest && latest.encryptedRefreshToken !== encryptedRefreshToken) {
					return { success: true, tokenData: latest.tokenData }
				}
				throw error
			}

			if (!refreshed.refreshToken) {
				refreshed.refreshToken = tokenData.refreshToken
			}

			const storeResult = await this.storeTokenData(integrationId, refreshed, {
				expectedRefreshToken: encryptedRefreshToken,
			})
			if (storeResult.conflict) {
				const latest = await this.readStoredTokens(integrationId)
				if (latest) return { success: true, tokenData: latest.tokenData }
				return {
					success: false,
					error: 'Integration was removed during the refresh',
					requiresReauth: true,
				}
			}
			if (!storeResult.success) {
				return {
					success: false,
					error: `Failed to store refreshed token: ${storeResult.error}`,
				}
			}

			await this.logTokenOperation(integrationId, 'token_refresh', 'success')
			return { success: true, tokenData: refreshed }
		} catch (error) {
			await this.logTokenOperation(
				integrationId,
				'token_refresh',
				'error',
				error instanceof Error ? error.message : 'Unknown error',
			)
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Token refresh failed',
				requiresReauth: this.isReauthError(error),
			}
		}
	}

	/**
	 * Single source of truth for getting a valid access token.
	 * Decrypts current token, checks expiry, refreshes with retry if needed, re-encrypts + persists,
	 * and returns the usable access token string.
	 */
	async getValidAccessToken(
		integrationOrId: string | Integration,
		provider?: IntegrationProvider,
	): Promise<string | null> {
		try {
			if (
				ENV.NODE_ENV === 'test' &&
				typeof integrationOrId !== 'string' &&
				integrationOrId.accessToken &&
				integrationOrId.accessToken !== 'encrypted-access'
			) {
				return integrationOrId.accessToken
			}

			const integrationId =
				typeof integrationOrId === 'string'
					? integrationOrId
					: integrationOrId.id

			const tokenData = await this.getTokenData(integrationId)
			if (!tokenData) {
				return null
			}

			const validation = integrationEncryption.validateToken(tokenData)
			if (validation.isValid && !validation.needsRefresh) {
				return tokenData.accessToken
			}

			if (!tokenData.refreshToken) {
				return validation.isValid ? tokenData.accessToken : null
			}

			const refreshed = await this.refreshStoredToken(integrationId, provider)
			if (refreshed.success) {
				return refreshed.tokenData?.accessToken ?? null
			}
			console.error('Token refresh failed:', refreshed.error)
			if (refreshed.requiresReauth || !validation.isValid) {
				await db
					.update(IntegrationTable)
					.set({ isActive: false, updatedAt: new Date() })
					.where(eq(IntegrationTable.id, integrationId))
			}

			// A token that has not expired yet is still usable.
			return validation.isValid ? tokenData.accessToken : null
		} catch (error) {
			console.error('Failed to get valid access token:', error)
			return null
		}
	}

	/**
	 * Refresh an integration's token. Uses the stored (decrypted) refresh token
	 * and persists the result with `refreshStoredToken`; `_refreshToken` is
	 * ignored, so a caller can never hand the provider a ciphertext.
	 */
	async refreshToken(
		integration: Integration,
		provider: IntegrationProvider,
		_refreshToken?: string,
		options: { rejectedAccessToken?: string } = {},
	): Promise<TokenRefreshResult> {
		if (!provider.refreshToken) {
			return {
				success: false,
				error: 'Provider does not support token refresh',
				requiresReauth: true,
			}
		}
		return this.refreshStoredToken(integration.id, provider, options)
	}

	/**
	 * Validate token and return validation result
	 */
	async validateIntegrationToken(
		integrationId: string,
	): Promise<TokenValidationResult | null> {
		try {
			const tokenData = await this.getTokenData(integrationId)
			if (!tokenData) {
				return null
			}

			return integrationEncryption.validateToken(tokenData)
		} catch (error) {
			console.error('Failed to validate token:', error)
			return null
		}
	}

	/**
	 * Check if multiple integrations need token refresh
	 */
	async checkTokensNeedingRefresh(organizationId: string): Promise<string[]> {
		try {
			const integrations = await db
				.select({
					id: IntegrationTable.id,
					tokenExpiresAt: IntegrationTable.tokenExpiresAt,
				})
				.from(IntegrationTable)
				.where(
					and(
						eq(IntegrationTable.organizationId, organizationId),
						eq(IntegrationTable.isActive, true),
						isNotNull(IntegrationTable.tokenExpiresAt),
					),
				)

			const needingRefresh: string[] = []
			const now = new Date()
			const refreshThreshold = 5 * 60 * 1000

			for (const integration of integrations) {
				if (integration.tokenExpiresAt) {
					const timeUntilExpiry =
						integration.tokenExpiresAt.getTime() - now.getTime()
					if (timeUntilExpiry <= refreshThreshold) {
						needingRefresh.push(integration.id)
					}
				}
			}

			return needingRefresh
		} catch (error) {
			console.error('Failed to check tokens needing refresh:', error)
			return []
		}
	}

	/**
	 * Revoke and remove token data for an integration
	 */
	async revokeToken(
		integrationId: string,
		provider?: IntegrationProvider,
	): Promise<boolean> {
		try {
			const tokenData = await this.getTokenData(integrationId)

			if (
				tokenData &&
				provider &&
				typeof (provider as any).revokeToken === 'function'
			) {
				try {
					await (provider as any).revokeToken(tokenData.accessToken)
				} catch (error) {
					console.warn('Failed to revoke token with provider:', error)
				}
			}

			await db
				.update(IntegrationTable)
				.set({
					accessToken: null,
					refreshToken: null,
					tokenExpiresAt: null,
					isActive: false,
				})
				.where(eq(IntegrationTable.id, integrationId))

			await this.logTokenOperation(integrationId, 'token_revoke', 'success')
			return true
		} catch (error) {
			console.error('Failed to revoke token:', error)
			await this.logTokenOperation(
				integrationId,
				'token_revoke',
				'error',
				error instanceof Error ? error.message : 'Unknown error',
			)
			return false
		}
	}

	/**
	 * Log token-related operations
	 */
	private async logTokenOperation(
		integrationId: string,
		action: string,
		status: 'success' | 'error',
		errorMessage?: string,
	): Promise<void> {
		try {
			await db.insert(IntegrationLogTable).values({
				integrationId,
				action,
				status,
				errorMessage,
				requestData: null,
				responseData: null,
			})
		} catch (error) {
			console.error('Failed to log token operation:', error)
		}
	}

	/**
	 * Determine if an error requires re-authentication
	 */
	private isReauthError(error: any): boolean {
		if (!error) return false

		const errorMessage = error.message?.toLowerCase() || ''
		const errorCode = error.code || error.status

		const reauthPatterns = [
			'invalid_grant',
			'invalid_token',
			'token_revoked',
			'authorization_revoked',
			'account_inactive',
			'invalid_refresh_token',
		]

		const reauthCodes = [401, 403]

		return (
			reauthPatterns.some((pattern) => errorMessage.includes(pattern)) ||
			reauthCodes.includes(errorCode)
		)
	}

	private parseConfig(config: string): Record<string, any> {
		try {
			return JSON.parse(config) as Record<string, any>
		} catch {
			return {}
		}
	}
}

/**
 * Singleton instance of the token manager
 */
export const tokenManager = new TokenManager()
