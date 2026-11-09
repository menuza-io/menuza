/**
 * Tests for GitLabProvider
 */

import dns from 'node:dns'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../setup'
import { GitLabProvider } from '../../../src/providers/gitlab/provider'
import type { MessageData } from '../../../src/types'

// Mock the encryption module
vi.mock('../../../src/encryption', async () => {
	const actual = await vi.importActual('../../../src/encryption')
	return {
		...actual,
		decryptToken: vi.fn().mockResolvedValue('access-token'),
	}
})

import { decryptToken } from '../../../src/encryption'

describe('GitLabProvider', () => {
	let provider: GitLabProvider

	beforeEach(() => {
		// Set required environment variables
		process.env.GITLAB_CLIENT_ID = 'test-client-id'
		process.env.GITLAB_CLIENT_SECRET = 'test-client-secret'

		provider = new GitLabProvider()
		vi.clearAllMocks()
		// The SSRF check resolves each host it fetches: answer with a public
		// address so no test depends on network DNS.
		vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['93.184.216.34'])
		vi.spyOn(dns.promises, 'resolve6').mockResolvedValue([])

		// Reset the mock for decryptToken
		vi.mocked(decryptToken).mockResolvedValue('access-token')
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('Provider Properties', () => {
		it('should have correct provider properties', () => {
			expect(provider.name).toBe('gitlab')
			expect(provider.type).toBe('productivity')
			expect(provider.displayName).toBe('GitLab')
			expect(provider.description).toBe(
				'Connect notes to GitLab projects for issue tracking and project management',
			)
		})
	})

	describe('getAuthUrl', () => {
		it('should generate correct auth URL', async () => {
			const organizationId = 'org-123'
			const redirectUri = 'https://example.com/callback'

			const authUrl = await provider.getAuthUrl(organizationId, redirectUri)

			expect(authUrl).toContain('https://gitlab.com/oauth/authorize')
			expect(authUrl).toContain('client_id=')
			expect(authUrl).toContain('redirect_uri=')
			expect(authUrl).toContain('response_type=code')
			expect(authUrl).toContain('scope=')
			expect(authUrl).toContain('state=')
		})
	})

	describe('handleCallback', () => {
		it('should handle successful OAuth callback', async () => {
			// Generate a proper OAuth state using bracket notation to access protected method
			const state = (provider as any).generateOAuthState('org-123', {
				redirectUri: 'https://example.com/callback',
			})

			// Override MSW handlers for token exchange and user info
			server.use(
				http.post('https://gitlab.com/oauth/token', () => {
					return HttpResponse.json({
						access_token: 'gitlab-access-token',
						token_type: 'Bearer',
						expires_in: 7200,
						refresh_token: 'gitlab-refresh-token',
						scope: 'api read_user',
					})
				}),
				http.get('https://gitlab.com/api/v4/user', () => {
					return HttpResponse.json({
						id: 123,
						username: 'testuser',
						name: 'Test User',
						email: 'test@example.com',
						avatar_url: 'https://example.com/avatar.jpg',
						web_url: 'https://gitlab.com/testuser',
						state: 'active',
					})
				}),
			)

			const params = {
				organizationId: 'org-123',
				code: 'auth-code',
				state: state,
			}

			const tokenData = await provider.handleCallback(params)

			expect(tokenData.accessToken).toBe('gitlab-access-token')
			expect(tokenData.refreshToken).toBe('gitlab-refresh-token')
			expect(tokenData.expiresAt).toBeInstanceOf(Date)
			expect(tokenData.scope).toBe('api read_user')
			expect(tokenData.metadata).toEqual({
				instanceUrl: 'https://gitlab.com',
				user: {
					id: 123,
					username: 'testuser',
					name: 'Test User',
					email: 'test@example.com',
					avatarUrl: 'https://example.com/avatar.jpg',
				},
			})
		})

		it('should handle OAuth error response', async () => {
			const params = {
				organizationId: 'org-123',
				code: '',
				state: 'invalid-state',
				error: 'access_denied',
				errorDescription: 'User denied access',
			}

			await expect(provider.handleCallback(params)).rejects.toThrow(
				'GitLab OAuth error: access_denied - User denied access',
			)
		})
	})

	describe('refreshToken', () => {
		// As the OAuth flow stores a gitlab.com integration.
		const gitlabCom = {
			config: JSON.stringify({
				metadata: { instanceUrl: 'https://gitlab.com' },
			}),
		}

		it('refuses to refresh when the instance is unknown', async () => {
			const tokenEndpoint = vi.fn()
			server.use(
				http.post('https://gitlab.com/oauth/token', () => {
					tokenEndpoint()
					return HttpResponse.json({ access_token: 'x' })
				}),
			)
			await expect(
				provider.refreshToken!('old-refresh-token', { config: '{}' }),
			).rejects.toThrow('the instance is unknown')
			await expect(provider.refreshToken!('old-refresh-token')).rejects.toThrow(
				'the instance is unknown',
			)
			expect(tokenEndpoint).not.toHaveBeenCalled()
		})

		it('should refresh token successfully', async () => {
			// Override MSW handler for token refresh
			server.use(
				http.post('https://gitlab.com/oauth/token', () => {
					return HttpResponse.json({
						access_token: 'new-gitlab-access-token',
						token_type: 'Bearer',
						expires_in: 7200,
						refresh_token: 'new-gitlab-refresh-token',
						scope: 'api read_user',
					})
				}),
			)

			const newTokenData = await provider.refreshToken!(
				'old-refresh-token',
				gitlabCom,
			)

			expect(newTokenData.accessToken).toBe('new-gitlab-access-token')
			expect(newTokenData.refreshToken).toBe('new-gitlab-refresh-token')
			expect(newTokenData.expiresAt).toBeInstanceOf(Date)
			expect(newTokenData.scope).toBe('api read_user')
		})

		it('refreshes a self-hosted integration on its own instance', async () => {
			const gitlabComEndpoint = vi.fn()
			server.use(
				http.post('https://gitlab.com/oauth/token', () => {
					gitlabComEndpoint()
					return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 })
				}),
				http.post('https://gitlab.example.com/oauth/token', () =>
					HttpResponse.json({
						access_token: 'self-hosted-access-token',
						token_type: 'Bearer',
						expires_in: 7200,
						refresh_token: 'self-hosted-refresh-token',
					}),
				),
			)

			// As the OAuth flow stores it, and as a later config update may.
			for (const config of [
				{
					scope: 'api',
					metadata: { instanceUrl: 'https://gitlab.example.com' },
				},
				{ instanceUrl: 'https://gitlab.example.com' },
			]) {
				const newTokenData = await provider.refreshToken!('old-refresh-token', {
					config: JSON.stringify(config),
				})
				expect(newTokenData.accessToken).toBe('self-hosted-access-token')
			}
			expect(gitlabComEndpoint).not.toHaveBeenCalled()
		})

		it('should handle refresh token errors', async () => {
			// Override MSW handler for token refresh error
			server.use(
				http.post('https://gitlab.com/oauth/token', () => {
					return HttpResponse.json(
						{
							error: 'invalid_grant',
							error_description: 'Invalid refresh token',
						},
						{ status: 400 },
					)
				}),
			)

			await expect(
				provider.refreshToken!('invalid-refresh-token', gitlabCom),
			).rejects.toThrow('Token refresh failed')
		})
	})

	describe('getAvailableChannels', () => {
		it('should fetch available projects as channels', async () => {
			const mockIntegration = {
				id: 'integration-123',
				accessToken: 'encrypted-access-token',
				organizationId: 'org-123',
				providerName: 'gitlab',
				isActive: true,
			} as any

			// Override MSW handler for projects
			server.use(
				http.get('https://gitlab.com/api/v4/projects', () => {
					return HttpResponse.json([
						{
							id: 123,
							name: 'my-project',
							name_with_namespace: 'user/my-project',
							path: 'my-project',
							path_with_namespace: 'user/my-project',
							description: 'My test project',
							default_branch: 'main',
							visibility: 'public',
							web_url: 'https://gitlab.com/user/my-project',
							avatar_url: null,
							namespace: {
								id: 1,
								name: 'user',
								path: 'user',
								kind: 'user',
							},
							permissions: {
								project_access: {
									access_level: 40,
								},
							},
						},
						{
							id: 456,
							name: 'private-project',
							name_with_namespace: 'user/private-project',
							path: 'private-project',
							path_with_namespace: 'user/private-project',
							description: 'My private project',
							default_branch: 'main',
							visibility: 'private',
							web_url: 'https://gitlab.com/user/private-project',
							avatar_url: null,
							namespace: {
								id: 1,
								name: 'user',
								path: 'user',
								kind: 'user',
							},
							permissions: {
								project_access: {
									access_level: 40,
								},
							},
						},
					])
				}),
			)

			const channels = await provider.getAvailableChannels(mockIntegration)

			expect(channels).toHaveLength(2)
			expect(channels[0]).toEqual({
				id: '123',
				name: 'user/my-project',
				type: 'public',
				metadata: {
					projectId: 123,
					projectPath: 'user/my-project',
					description: 'My test project',
					webUrl: 'https://gitlab.com/user/my-project',
					avatarUrl: null,
					defaultBranch: 'main',
					namespace: {
						id: 1,
						name: 'user',
						path: 'user',
						kind: 'user',
					},
				},
			})
			expect(channels[1]).toEqual({
				id: '456',
				name: 'user/private-project',
				type: 'private',
				metadata: {
					projectId: 456,
					projectPath: 'user/private-project',
					description: 'My private project',
					webUrl: 'https://gitlab.com/user/private-project',
					avatarUrl: null,
					defaultBranch: 'main',
					namespace: {
						id: 1,
						name: 'user',
						path: 'user',
						kind: 'user',
					},
				},
			})
		})

		it('should handle API errors when fetching channels', async () => {
			const mockIntegration = {
				id: 'integration-123',
				accessToken: null,
				organizationId: 'org-123',
				providerName: 'gitlab',
				isActive: true,
			} as any

			await expect(
				provider.getAvailableChannels(mockIntegration),
			).rejects.toThrow('No access token available for GitLab integration')
		})
	})

	describe('postMessage', () => {
		it('should create issue successfully', async () => {
			const mockConnection = {
				id: 'connection-123',
				externalId: '123',
				config: JSON.stringify({
					projectId: '123',
					projectName: 'my-project',
					projectPath: 'user/my-project',
					includeNoteContent: true,
				}),
				integration: {
					id: 'integration-123',
					accessToken: 'encrypted-access-token',
					organizationId: 'org-123',
					providerName: 'gitlab',
					isActive: true,
				},
			} as any

			// Override MSW handler for issue creation
			server.use(
				http.post('https://gitlab.com/api/v4/projects/123/issues', () => {
					return HttpResponse.json({
						id: 456,
						iid: 1,
						title: 'Test Note',
						description:
							'Test content\n\nView note: https://example.com/notes/123',
						web_url: 'https://gitlab.com/user/my-project/-/issues/1',
						project_id: 123,
					})
				}),
			)

			const messageData: MessageData = {
				title: 'Test Note',
				content: 'Test content',
				author: 'John Doe',
				noteUrl: 'https://example.com/notes/123',
				changeType: 'created',
			}

			await provider.postMessage(mockConnection, messageData)

			// The test passes if no error is thrown
			expect(true).toBe(true)
		})

		it('should handle issue creation errors', async () => {
			const mockConnection = {
				id: 'connection-123',
				externalId: '123',
				config: JSON.stringify({
					projectId: '123',
					includeNoteContent: true,
				}),
				integration: {
					id: 'integration-123',
					accessToken: null,
					organizationId: 'org-123',
					providerName: 'gitlab',
					isActive: true,
				},
			} as any

			const messageData: MessageData = {
				title: 'Test Note',
				content: 'Test content',
				author: 'John Doe',
				noteUrl: 'https://example.com/notes/123',
				changeType: 'created',
			}

			await expect(
				provider.postMessage(mockConnection, messageData),
			).rejects.toThrow('No access token available for GitLab integration')
		})
	})

	describe('validateConnection', () => {
		it('should validate connection successfully', async () => {
			const mockConnection = {
				id: 'connection-123',
				externalId: '123',
				config: JSON.stringify({ projectId: '123' }),
				integration: {
					id: 'integration-123',
					accessToken: 'encrypted-access-token',
					organizationId: 'org-123',
					providerName: 'gitlab',
					isActive: true,
				},
			} as any

			// Override MSW handler for project validation
			server.use(
				http.get('https://gitlab.com/api/v4/projects/123', () => {
					return HttpResponse.json({
						id: 123,
						name: 'my-project',
						name_with_namespace: 'user/my-project',
						path_with_namespace: 'user/my-project',
						web_url: 'https://gitlab.com/user/my-project',
						issues_enabled: true,
					})
				}),
			)

			const isValid = await provider.validateConnection(mockConnection)

			expect(isValid).toBe(true)
		})

		it('should return false for invalid connection', async () => {
			const mockConnection = {
				id: 'connection-123',
				externalId: '123',
				config: JSON.stringify({ projectId: '123' }),
				integration: {
					id: 'integration-123',
					accessToken: null,
					organizationId: 'org-123',
					providerName: 'gitlab',
					isActive: true,
				},
			} as any

			const isValid = await provider.validateConnection(mockConnection)

			expect(isValid).toBe(false)
		})

		it('should handle validation errors', async () => {
			const mockConnection = {
				id: 'connection-123',
				externalId: '123',
				config: JSON.stringify({ projectId: '123' }),
				integration: {
					id: 'integration-123',
					accessToken: 'encrypted-access-token',
					organizationId: 'org-123',
					providerName: 'gitlab',
					isActive: true,
				},
			} as any

			// Mock decryptToken to throw an error
			vi.mocked(decryptToken).mockRejectedValueOnce(
				new Error('Decryption error'),
			)

			const isValid = await provider.validateConnection(mockConnection)

			expect(isValid).toBe(false)
		})
	})

	describe('Error Handling', () => {
		it('should handle missing environment variables', async () => {
			delete process.env.GITLAB_CLIENT_ID

			await expect(
				provider.getAuthUrl('org-123', 'http://localhost:3000/callback'),
			).rejects.toThrow('GITLAB_CLIENT_ID environment variable is required')
		})
	})
})
