import * as Crypto from 'expo-crypto'
import { useState, useCallback } from 'react'
import { oauthService, type OAuthResult } from '../oauth-service'
import { useAuth } from './use-auth'

export interface UseOAuthOptions {
	onSuccess?: (result: OAuthResult) => void
	onError?: (error: string) => void
	redirectTo?: string
}

export interface UseOAuthReturn {
	authenticate: (provider: string) => Promise<void>
	isLoading: boolean
	error: string | null
	clearError: () => void
	availableProviders: string[]
	isProviderConfigured: (provider: string) => boolean
}

/**
 * Hook for handling OAuth authentication flows
 */
export function useOAuth(options: UseOAuthOptions = {}): UseOAuthReturn {
	const [isLoading, setIsLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const { socialLogin } = useAuth()

	const authenticate = useCallback(
		async (provider: string) => {
			if (!oauthService.isProviderConfigured(provider)) {
				const errorMessage = `OAuth provider '${provider}' is not configured`
				setError(errorMessage)
				options.onError?.(errorMessage)
				return
			}

			setIsLoading(true)
			setError(null)

			try {
				// Generate state parameter for CSRF protection using crypto
				const state = Crypto.randomUUID()

				// Start OAuth flow
				const result = await oauthService.authenticate(provider, state)

				if (result.success && result.code) {
					// Use the auth context to handle the OAuth callback
					await socialLogin(
						provider,
						result.code,
						result.state,
						options.redirectTo,
						result.codeVerifier,
					)
					options.onSuccess?.(result)
				} else {
					const errorMessage =
						result.errorDescription ||
						`OAuth authentication failed for ${provider}`
					setError(errorMessage)
					options.onError?.(errorMessage)
				}
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : 'OAuth authentication failed'
				setError(errorMessage)
				options.onError?.(errorMessage)
			} finally {
				setIsLoading(false)
			}
		},
		[socialLogin, options],
	)

	const clearError = useCallback(() => {
		setError(null)
	}, [])

	const availableProviders = oauthService.getProviderNames()

	const isProviderConfigured = useCallback((provider: string) => {
		return oauthService.isProviderConfigured(provider)
	}, [])

	return {
		authenticate,
		isLoading,
		error,
		clearError,
		availableProviders,
		isProviderConfigured,
	}
}

/**
 * Hook for handling OAuth callback URLs (for deep linking)
 */
export function useOAuthCallback() {
	const [isProcessing, setIsProcessing] = useState(false)
	const { socialLogin } = useAuth()

	const handleCallback = useCallback(
		async (url: string, provider: string) => {
			setIsProcessing(true)

			try {
				const result = await oauthService.handleCallback(url)

				if (result.success && result.code) {
					await socialLogin(
						provider,
						result.code,
						result.state,
						undefined,
						result.codeVerifier,
					)
					return { success: true }
				} else {
					return {
						success: false,
						error: result.errorDescription || 'OAuth callback failed',
					}
				}
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : 'OAuth callback failed',
				}
			} finally {
				setIsProcessing(false)
			}
		},
		[socialLogin],
	)

	return {
		handleCallback,
		isProcessing,
	}
}

/**
 * Hook for getting OAuth provider information
 */
export function useOAuthProviders() {
	const availableProviders = oauthService.getProviderNames()

	const getProviderInfo = useCallback((provider: string) => {
		const config = oauthService.getProvider(provider)
		return config
			? {
					name: config.name,
					displayName: config.displayName,
					isConfigured: !!config.clientId,
				}
			: null
	}, [])

	const configuredProviders = availableProviders.filter((provider) =>
		oauthService.isProviderConfigured(provider),
	)

	return {
		availableProviders,
		configuredProviders,
		getProviderInfo,
		isProviderConfigured: oauthService.isProviderConfigured.bind(oauthService),
	}
}
