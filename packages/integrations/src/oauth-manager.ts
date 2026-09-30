/**
 * OAuth flow management system for third-party integrations
 */

import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'crypto'
import { ENV } from './package-env.js'
import { providerRegistry } from './provider'
import {
	consumeOAuthNonce,
	isOAuthNonceConsumed,
	registerOAuthNonce,
} from './oauth-nonce-store.ts'
import {
	type TokenData,
	type OAuthState,
	type OAuthCallbackParams,
} from './types'

export class OAuthStateManager {
	private static readonly STATE_EXPIRY_MINUTES = 30

	static clearConsumedNonces(): void {
		// Tests reset the nonce table via mock database helpers.
	}

	static async registerStateNonce(state: string): Promise<void> {
		const data = this.parseState(state)
		if (data.nonce) await registerOAuthNonce(data.nonce)
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

		const statePayload = Buffer.from(JSON.stringify(stateData)).toString(
			'base64url',
		)
		const signature = this.signPayload(statePayload)
		return `${statePayload}.${signature}`
	}

	/** Signature, expiry, and field checks without consuming the nonce. */
	static parseState(state: string): OAuthState {
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

		const expectedSignature = this.signPayload(statePayload)
		const sigBuf = Buffer.from(signature)
		const expectedBuf = Buffer.from(expectedSignature)
		const isSignatureValid =
			sigBuf.length === expectedBuf.length &&
			timingSafeEqual(sigBuf, expectedBuf)

		if (!isSignatureValid) {
			throw new Error('Invalid state: signature verification failed')
		}

		let stateData: OAuthState
		try {
			const decoded = Buffer.from(statePayload, 'base64url').toString('utf8')
			stateData = JSON.parse(decoded) as OAuthState
		} catch (error) {
			throw new Error(`Invalid state: failed to parse data: ${error}`)
		}

		if (
			!stateData.organizationId ||
			!stateData.providerName ||
			!stateData.timestamp
		) {
			throw new Error('Invalid state: missing required fields')
		}

		if (stateData.timestamp > Date.now()) {
			throw new Error('Invalid state: timestamp is in the future')
		}

		const maxAge = this.STATE_EXPIRY_MINUTES * 60 * 1000
		if (Date.now() - stateData.timestamp > maxAge) {
			throw new Error('Invalid state: expired')
		}

		return stateData
	}

	static async validateState(
		state: string,
		consumeNonce = true,
	): Promise<OAuthState> {
		const stateData = this.parseState(state)

		if (stateData.nonce) {
			if (consumeNonce) {
				const consumed = await consumeOAuthNonce(stateData.nonce)
				if (!consumed) {
					throw new Error(
						'Invalid state: nonce already consumed (replay detected)',
					)
				}
			} else if (await isOAuthNonceConsumed(stateData.nonce)) {
				// Peeking is allowed after consumption (duplicate callback handling).
			}
		}

		return stateData
	}
}

export class OAuthCallbackHandler {
	static async handleCallback(
		providerName: string,
		params: OAuthCallbackParams,
	): Promise<{
		tokenData: TokenData
		stateData: OAuthState
	}> {
		if (params.error) {
			const errorMsg = params.errorDescription || params.error
			throw new Error(`OAuth error: ${errorMsg}`)
		}

		if (!params.code || !params.state) {
			throw new Error('Missing required OAuth parameters: code or state')
		}

		const stateData = await OAuthStateManager.validateState(params.state)

		if (stateData.providerName !== providerName) {
			throw new Error('Provider name mismatch in OAuth state')
		}

		if (
			params.organizationId &&
			stateData.organizationId !== params.organizationId
		) {
			throw new Error('Organization ID mismatch in OAuth state')
		}

		const provider = providerRegistry.get(providerName)
		const tokenData = await provider.handleCallback(params)

		return { tokenData, stateData }
	}

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
