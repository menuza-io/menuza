/**
 * Token encryption and security utilities for third-party integrations
 *
 * This module provides secure encryption/decryption for OAuth tokens and other
 * sensitive integration data using the @repo/security encryption utilities.
 */

import { webcrypto as crypto } from 'node:crypto'
import {
	encryptAsync,
	decryptAsync,
	getEncryptionKey,
	isEncryptionConfigured as checkEncryptionConfigured,
	generateEncryptionKey,
} from '@repo/security'
import { type TokenData } from './types'

// Environment variable for encryption key
const ENCRYPTION_KEY_ENV = 'INTEGRATION_ENCRYPTION_KEY' as const

/** Ignore corrupt legacy expiry values (e.g. Unix seconds stored as ms). */
const MIN_SANE_TOKEN_EXPIRY_MS = Date.UTC(2020, 0, 1)

/**
 * Normalizes expiry timestamps from the DB or token payloads.
 */
export function coerceExpiresAt(raw: unknown): Date | undefined {
	if (raw == null) return undefined
	let date: Date
	if (raw instanceof Date) {
		date = raw
	} else if (typeof raw === 'number') {
		date = raw > 1_000_000_000_000 ? new Date(raw) : new Date(raw * 1000)
	} else if (typeof raw === 'string' && raw.trim()) {
		date = new Date(raw)
	} else {
		return undefined
	}
	if (Number.isNaN(date.getTime())) return new Date(0)
	if (date.getTime() < MIN_SANE_TOKEN_EXPIRY_MS) return new Date(0)
	return date
}

/**
 * Encrypted token data structure
 */
export interface EncryptedTokenData {
	encryptedAccessToken: string
	encryptedRefreshToken?: string
	expiresAt?: Date
	scope?: string
	iv: string // Kept for backward compatibility but not used
}

/**
 * Token validation result
 */
export interface TokenValidationResult {
	isValid: boolean
	isExpired: boolean
	expiresIn?: number // seconds until expiration
	needsRefresh: boolean // true if token expires within refresh threshold
}

/**
 * Encryption service for OAuth tokens and sensitive integration data
 * Now uses @repo/security encryption for consistency and better security
 */
export class IntegrationEncryptionService {
	private readonly refreshThreshold = 300 // 5 minutes in seconds

	/**
	 * Encrypt token data using @repo/security encryption
	 */
	async encryptTokenData(tokenData: TokenData): Promise<EncryptedTokenData> {
		if (!tokenData.accessToken) {
			throw new Error('Access token is required for encryption')
		}

		const key = getEncryptionKey(ENCRYPTION_KEY_ENV)

		// Encrypt access token
		const encryptedAccessToken = await encryptAsync(tokenData.accessToken, key)

		// Encrypt refresh token if present
		let encryptedRefreshToken: string | undefined
		if (tokenData.refreshToken) {
			encryptedRefreshToken = await encryptAsync(tokenData.refreshToken, key)
		}

		return {
			encryptedAccessToken,
			encryptedRefreshToken,
			expiresAt: tokenData.expiresAt,
			scope: tokenData.scope,
			iv: '', // Keep for backward compatibility but not used
		}
	}

	/**
	 * Decrypt token data using @repo/security decryption
	 */
	async decryptTokenData(
		encryptedData: EncryptedTokenData,
	): Promise<TokenData> {
		const key = getEncryptionKey(ENCRYPTION_KEY_ENV)

		// Decrypt access token
		const accessToken = await decryptAsync(
			encryptedData.encryptedAccessToken,
			key,
		)

		// Decrypt refresh token if present
		let refreshToken: string | undefined
		if (encryptedData.encryptedRefreshToken) {
			refreshToken = await decryptAsync(
				encryptedData.encryptedRefreshToken,
				key,
			)
		}

		return {
			accessToken,
			refreshToken,
			expiresAt: encryptedData.expiresAt,
			scope: encryptedData.scope,
		}
	}

