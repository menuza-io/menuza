/**
 * Tests for TrelloProvider
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../setup'
import { TrelloProvider } from '../../../src/providers/trello/provider'
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

describe('TrelloProvider', () => {
	let provider: TrelloProvider

	beforeEach(() => {
		// Set required environment variables
		process.env.TRELLO_API_KEY = 'test-api-key'
		process.env.TRELLO_API_SECRET = 'test-api-secret'

		provider = new TrelloProvider()
		vi.clearAllMocks()

		// Reset the mock for decryptToken
		vi.mocked(decryptToken).mockResolvedValue('access-token')
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('Provider Properties', () => {
		it('should have correct provider properties', () => {
			expect(provider.name).toBe('trello')
			expect(provider.type).toBe('productivity')
			expect(provider.displayName).toBe('Trello')
			expect(provider.description).toBe(
				'Connect notes to Trello boards for task management and project organization',
			)
		})
	})

	describe('getAuthUrl', () => {
		it('should generate correct auth URL', async () => {
			const organizationId = 'org-123'
			const redirectUri = 'https://example.com/callback'

			// Override MSW handler for request token
			server.use(
				http.post('https://trello.com/1/OAuthGetRequestToken', () => {
					return new HttpResponse(
						'oauth_token=request-token&oauth_token_secret=request-secret',
						{
							headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
						},
					)
				}),
			)

			const authUrl = await provider.getAuthUrl(organizationId, redirectUri)

			expect(authUrl).toContain('https://trello.com/1/authorize')
			expect(authUrl).toContain('oauth_token=request-token')
			expect(authUrl).toContain('name=Epic+Stack+Integration')
			expect(authUrl).toContain('scope=read%2Cwrite')
			expect(authUrl).toContain('expiration=never')
		})
	})

	describe('handleCallback', () => {
		it('should handle successful OAuth callback', async () => {
			// The request-token secret comes from the caller's hand-off record,
			// not from memory on this instance (a fresh provider never saw it).
			let signedBody = ''
			server.use(
				http.post(
					'https://trello.com/1/OAuthGetAccessToken',
					async ({ request }) => {
						signedBody = await request.text()
						return new HttpResponse(
							'oauth_token=access-token&oauth_token_secret=access-secret',
							{
								headers: {
									'Content-Type': 'application/x-www-form-urlencoded',
								},
							},
						)
					},
				),
			)

			const params = {
				organizationId: 'org-123',
				code: 'oauth-verifier',
				state: 'valid-state',
				oauthToken: 'request-token',
				requestTokenSecret: 'request-secret',
			}

			const tokenData = await new TrelloProvider().handleCallback(params)

			expect(tokenData.accessToken).toBe('access-token')
			expect(tokenData.refreshToken).toBe('access-secret')
			expect(new URLSearchParams(signedBody).get('oauth_token')).toBe(
				'request-token',
			)
		})

		it('refuses a callback without the request-token secret', async () => {
			await expect(
				provider.handleCallback({
					organizationId: 'org-123',
					code: 'oauth-verifier',
					state: 'valid-state',
					oauthToken: 'request-token',
				}),
			).rejects.toThrow('Request token secret not found')
		})

		it('hands the request-token secret to the caller on start', async () => {
			server.use(
				http.post('https://trello.com/1/OAuthGetRequestToken', () => {
					return new HttpResponse(
						'oauth_token=request-token&oauth_token_secret=request-secret',
						{
							headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
						},
					)
				}),
			)

			const started = await provider.startOAuth1(
				'org-123',
				'https://example.com/callback',
			)

			expect(started.requestToken).toBe('request-token')
			expect(started.requestTokenSecret).toBe('request-secret')
			expect(started.authUrl).toContain('oauth_token=request-token')
		})

		it('should handle OAuth error response', async () => {
			const params = {
				organizationId: 'org-123',
				code: '',
				state: 'state',
				error: 'access_denied',
				errorDescription: 'User denied access',
			}

			await expect(provider.handleCallback(params)).rejects.toThrow(
				'OAuth verifier is required',
			)
		})
	})

	describe('getAvailableChannels', () => {
		it('should fetch available lists as channels', async () => {
			const mockIntegration = {
				id: 'integration-123',
				accessToken: 'encrypted-access-token',
				organizationId: 'org-123',
				providerName: 'trello',
				isActive: true,
			} as any

			// Override MSW handlers for this test
			server.use(
				http.get('https://api.trello.com/1/members/me/boards', () => {
					return HttpResponse.json([
						{
							id: 'board-123',
							name: 'My Board',
							url: 'https://trello.com/b/board-123',
							closed: false,
						},
					])
				}),
				http.get('https://api.trello.com/1/boards/board-123/lists', () => {
					return HttpResponse.json([
						{
							id: 'list-123',
							name: 'To Do',
							closed: false,
							idBoard: 'board-123',
						},
						{
							id: 'list-456',
							name: 'In Progress',
							closed: false,
							idBoard: 'board-123',
						},
					])
				}),
			)

			const channels = await provider.getAvailableChannels(mockIntegration)

			expect(channels).toHaveLength(2)
			expect(channels[0]).toEqual({
				id: 'list-123',
				name: 'My Board / To Do',
				type: 'public',
				metadata: {
					boardId: 'board-123',
					boardName: 'My Board',
					listName: 'To Do',
					boardUrl: 'https://trello.com/b/board-123',
				},
			})
			expect(channels[1]).toEqual({
				id: 'list-456',
				name: 'My Board / In Progress',
				type: 'public',
				metadata: {
					boardId: 'board-123',
					boardName: 'My Board',
					listName: 'In Progress',
					boardUrl: 'https://trello.com/b/board-123',
				},
			})
		})

		it('should handle API errors when fetching channels', async () => {
			const mockIntegration = {
				id: 'integration-123',
				accessToken: null,
				organizationId: 'org-123',
				providerName: 'trello',
				isActive: true,
			} as any

			await expect(
				provider.getAvailableChannels(mockIntegration),
			).rejects.toThrow(
				'Failed to get Trello channels: No access token available for Trello integration',
			)
		})
	})

	describe('postMessage', () => {
		it('should create card successfully', async () => {
			const mockConnection = {
				id: 'connection-123',
				externalId: 'list-123',
				config: JSON.stringify({
					listId: 'list-123',
					listName: 'To Do',
					boardName: 'My Board',
					includeNoteContent: true,
				}),
				integration: {
					id: 'integration-123',
					accessToken: 'encrypted-access-token',
					organizationId: 'org-123',
					providerName: 'trello',
					isActive: true,
				},
			} as any

			// Override MSW handler for card creation
			server.use(
				http.post('https://api.trello.com/1/cards', () => {
					return HttpResponse.json({
						id: 'card-123',
						name: 'Test Note',
						desc: 'Test content\n\nView note: https://example.com/notes/123',
						url: 'https://trello.com/c/card-123',
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

		it('should handle card creation errors', async () => {
			const mockConnection = {
				id: 'connection-123',
				externalId: 'list-123',
				config: JSON.stringify({
					listId: 'list-123',
					includeNoteContent: true,
				}),
				integration: {
					id: 'integration-123',
					accessToken: null,
					organizationId: 'org-123',
					providerName: 'trello',
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
			).rejects.toThrow(
				'Failed to post message to Trello: No access token available for Trello integration',
			)
		})
	})

	describe('validateConnection', () => {
		it('should validate connection successfully', async () => {
			const mockConnection = {
				id: 'connection-123',
				externalId: 'list-123',
				config: JSON.stringify({ listId: 'list-123' }),
				integration: {
					id: 'integration-123',
					accessToken: 'encrypted-access-token',
					organizationId: 'org-123',
					providerName: 'trello',
					isActive: true,
				},
			} as any

			// Override MSW handler for list validation
			server.use(
				http.get('https://api.trello.com/1/lists/list-123', () => {
					return HttpResponse.json({
						id: 'list-123',
						name: 'To Do',
						closed: false,
					})
				}),
			)

			const isValid = await provider.validateConnection(mockConnection)

			expect(isValid).toBe(true)
		})

		it('should return false for invalid connection', async () => {
			const mockConnection = {
				id: 'connection-123',
				externalId: 'invalid-list',
				config: JSON.stringify({ listId: 'invalid-list' }),
				integration: {
					id: 'integration-123',
					accessToken: null,
					organizationId: 'org-123',
					providerName: 'trello',
					isActive: true,
				},
			} as any

			const isValid = await provider.validateConnection(mockConnection)

			expect(isValid).toBe(false)
		})

		it('should handle validation errors', async () => {
			const mockConnection = {
				id: 'connection-123',
				externalId: 'list-123',
				config: JSON.stringify({ listId: 'list-123' }),
				integration: {
					id: 'integration-123',
					accessToken: 'encrypted-access-token',
					organizationId: 'org-123',
					providerName: 'trello',
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

	describe('refreshToken', () => {
		it('should support token refresh', async () => {
			const refreshToken = 'refresh-token'
			const result = await provider.refreshToken(refreshToken)

			expect(result.accessToken).toBe(refreshToken)
			expect(result.refreshToken).toBeUndefined()
		})
	})

	describe('Error Handling', () => {
		it('should handle missing environment variables', async () => {
			delete process.env.TRELLO_API_KEY

			await expect(
				provider.getAuthUrl('org-123', 'http://localhost:3000/callback'),
			).rejects.toThrow('TRELLO_API_KEY environment variable is required')
		})
	})
})
