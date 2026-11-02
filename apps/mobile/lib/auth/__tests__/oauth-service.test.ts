import * as AuthSession from 'expo-auth-session'
import * as Linking from 'expo-linking'
import * as SecureStore from 'expo-secure-store'
import {
	OAuthService,
	OAUTH_PROVIDERS,
	createOAuthService,
} from '../oauth-service'

const mockAuthSession = AuthSession as jest.Mocked<typeof AuthSession>
const mockLinking = Linking as jest.Mocked<typeof Linking>

describe('OAuthService', () => {
	let oauthService: OAuthService
	const mockConfig = {
		providers: {
			github: {
				...OAUTH_PROVIDERS.github,
				clientId: 'test-github-client-id',
			},
			google: {
				...OAUTH_PROVIDERS.google,
				clientId: 'test-google-client-id',
			},
		},
		redirectUri: 'epicnotes://auth/callback',
	}

	beforeEach(() => {
		jest.clearAllMocks()
		oauthService = new OAuthService(mockConfig)

		// Mock AuthSession.makeRedirectUri
		mockAuthSession.makeRedirectUri.mockReturnValue('epicnotes://auth/callback')
	})

	describe('getRedirectUri', () => {
		it('should return web redirect URI for web platform', () => {
			// Mock Platform.OS for web
			jest.doMock('react-native', () => ({
				Platform: { OS: 'web' },
			}))

			// Mock window.location for web
			Object.defineProperty(window, 'location', {
				value: { origin: 'http://localhost:3000' },
				writable: true,
			})

			const redirectUri = OAuthService.getRedirectUri()
			expect(redirectUri).toBe('http://localhost:3000/auth/callback')
		})

		it('should return native redirect URI for native platforms', () => {
			jest.doMock('react-native', () => ({
				Platform: { OS: 'ios' },
			}))

			OAuthService.getRedirectUri()
			expect(mockAuthSession.makeRedirectUri).toHaveBeenCalledWith({
				scheme: 'epicnotes',
				path: 'auth/callback',
			})
		})
	})

	describe('authenticate', () => {
		it('should successfully authenticate with GitHub', async () => {
			const mockRequest = {
				promptAsync: jest.fn().mockResolvedValue({
					type: 'success',
					params: {
						code: 'test-auth-code',
						state: 'test-state',
					},
				}),
			}

			mockAuthSession.AuthRequest.mockImplementation(
				() => mockRequest as unknown as AuthSession.AuthRequest,
			)

			const result = await oauthService.authenticate('github', 'test-state')

			expect(mockAuthSession.AuthRequest).toHaveBeenCalledWith({
				clientId: 'test-github-client-id',
				scopes: ['user:email'],
				redirectUri: 'epicnotes://auth/callback',
				responseType: AuthSession.ResponseType.Code,
				state: 'test-state',
				additionalParameters: {
					allow_signup: 'true',
				},
			})

			expect(result).toEqual({
				success: true,
				code: 'test-auth-code',
				state: 'test-state',
			})
		})

		it('should successfully authenticate with Google', async () => {
			const mockRequest = {
				promptAsync: jest.fn().mockResolvedValue({
					type: 'success',
					params: {
						code: 'test-auth-code',
						state: 'test-state',
					},
				}),
			}

			mockAuthSession.AuthRequest.mockImplementation(
				() => mockRequest as unknown as AuthSession.AuthRequest,
			)

			const result = await oauthService.authenticate('google', 'test-state')

			expect(mockAuthSession.AuthRequest).toHaveBeenCalledWith({
				clientId: 'test-google-client-id',
				scopes: ['openid', 'profile', 'email'],
				redirectUri: 'epicnotes://auth/callback',
				responseType: AuthSession.ResponseType.Code,
				state: 'test-state',
				additionalParameters: {
					access_type: 'offline',
					prompt: 'consent',
				},
			})

			expect(result).toEqual({
				success: true,
				code: 'test-auth-code',
				state: 'test-state',
			})
		})

		it('should handle authentication error', async () => {
			const mockRequest = {
				promptAsync: jest.fn().mockResolvedValue({
					type: 'error',
					params: {
						error: 'access_denied',
						error_description: 'User denied access',
					},
				}),
			}

			mockAuthSession.AuthRequest.mockImplementation(
				() => mockRequest as unknown as AuthSession.AuthRequest,
			)

			const result = await oauthService.authenticate('github')

			expect(result).toEqual({
				success: false,
				error: 'access_denied',
				errorDescription: 'User denied access',
			})
		})

		it('should handle user cancellation', async () => {
			const mockRequest = {
				promptAsync: jest.fn().mockResolvedValue({
					type: 'cancel',
				}),
			}

			mockAuthSession.AuthRequest.mockImplementation(
				() => mockRequest as unknown as AuthSession.AuthRequest,
			)

			const result = await oauthService.authenticate('github')

			expect(result).toEqual({
				success: false,
				error: 'user_cancelled',
				errorDescription: 'User cancelled the authentication flow',
			})
		})

		it('should handle unknown provider', async () => {
			const result = await oauthService.authenticate('unknown-provider')

			expect(result).toEqual({
				success: false,
				error: 'oauth_error',
				errorDescription: "OAuth provider 'unknown-provider' not configured",
			})
		})

		it('should handle authentication exception', async () => {
			const mockRequest = {
				promptAsync: jest.fn().mockRejectedValue(new Error('Network error')),
			}

			mockAuthSession.AuthRequest.mockImplementation(
				() => mockRequest as unknown as AuthSession.AuthRequest,
			)

			const result = await oauthService.authenticate('github')

			expect(result).toEqual({
				success: false,
				error: 'oauth_error',
				errorDescription: 'Network error',
			})
		})
	})

	describe('handleCallback', () => {
		it('should successfully handle callback with code', async () => {
			jest
				.mocked(SecureStore.getItemAsync)
				.mockResolvedValue(
					JSON.stringify({ state: 'test-state', codeVerifier: 'verifier' }),
				)
			mockLinking.parse.mockReturnValue({
				scheme: 'epicnotes',
				hostname: 'auth',
				path: 'callback',
				queryParams: {
					code: 'test-auth-code',
					state: 'test-state',
				},
			} as Linking.ParsedURL)

			const result = await oauthService.handleCallback(
				'epicnotes://auth/callback?code=test-auth-code&state=test-state',
			)

			expect(result).toEqual({
				success: true,
				code: 'test-auth-code',
				state: 'test-state',
				codeVerifier: 'verifier',
			})
		})

		it('rejects a callback whose state was not started on this device', async () => {
			jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null)
			mockLinking.parse.mockReturnValue({
				scheme: 'epicnotes',
				hostname: 'auth',
				path: 'callback',
				queryParams: { code: 'test-auth-code', state: 'other-state' },
			} as Linking.ParsedURL)

			const result = await oauthService.handleCallback(
				'epicnotes://auth/callback?code=test-auth-code&state=other-state',
			)

			expect(result.success).toBe(false)
			expect(result.error).toBe('state_mismatch')
		})

		it('should handle callback error', async () => {
			mockLinking.parse.mockReturnValue({
				scheme: 'epicnotes',
				hostname: 'auth',
				path: 'callback',
				queryParams: {
					error: 'access_denied',
					error_description: 'User denied access',
				},
			} as Linking.ParsedURL)

			const result = await oauthService.handleCallback(
				'epicnotes://auth/callback?error=access_denied',
			)

			expect(result).toEqual({
				success: false,
				error: 'access_denied',
				errorDescription: 'User denied access',
			})
		})

		it('should handle invalid callback', async () => {
			mockLinking.parse.mockReturnValue({
				scheme: 'epicnotes',
				hostname: 'auth',
				path: 'callback',
				queryParams: {},
			} as Linking.ParsedURL)

			const result = await oauthService.handleCallback(
				'epicnotes://auth/callback',
			)

			expect(result).toEqual({
				success: false,
				error: 'invalid_callback',
				errorDescription: 'Invalid callback URL parameters',
			})
		})

		it('should handle callback parsing error', async () => {
			mockLinking.parse.mockImplementation(() => {
				throw new Error('Invalid URL')
			})

			const result = await oauthService.handleCallback('invalid-url')

			expect(result).toEqual({
				success: false,
				error: 'callback_error',
				errorDescription: 'Invalid URL',
			})
		})
	})

	describe('provider management', () => {
		it('should get provider configuration', () => {
			const provider = oauthService.getProvider('github')
			expect(provider).toEqual(mockConfig.providers.github)
		})

		it('should return undefined for unknown provider', () => {
			const provider = oauthService.getProvider('unknown')
			expect(provider).toBeUndefined()
		})

		it('should get all provider names', () => {
			const names = oauthService.getProviderNames()
			expect(names).toEqual(['github', 'google'])
		})

		it('should check if provider is configured', () => {
			expect(oauthService.isProviderConfigured('github')).toBe(true)
			expect(oauthService.isProviderConfigured('unknown')).toBe(false)
		})
	})

	describe('createOAuthService', () => {
		beforeEach(() => {
			// Mock environment variables
			process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID = 'env-github-client-id'
			process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID = 'env-google-client-id'
		})

		afterEach(() => {
			delete process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID
			delete process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID
		})

		it('should create service with environment variables', () => {
			const service = createOAuthService()

			expect(service.isProviderConfigured('github')).toBe(true)
			expect(service.isProviderConfigured('google')).toBe(true)

			const githubProvider = service.getProvider('github')
			expect(githubProvider?.clientId).toBe('env-github-client-id')

			const googleProvider = service.getProvider('google')
			expect(googleProvider?.clientId).toBe('env-google-client-id')
		})

		it('should create service without unconfigured providers', () => {
			delete process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID
			delete process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID

			const service = createOAuthService()

			expect(service.isProviderConfigured('github')).toBe(false)
			expect(service.isProviderConfigured('google')).toBe(false)
			expect(service.getProviderNames()).toEqual([])
		})
	})
})