	/**
	 * Validate token expiration and determine if refresh is needed
	 */
	validateToken(
		tokenData: TokenData | EncryptedTokenData,
	): TokenValidationResult {
		const now = new Date()
		const expiresAt = coerceExpiresAt(tokenData.expiresAt)

		// If no expiration date, assume token is valid but needs refresh check
		if (!expiresAt) {
			return {
				isValid: true,
				isExpired: false,
				needsRefresh: false,
			}
		}

		const isExpired = expiresAt <= now
		const expiresIn = Math.floor((expiresAt.getTime() - now.getTime()) / 1000)
		const needsRefresh = expiresIn <= this.refreshThreshold && expiresIn > 0

		return {
			isValid: !isExpired,
			isExpired,
			expiresIn: isExpired ? 0 : expiresIn,
			needsRefresh,
		}
	}

	/**
	 * Generate a secure random state for OAuth flows
	 */
	generateOAuthState(organizationId: string, providerName: string): string {
		const stateData = {
			organizationId,
			providerName,
			timestamp: Date.now(),
			nonce: crypto.randomUUID(),
		}

		return Buffer.from(JSON.stringify(stateData)).toString('base64url')
	}

	/**
	 * Validate and parse OAuth state
	 */
	validateOAuthState(
		state: string,
		maxAge: number = 600000,
	): { organizationId: string; providerName: string } {
		try {
			const stateData = JSON.parse(
				Buffer.from(state, 'base64url').toString(),
			) as {
				organizationId: string
				providerName: string
				timestamp: number
				nonce: `${string}-${string}-${string}-${string}-${string}`
			}

			if (
				!stateData.organizationId ||
				!stateData.providerName ||
				!stateData.timestamp
			) {
				throw new Error('Invalid state format')
			}

			const now = Date.now()

			if (stateData.timestamp > now) {
				throw new Error('OAuth state timestamp is in the future')
			}

			const age = now - stateData.timestamp
			if (age > maxAge) {
				throw new Error('OAuth state has expired')
			}

			return {
				organizationId: stateData.organizationId,
				providerName: stateData.providerName,
			}
		} catch {
			throw new Error('Invalid or expired OAuth state')
		}
	}

	/**
	 * Generate a secure encryption key for environment setup
	 * This is a utility method for initial setup - the key should be stored securely
	 */
	static generateEncryptionKey(): string {
		return generateEncryptionKey()
	}

	/**
	 * Securely compare two strings to prevent timing attacks
	 */
	secureCompare(a: string, b: string): boolean {
		if (a.length !== b.length) {
			return false
		}

		let result = 0
		for (let i = 0; i < a.length; i++) {
			result |= a.charCodeAt(i) ^ b.charCodeAt(i)
		}

		return result === 0
	}
}

/**
 * Singleton instance of the encryption service
 */
export const integrationEncryption = new IntegrationEncryptionService()

/**
 * Utility function to check if encryption is properly configured
 */
export function isEncryptionConfigured(): boolean {
	return checkEncryptionConfigured(ENCRYPTION_KEY_ENV)
}

/**
 * Utility function to generate a new encryption key for setup
 */
export function generateNewEncryptionKey(): string {
	return IntegrationEncryptionService.generateEncryptionKey()
}

/**
 * Simple utility function to encrypt a token string
 * @param token - Token to encrypt
 * @returns Promise resolving to encrypted token string
 */
export async function encryptToken(token: string): Promise<string> {
	const tokenData: TokenData = { accessToken: token }
	const encrypted = await integrationEncryption.encryptTokenData(tokenData)
	return encrypted.encryptedAccessToken
}

/**
 * Simple utility function to decrypt a token string
 * @param encryptedToken - Encrypted token string
 * @returns Promise resolving to decrypted token
 */
export async function decryptToken(encryptedToken: string): Promise<string> {
	const key = getEncryptionKey(ENCRYPTION_KEY_ENV)
	return await decryptAsync(encryptedToken, key)
}
