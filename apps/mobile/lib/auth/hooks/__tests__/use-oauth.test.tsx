import { renderHook, act } from '@testing-library/react-native'
import { oauthService, type OAuthResult } from '../../oauth-service'
import { useOAuth, useOAuthCallback, useOAuthProviders } from '../use-oauth'

// Mock dependencies
const mockSocialLogin = jest.fn()

jest.mock('../use-auth', () => ({
	useAuth: () => ({
		socialLogin: mockSocialLogin,
		user: null,
		tokens: null,
		isLoading: false,
		error: null,
		isAuthenticated: false,
		login: jest.fn(),
		signup: jest.fn(),
		verify: jest.fn(),
		onboarding: jest.fn(),
		logout: jest.fn(),
		refreshTokens: jest.fn(),
		clearError: jest.fn(),
	}),
}))

jest.mock('../../oauth-service', () => ({
	oauthService: {
		isProviderConfigured: jest.fn(),
		getProviderNames: jest.fn(),
		authenticate: jest.fn(),
		handleCallback: jest.fn(),
		getProvider: jest.fn(),
	},
}))

const mockOAuthService = oauthService as jest.Mocked<typeof oauthService>

describe('useOAuth', () => {
	beforeEach(() => {
		jest.clearAllMocks()

		mockOAuthService.isProviderConfigured.mockReturnValue(true)
		mockOAuthService.getProviderNames.mockReturnValue(['github', 'google'])
		mockOAuthService.authenticate.mockResolvedValue({
			success: true,
			code: 'test-auth-code',
			state: 'test-state',
		})
	})

	it('should initialize with correct default state', () => {
		const { result } = renderHook(() => useOAuth())

		expect(result.current.isLoading).toBe(false)
		expect(result.current.error).toBeNull()
		expect(result.current.availableProviders).toEqual(['github', 'google'])
	})

	it('should successfully authenticate with configured provider', async () => {
		const onSuccess = jest.fn()
		const onError = jest.fn()

		const { result } = renderHook(() =>
			useOAuth({
				onSuccess,
				onError,
				redirectTo: '/dashboard',
			}),
		)

		await act(async () => {
			await result.current.authenticate('github')
		})

		expect(mockOAuthService.authenticate).toHaveBeenCalledWith(
			'github',
			expect.any(String),
		)
		expect(mockSocialLogin).toHaveBeenCalledWith(
			'github',
			'test-auth-code',
			'test-state',
			'/dashboard',
		)
		expect(onSuccess).toHaveBeenCalledWith({
			success: true,
			code: 'test-auth-code',
			state: 'test-state',
		})
		expect(onError).not.toHaveBeenCalled()
	})

	it('should handle unconfigured provider', async () => {
		mockOAuthService.isProviderConfigured.mockReturnValue(false)

		const onError = jest.fn()
		const { result } = renderHook(() => useOAuth({ onError }))

		await act(async () => {
			await result.current.authenticate('github')
		})

		expect(result.current.error).toBe(
			"OAuth provider 'github' is not configured",
		)
		expect(onError).toHaveBeenCalledWith(
			"OAuth provider 'github' is not configured",
		)
		expect(mockOAuthService.authenticate).not.toHaveBeenCalled()
	})

	it('should handle OAuth authentication failure', async () => {
		mockOAuthService.authenticate.mockResolvedValue({
			success: false,
			error: 'access_denied',
			errorDescription: 'User denied access',
		})

		const onError = jest.fn()
		const { result } = renderHook(() => useOAuth({ onError }))

		await act(async () => {
			await result.current.authenticate('github')
		})

		expect(result.current.error).toBe('User denied access')
		expect(onError).toHaveBeenCalledWith('User denied access')
		expect(mockSocialLogin).not.toHaveBeenCalled()
	})

	it('should handle social login failure', async () => {
		mockSocialLogin.mockRejectedValue(new Error('Network error'))

		const onError = jest.fn()
		const { result } = renderHook(() => useOAuth({ onError }))

		await act(async () => {
			await result.current.authenticate('github')
		})

		expect(result.current.error).toBe('Network error')
		expect(onError).toHaveBeenCalledWith('Network error')
	})

	it('should clear error', () => {
		const { result } = renderHook(() => useOAuth())

		act(() => {
			result.current.clearError()
		})

		expect(result.current.error).toBeNull()
	})

	it('should check if provider is configured', () => {
		mockOAuthService.isProviderConfigured.mockImplementation(
			(provider) => provider === 'github',
		)

		const { result } = renderHook(() => useOAuth())

		expect(result.current.isProviderConfigured('github')).toBe(true)
		expect(result.current.isProviderConfigured('google')).toBe(false)
	})

	it('should show loading state during authentication', async () => {
		let resolveAuth: (value: OAuthResult) => void
		const authPromise = new Promise<OAuthResult>((resolve) => {
			resolveAuth = resolve
		})

		mockOAuthService.authenticate.mockReturnValue(authPromise)

		const { result } = renderHook(() => useOAuth())

		void act(async () => {
			await result.current.authenticate('github')
		})

		expect(result.current.isLoading).toBe(true)

		await act(async () => {
			resolveAuth({
				success: true,
				code: 'test-code',
				state: 'test-state',
			})
			await authPromise
		})

		expect(result.current.isLoading).toBe(false)
	})
})

