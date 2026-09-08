/**
 * OAuth flow management system for third-party integrations
 *
 * This module provides utilities for managing OAuth flows including:
 * - State generation and validation
 * - Generic OAuth callback handling
 * - Token refresh with retry logic
 */

import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'crypto'
import { ENV } from './env.js'
import { providerRegistry } from './provider'
import {
	type TokenData,
	type OAuthState,
	type OAuthCallbackParams,
} from './types'

/**
 * OAuth state management utilities
 */
export class OAuthStateManager {
	private static readonly STATE_EXPIRY_MINUTES = 30
	private static consumedNonces = new Map<string, number>()

	static clearConsumedNonces(): void {
		this.consumedNonces.clear()
	}

	private static cleanExpiredNonces(): void {
		const now = Date.now()
		const maxAge = this.STATE_EXPIRY_MINUTES * 60 * 1000
		for (const [nonce, timestamp] of this.consumedNonces.entries()) {
			if (now - timestamp > maxAge) {
				this.consumedNonces.delete(nonce)
			}
		}
	}

	private static getHmacKey(): string {
		const key = ENV.INTEGRATIONS_OAUTH_STATE_SECRET
		if (!key) {
			throw new Error(
				'INTEGRATIONS_OAUTH_STATE_SECRET environment variable is required for OAuth security',
			)
		}
		return key
	}

	private static signPayload(payloadString: string): string {
		return pbkdf2Sync(
			payloadString,
			this.getHmacKey(),
			1000,
			32,
			'sha256',
		).toString('hex')
	}

	/**
	 * Generate a secure OAuth state string
	 * @param organizationId - Organization ID
	 * @param providerName - Provider name
	 * @param redirectUrl - Optional redirect URL after OAuth completion
	 * @param additionalData - Additional data to include in state
	 * @returns Secure state string
	 */
	static generateState(
		organizationId: string,
		providerName: string,
		redirectUrl?: string,
		additionalData?: Record<string, any>,
	): string {
		const stateData: OAuthState = {
			organizationId,
			providerName,
			redirectUrl,
			timestamp: Date.now(),
			nonce: randomBytes(16).toString('hex'),
			...additionalData,
		}

		// Create state payload
		const statePayload = Buffer.from(JSON.stringify(stateData)).toString(
			'base64',
		)

		// Create HMAC signature to prevent tampering
		const signature = this.signPayload(statePayload)

		// Combine payload and signature
		return `${statePayload}.${signature}`
	}

	/**
	 * Validate and parse OAuth state
	 * @param state - State string to validate
	 * @param consumeNonce - Whether to mark nonce as consumed
	 * @returns Parsed state data
	 * @throws Error if state is invalid or expired
	 */
	static validateState(state: string, consumeNonce = true): OAuthState {
		if (!state || typeof state !== 'string') {
			throw new Error('Invalid state: empty or non-string')
		}

		const parts = state.split('.')
		if (parts.length !== 2) {
			throw new Error('Invalid state: malformed structure')
		}

		const [statePayload, signature] = parts

		if (!statePayload || !signature) {
			throw new Error('Invalid state: missing payload or signature')
		}

		// Verify HMAC signature using timingSafeEqual
		const expectedSignature = this.signPayload(statePayload)
		const sigBuf = Buffer.from(signature)
		const expectedBuf = Buffer.from(expectedSignature)

		const isSignatureValid =
			sigBuf.length === expectedBuf.length &&
			timingSafeEqual(sigBuf, expectedBuf)

		if (!isSignatureValid) {
			throw new Error('Invalid state: signature verification failed')
		}

		// Parse state data
		let stateData: OAuthState
		try {
			const decoded = Buffer.from(statePayload, 'base64').toString('utf8')
			stateData = JSON.parse(decoded) as OAuthState
		} catch (error) {
			throw new Error(`Invalid state: failed to parse data: ${error}`)
		}

		// Validate required fields
		if (
			!stateData.organizationId ||
			!stateData.providerName ||
			!stateData.timestamp
		) {
			throw new Error('Invalid state: missing required fields')
		}

		// Check timestamp is not in the future
		if (stateData.timestamp > Date.now()) {
			throw new Error('Invalid state: timestamp is in the future')
		}

		// Check expiration
		const maxAge = this.STATE_EXPIRY_MINUTES * 60 * 1000
		if (Date.now() - stateData.timestamp > maxAge) {
			throw new Error('Invalid state: expired')
		}

		if (stateData.nonce) {
			this.cleanExpiredNonces()
			if (this.consumedNonces.has(stateData.nonce)) {
				throw new Error(
					'Invalid state: nonce already consumed (replay detected)',
				)
			}
			if (consumeNonce) {
				this.consumedNonces.set(stateData.nonce, Date.now())
			}
		}

		return stateData
	}
}

/**
 * Generic OAuth callback handler
 */
export class OAuthCallbackHandler {
	/**
	 * Handle OAuth callback from provider
	 * @param providerName - Name of the provider
	 * @param params - OAuth callback parameters
	 * @returns Token data from successful OAuth flow
	 * @throws Error if callback handling fails
	 */
	static async handleCallback(
		providerName: string,
		params: OAuthCallbackParams,
	): Promise<{
		tokenData: TokenData
		stateData: OAuthState
	}> {
		// Check for OAuth errors
		if (params.error) {
			const errorMsg = params.errorDescription || params.error
			throw new Error(`OAuth error: ${errorMsg}`)
		}

		// Validate required parameters
		if (!params.code || !params.state) {
			throw new Error('Missing required OAuth parameters: code or state')
		}

		// Validate state
		const stateData = OAuthStateManager.validateState(params.state)

		// Verify provider name matches
		if (stateData.providerName !== providerName) {
			throw new Error('Provider name mismatch in OAuth state')
		}

		// Verify organization ID matches (if provided in params)
		if (
			params.organizationId &&
			stateData.organizationId !== params.organizationId
		) {
			throw new Error('Organization ID mismatch in OAuth state')
		}

		// Get provider and handle callback
		const provider = providerRegistry.get(providerName)
		const tokenData = await provider.handleCallback(params)

		return {
			tokenData,
			stateData,
		}
	}

	/**
	 * Generate OAuth authorization URL
	 * @param organizationId - Organization ID
	 * @param providerName - Provider name
	 * @param redirectUri - OAuth callback URI
	 * @param additionalParams - Additional provider-specific parameters
	 * @returns Authorization URL
	 */
	static async generateAuthUrl(
		organizationId: string,
		providerName: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string> {
		const provider = providerRegistry.get(providerName)
		return provider.getAuthUrl(organizationId, redirectUri, additionalParams)
	}
}
