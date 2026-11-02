import * as AuthSession from 'expo-auth-session'
import Constants from 'expo-constants'
import * as Crypto from 'expo-crypto'
import * as Linking from 'expo-linking'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

const OAUTH_PENDING_KEY = 'oauth_pending'
const WEB_PENDING_PREFIX = 'oauth:pending:'

type OAuthPending = {
	state: string
	codeVerifier: string | null
}

async function deriveOAuthPendingKey(state: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`epic-oauth-pending:${state}`),
	)
	return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt',
	])
}

async function encryptOAuthPending(pending: OAuthPending): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const key = await deriveOAuthPendingKey(pending.state)
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(
			JSON.stringify({ codeVerifier: pending.codeVerifier }),
		),
	)
	const packed = new Uint8Array(iv.length + ciphertext.byteLength)
	packed.set(iv)
	packed.set(new Uint8Array(ciphertext), iv.length)
	let binary = ''
	for (const byte of packed) binary += String.fromCharCode(byte)
	return btoa(binary)
}

async function decryptOAuthPending(
	state: string,
	payload: string,
): Promise<OAuthPending | null> {
	try {
		const packed = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
		const iv = packed.slice(0, 12)
		const data = packed.slice(12)
		const key = await deriveOAuthPendingKey(state)
		const plain = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			key,
			data,
		)
		const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
			codeVerifier?: string | null
		}
		return {
			state,
			codeVerifier:
				typeof parsed.codeVerifier === 'string' ? parsed.codeVerifier : null,
		}
	} catch {
		return null
	}
}

async function setOAuthPending(pending: OAuthPending) {
	if (Platform.OS === 'web') {
		const encrypted = await encryptOAuthPending(pending)
		sessionStorage.setItem(`${WEB_PENDING_PREFIX}${pending.state}`, encrypted)
		return
	}
	await SecureStore.setItemAsync(OAUTH_PENDING_KEY, JSON.stringify(pending))
}

async function getOAuthPending(state: string): Promise<OAuthPending | null> {
	if (Platform.OS === 'web') {
		const payload = sessionStorage.getItem(`${WEB_PENDING_PREFIX}${state}`)
		if (!payload) return null
		return decryptOAuthPending(state, payload)
	}
	const stored = await SecureStore.getItemAsync(OAUTH_PENDING_KEY)
	if (!stored) return null
	const parsed = JSON.parse(stored) as OAuthPending
	if (parsed.state !== state) return null
	return parsed
}

async function clearOAuthPending(state: string) {
	if (Platform.OS === 'web') {
		sessionStorage.removeItem(`${WEB_PENDING_PREFIX}${state}`)
		return
	}
	await SecureStore.deleteItemAsync(OAUTH_PENDING_KEY)
}

export interface OAuthProvider {
	name: string
	displayName: string
	authorizationEndpoint: string
	tokenEndpoint: string
	clientId: string
	scopes: string[]
	additionalParameters?: Record<string, string>
}

export interface OAuthResult {
	success: boolean
	code?: string
	state?: string
	codeVerifier?: string
	error?: string
	errorDescription?: string
}

export interface OAuthConfig {
	providers: Record<string, OAuthProvider>
	redirectUri: string
}

/**
 * OAuth service for handling social authentication flows using Expo AuthSession
 */
export class OAuthService {
	private config: OAuthConfig
	private discovery: Record<string, AuthSession.DiscoveryDocument> = {}

	constructor(config: OAuthConfig) {
		this.config = config
	}

	/**
	 * Get the redirect URI for OAuth callbacks
	 */
	static getRedirectUri(): string {
		if (Platform.OS === 'web') {
			return `${window.location.origin}/auth/callback`
		}

		// For native apps, use the app scheme
		const scheme = Constants.expoConfig?.scheme
		const schemeString = Array.isArray(scheme)
			? scheme[0]
			: scheme || 'epicnotes'

		return AuthSession.makeRedirectUri({
			scheme: schemeString,
			path: 'auth/callback',
		})
	}

	/**
	 * Initialize OAuth provider discovery documents
	 */
	async initializeProvider(providerName: string): Promise<void> {
		const provider = this.config.providers[providerName]
		if (!provider) {
			throw new Error(`OAuth provider '${providerName}' not configured`)
		}

		if (!this.discovery[providerName]) {
			this.discovery[providerName] = {
				authorizationEndpoint: provider.authorizationEndpoint,
				tokenEndpoint: provider.tokenEndpoint,
			}
		}
	}