describe('useOAuthCallback', () => {
	beforeEach(() => {
		jest.clearAllMocks()

		mockOAuthService.handleCallback.mockResolvedValue({
			success: true,
			code: 'test-auth-code',
			state: 'test-state',
		})
	})

	it('should successfully handle callback', async () => {
		const { result } = renderHook(() => useOAuthCallback())

		let callbackResult: OAuthResult | undefined
		await act(async () => {
			callbackResult = await result.current.handleCallback(
				'epicnotes://auth/callback?code=test-code',
				'github',
			)
		})

		expect(mockOAuthService.handleCallback).toHaveBeenCalledWith(
			'epicnotes://auth/callback?code=test-code',
		)
		expect(mockSocialLogin).toHaveBeenCalledWith(
			'github',
			'test-auth-code',
			'test-state',
			undefined,
			undefined,
		)
		expect(callbackResult).toEqual({ success: true })
	})

	it('should handle callback failure', async () => {
		mockOAuthService.handleCallback.mockResolvedValue({
			success: false,
			error: 'invalid_callback',
			errorDescription: 'Invalid callback parameters',
		})

		const { result } = renderHook(() => useOAuthCallback())

		let callbackResult: OAuthResult | undefined
		await act(async () => {
			callbackResult = await result.current.handleCallback(
				'epicnotes://auth/callback',
				'github',
			)
		})

		expect(callbackResult).toEqual({
			success: false,
			error: 'Invalid callback parameters',
		})
		expect(mockSocialLogin).not.toHaveBeenCalled()
	})

	it('should handle social login failure', async () => {
		mockSocialLogin.mockRejectedValue(new Error('Authentication failed'))

		const { result } = renderHook(() => useOAuthCallback())

		let callbackResult: OAuthResult | undefined
		await act(async () => {
			callbackResult = await result.current.handleCallback(
				'epicnotes://auth/callback?code=test-code',
				'github',
			)
		})

		expect(callbackResult).toEqual({
			success: false,
			error: 'Authentication failed',
		})
	})

	it('should show processing state', async () => {
		let resolveCallback: (value: OAuthResult) => void
		const callbackPromise = new Promise<OAuthResult>((resolve) => {
			resolveCallback = resolve
		})

		mockOAuthService.handleCallback.mockReturnValue(callbackPromise)

		const { result } = renderHook(() => useOAuthCallback())

		void act(async () => {
			await result.current.handleCallback(
				'epicnotes://auth/callback?code=test-code',
				'github',
			)
		})

		expect(result.current.isProcessing).toBe(true)

		await act(async () => {
			resolveCallback({
				success: true,
				code: 'test-code',
				state: 'test-state',
			})
			await callbackPromise
		})

		expect(result.current.isProcessing).toBe(false)
	})
})

describe('useOAuthProviders', () => {
	beforeEach(() => {
		jest.clearAllMocks()

		mockOAuthService.getProviderNames.mockReturnValue(['github', 'google'])
		mockOAuthService.isProviderConfigured.mockImplementation(
			(provider) => provider === 'github',
		)
		mockOAuthService.getProvider.mockImplementation((provider) => {
			if (provider === 'github') {
				return {
					name: 'github',
					displayName: 'GitHub',
					authorizationEndpoint: 'https://github.com/login/oauth/authorize',
					tokenEndpoint: 'https://github.com/login/oauth/access_token',
					clientId: 'test-client-id',
					scopes: ['user:email'],
				}
			}
			return undefined
		})
	})

	it('should return available and configured providers', () => {
		const { result } = renderHook(() => useOAuthProviders())

		expect(result.current.availableProviders).toEqual(['github', 'google'])
		expect(result.current.configuredProviders).toEqual(['github'])
	})

	it('should get provider info', () => {
		const { result } = renderHook(() => useOAuthProviders())

		const githubInfo = result.current.getProviderInfo('github')
		expect(githubInfo).toEqual({
			name: 'github',
			displayName: 'GitHub',
			isConfigured: true,
		})

		const unknownInfo = result.current.getProviderInfo('unknown')
		expect(unknownInfo).toBeNull()
	})

	it('should check if provider is configured', () => {
		const { result } = renderHook(() => useOAuthProviders())

		expect(result.current.isProviderConfigured('github')).toBe(true)
		expect(result.current.isProviderConfigured('google')).toBe(false)
	})
})
