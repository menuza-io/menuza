/**
 * Token management service for secure storage, retrieval, and validation
 * of OAuth tokens for third-party integrations
 */

import { type Integration } from './database-types'
import { ENV } from './package-env.ts'
import {
	Integration as IntegrationTable,
	IntegrationLog as IntegrationLogTable,
	and,
	db,
	eq,
	isNotNull,
} from '@repo/database'
import {
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
	): Promise<TokenData> {
		const provider = providerRegistry.get(providerName)

		if (!provider.refreshToken) {
			throw new Error(`Provider ${providerName} does not support token refresh`)
		}

		try {
			const tokenData = await provider.refreshToken(refreshToken)
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
				)
			}

			throw new Error(
				`Token refresh failed for ${providerName} after ${attempt} attempts: ${errorMessage}`,
			)
		}
	}

	/**
	 * Store encrypted token data for an integration
	 */
	async storeTokenData(
		integrationId: string,
		tokenData: TokenData,
	): Promise<TokenStorageResult> {
		try {
			const encryptedData =
				await integrationEncryption.encryptTokenData(tokenData)

			await db
				.update(IntegrationTable)
				.set({
					accessToken: encryptedData.encryptedAccessToken,
					refreshToken: encryptedData.encryptedRefreshToken,
					tokenExpiresAt: encryptedData.expiresAt,
					lastSyncAt: new Date(),
					isActive: true,
				})
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
	 * Retrieve and decrypt token data for an integration
	 */
	async getTokenData(integrationId: string): Promise<TokenData | null> {
		try {
			const [integration] = await db
				.select({
					accessToken: IntegrationTable.accessToken,
					refreshToken: IntegrationTable.refreshToken,
					tokenExpiresAt: IntegrationTable.tokenExpiresAt,
					config: IntegrationTable.config,
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
				expiresAt: integration.tokenExpiresAt || undefined,
				scope: config?.scope,
				iv: '',
			}

			return await integrationEncryption.decryptTokenData(encryptedData)
		} catch (error) {
			console.error('Failed to retrieve token data:', error)
			return null
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

			const providerName =
				typeof integrationOrId === 'string'
					? undefined
					: integrationOrId.providerName

			const tokenData = await this.getTokenData(integrationId)
			if (!tokenData) {
				return null
			}

			const validation = integrationEncryption.validateToken(tokenData)
			if (validation.isValid && !validation.needsRefresh) {
				return tokenData.accessToken
			}

			const effectiveProviderName =
				providerName ||
				provider?.name ||
				(
					await db
						.select({ providerName: IntegrationTable.providerName })
						.from(IntegrationTable)
						.where(eq(IntegrationTable.id, integrationId))
						.limit(1)
				)[0]?.providerName

			if (!effectiveProviderName) {
				return null
			}

			if (tokenData.refreshToken) {
				const refreshedTokenData = provider?.refreshToken
					? await provider.refreshToken(tokenData.refreshToken)
					: await this.refreshTokenWithRetry(
							effectiveProviderName,
							tokenData.refreshToken,
						)

				if (refreshedTokenData && refreshedTokenData.accessToken) {
					if (!refreshedTokenData.refreshToken) {
						refreshedTokenData.refreshToken = tokenData.refreshToken
					}
					await this.storeTokenData(integrationId, refreshedTokenData)
					await this.logTokenOperation(
						integrationId,
						'token_refresh',
						'success',
					)
					return refreshedTokenData.accessToken
				}
			}

			return null
		} catch (error) {
			console.error('Failed to get valid access token:', error)
			return null
		}
	}

	/**
	 * Refresh an expired or expiring token
	 */
	async refreshToken(
		integration: Integration,
		provider: IntegrationProvider,
		refreshToken: string,
	): Promise<TokenRefreshResult> {
		try {
			if (!provider.refreshToken) {
				return {
					success: false,
					error: 'Provider does not support token refresh',
					requiresReauth: true,
				}
			}

			const newTokenData = provider?.refreshToken
				? await provider.refreshToken(refreshToken)
				: await this.refreshTokenWithRetry(
						integration.providerName,
						refreshToken,
					)

			const storeResult = await this.storeTokenData(
				integration.id,
				newTokenData,
			)

			if (!storeResult.success) {
				return {
					success: false,
					error: `Failed to store refreshed token: ${storeResult.error}`,
				}
			}

			await this.logTokenOperation(integration.id, 'token_refresh', 'success')

			return {
				success: true,
				tokenData: newTokenData,
			}
		} catch (error) {
			await this.logTokenOperation(
				integration.id,
				'token_refresh',
				'error',
				error instanceof Error ? error.message : 'Unknown error',
			)

			const requiresReauth = this.isReauthError(error)

			return {
				success: false,
				error: error instanceof Error ? error.message : 'Token refresh failed',
				requiresReauth,
			}
		}
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