	/**
	 * Start OAuth authentication flow for a provider
	 */
	async authenticate(
		providerName: string,
		state?: string,
	): Promise<OAuthResult> {
		try {
			await this.initializeProvider(providerName)

			const provider = this.config.providers[providerName]
			const discovery = this.discovery[providerName]

			if (!discovery) {
				throw new Error(`Provider '${providerName}' not initialized`)
			}

			// Create the authorization request
			const oauthState = state || this.generateState()
			const request = new AuthSession.AuthRequest({
				clientId: provider.clientId,
				scopes: provider.scopes,
				redirectUri: this.config.redirectUri,
				responseType: AuthSession.ResponseType.Code,
				state: oauthState,
				extraParams: provider.additionalParameters,
				usePKCE: true,
			})

			await setOAuthPending({
				state: oauthState,
				codeVerifier: request.codeVerifier ?? null,
			})

			// Start the authentication session
			const result = await request.promptAsync(discovery)

			if (result.type === 'success') {
				if (result.params.state !== oauthState) {
					return {
						success: false,
						error: 'state_mismatch',
						errorDescription: 'OAuth state did not match this device',
					}
				}
				await setOAuthPending({
					state: oauthState,
					codeVerifier: request.codeVerifier ?? null,
				})
				return {
					success: true,
					code: result.params.code,
					state: result.params.state,
					codeVerifier: request.codeVerifier,
				}
			} else if (result.type === 'error') {
				return {
					success: false,
					error: result.params.error || 'authentication_failed',
					errorDescription:
						result.params.error_description || 'OAuth authentication failed',
				}
			} else {
				// User cancelled or dismissed
				return {
					success: false,
					error: 'user_cancelled',
					errorDescription: 'User cancelled the authentication flow',
				}
			}
		} catch (error) {
			return {
				success: false,
				error: 'oauth_error',
				errorDescription:
					error instanceof Error ? error.message : 'Unknown OAuth error',
			}
		}
	}

	/**
	 * Handle OAuth callback URL (for deep linking)
	 */
	async handleCallback(url: string): Promise<OAuthResult> {
		try {
			const { queryParams } = Linking.parse(url)

			if (queryParams?.error) {
				return {
					success: false,
					error: queryParams.error as string,
					errorDescription: queryParams.error_description as string,
				}
			}

			if (queryParams?.code) {
				if (typeof queryParams.state !== 'string') {
					return {
						success: false,
						error: 'state_mismatch',
						errorDescription: 'OAuth state did not match this device',
					}
				}
				const pending = await getOAuthPending(queryParams.state)
				if (!pending || pending.state !== queryParams.state) {
					return {
						success: false,
						error: 'state_mismatch',
						errorDescription: 'OAuth state did not match this device',
					}
				}
				await clearOAuthPending(queryParams.state)
				return {
					success: true,
					code: queryParams.code as string,
					state: queryParams.state,
					codeVerifier: pending.codeVerifier ?? undefined,
				}
			}

			return {
				success: false,
				error: 'invalid_callback',
				errorDescription: 'Invalid callback URL parameters',
			}
		} catch (error) {
			return {
				success: false,
				error: 'callback_error',
				errorDescription:
					error instanceof Error ? error.message : 'Callback handling error',
			}
		}
	}

	/**
	 * Generate a cryptographically secure random state parameter for CSRF protection
	 */
	private generateState(): string {
		return Crypto.randomUUID()
	}

	/**
	 * Get provider configuration
	 */
	getProvider(name: string): OAuthProvider | undefined {
		return this.config.providers[name]
	}

	/**
	 * Get all configured provider names
	 */
	getProviderNames(): string[] {
		return Object.keys(this.config.providers)
	}

	/**
	 * Check if a provider is configured
	 */
	isProviderConfigured(name: string): boolean {
		return (
			name in this.config.providers && !!this.config.providers[name].clientId
		)
	}
}

/**
 * OAuth provider configurations for supported providers
 */
export const OAUTH_PROVIDERS: Record<
	string,
	Omit<OAuthProvider, 'clientId'>
> = {
	github: {
		name: 'github',
		displayName: 'GitHub',
		authorizationEndpoint: 'https://github.com/login/oauth/authorize',
		tokenEndpoint: 'https://github.com/login/oauth/access_token',
		scopes: ['user:email'],
		additionalParameters: {
			allow_signup: 'true',
		},
	},
	google: {
		name: 'google',
		displayName: 'Google',
		authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenEndpoint: 'https://oauth2.googleapis.com/token',
		scopes: ['openid', 'profile', 'email'],
		additionalParameters: {
			access_type: 'offline',
			prompt: 'consent',
		},
	},
}

/**
 * Create OAuth service with default configuration
 */
export function createOAuthService(): OAuthService {
	const redirectUri = OAuthService.getRedirectUri()

	const providers: Record<string, OAuthProvider> = {}

	// Configure GitHub if client ID is available
	const githubClientId =
		Constants.expoConfig?.extra?.EXPO_PUBLIC_GITHUB_CLIENT_ID ||
		process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID
	if (githubClientId) {
		providers.github = {
			...OAUTH_PROVIDERS.github,
			clientId: githubClientId,
		}
	}

	// Configure Google if client ID is available
	const googleClientId =
		Constants.expoConfig?.extra?.EXPO_PUBLIC_GOOGLE_CLIENT_ID ||
		process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID
	if (googleClientId) {
		providers.google = {
			...OAUTH_PROVIDERS.google,
			clientId: googleClientId,
		}
	}

	return new OAuthService({
		providers,
		redirectUri,
	})
}

/**
 * Default OAuth service instance
 */
export const oauthService = createOAuthService()
