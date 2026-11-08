import { describe, it, expect, beforeEach, vi } from 'vitest'
import { JiraProvider } from '../../../src/providers/jira/provider'
import { fixtures } from '../../utils/fixtures'
import type {
	Integration,
	NoteIntegrationConnection,
} from '@repo/database/types'
import type { MessageData } from '../../../src/types'

// Mock the encryption module
vi.mock('../../../src/encryption', () => ({
	decryptToken: vi.fn().mockResolvedValue('decrypted-access-token'),
	encryptToken: vi.fn().mockResolvedValue('encrypted-token'),
}))

// Mock the integration manager
vi.mock('../../../src/integration-manager', () => ({
	integrationManager: {
		refreshIntegrationTokens: vi.fn().mockResolvedValue({
			id: 'integration-123',
			accessToken: 'new-encrypted-token',
			refreshToken: 'new-encrypted-refresh-token',
		}),
	},
}))

describe('JiraProvider - Issue Creation', () => {
	let provider: JiraProvider
	let mockIntegration: Integration
	let mockConnection: NoteIntegrationConnection & { integration: Integration }
	let mockMessageData: MessageData

	beforeEach(() => {
		provider = new JiraProvider()

		mockIntegration = {
			...fixtures.testData.integration,
			providerName: 'jira',
		} as Integration

		mockConnection = {
			...fixtures.testData.connection,
			integration: mockIntegration,
		} as NoteIntegrationConnection & { integration: Integration }

		mockMessageData = fixtures.testData.messageData

		// Reset fetch mock
		global.fetch = vi.fn()
	})

	// Helper function to mock successful issue creation flow
	const mockSuccessfulIssueCreation = () => {
		const mockResourcesResponse1 = {
			ok: true,
			json: vi
				.fn()
				.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
		}

		const mockIssueTypesResponse = {
			ok: true,
			json: vi.fn().mockResolvedValue(fixtures.jira.createMetaResponse),
		}

		const mockResourcesResponse2 = {
			ok: true,
			json: vi
				.fn()
				.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
		}

		const mockCreateIssueResponse = {
			ok: true,
			json: vi.fn().mockResolvedValue(fixtures.jira.createIssueResponse),
		}

		global.fetch = vi
			.fn()
			.mockResolvedValueOnce(mockResourcesResponse1) // Accessible resources for issue types
			.mockResolvedValueOnce(mockIssueTypesResponse) // Issue types
			.mockResolvedValueOnce(mockResourcesResponse2) // Accessible resources for create issue
			.mockResolvedValueOnce(mockCreateIssueResponse) // Create issue
	}

	describe('postMessage', () => {
		it('should successfully create a Jira issue', async () => {
			mockSuccessfulIssueCreation()

			await provider.postMessage(mockConnection, mockMessageData)

			// Verify create issue API call
			expect(fetch).toHaveBeenCalledWith(
				'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3/issue',
				expect.objectContaining({
					method: 'POST',
					headers: {
						Authorization: 'Bearer decrypted-access-token',
						'Content-Type': 'application/json',
						Accept: 'application/json',
					},
					body: JSON.stringify({
						fields: {
							project: {
								key: 'TEST',
							},
							summary: 'Test Note Title',
							description: {
								type: 'doc',
								version: 1,
								content: [
									{
										type: 'paragraph',
										content: [
											{
												type: 'text',
												text: 'Note created by Test Author\n\n[View Note|https://example.com/notes/123]\n\n---\n\nThis is the content of the test note.',
											},
										],
									},
								],
							},
							issuetype: {
								name: 'Task',
							},
						},
					}),
				}),
			)
		})

		it('should handle different change types in issue summary', async () => {
			const updatedMessageData: MessageData = {
				...mockMessageData,
				changeType: 'updated',
			}

			mockSuccessfulIssueCreation()

			await provider.postMessage(mockConnection, updatedMessageData)

			const createIssueCall = vi
				.mocked(fetch)
				.mock.calls.find(
					(call) =>
						call[0]?.toString().includes('/issue') &&
						call[1]?.method === 'POST',
				)

			const requestBody = JSON.parse(createIssueCall![1]!.body as string)
			expect(requestBody.fields.summary).toBe('[UPDATED] Test Note Title')
		})

		it('should use preferred issue type from configuration', async () => {
			const integrationWithConfig = {
				...mockIntegration,
				config: JSON.stringify({
					instanceUrl: 'https://test.atlassian.net',
					defaultIssueType: 'Story',
					includeNoteContent: true,
				}),
			} as Integration

			const connectionWithConfig = {
				...mockConnection,
				integration: integrationWithConfig,
			}

			mockSuccessfulIssueCreation()

			await provider.postMessage(connectionWithConfig, mockMessageData)

			const createIssueCall = vi
				.mocked(fetch)
				.mock.calls.find(
					(call) =>
						call[0]?.toString().includes('/issue') &&
						call[1]?.method === 'POST',
				)

			const requestBody = JSON.parse(createIssueCall![1]!.body as string)
			expect(requestBody.fields.issuetype.name).toBe('Story')
		})

		it('should fallback to first available issue type when preferred type not found', async () => {
			const integrationWithConfig = {
				...mockIntegration,
				config: JSON.stringify({
					instanceUrl: 'https://test.atlassian.net',
					defaultIssueType: 'NonExistentType',
					includeNoteContent: true,
				}),
			} as Integration

			const connectionWithConfig = {
				...mockConnection,
				integration: integrationWithConfig,
			}

			mockSuccessfulIssueCreation()

			await provider.postMessage(connectionWithConfig, mockMessageData)

			const createIssueCall = vi
				.mocked(fetch)
				.mock.calls.find(
					(call) =>
						call[0]?.toString().includes('/issue') &&
						call[1]?.method === 'POST',
				)

			const requestBody = JSON.parse(createIssueCall![1]!.body as string)
			expect(requestBody.fields.issuetype.name).toBe('Task') // First available type
		})

		it('should exclude note content when configured', async () => {
			const integrationWithConfig = {
				...mockIntegration,
				config: JSON.stringify({
					instanceUrl: 'https://test.atlassian.net',
					includeNoteContent: false,
				}),
			} as Integration

			const connectionWithConfig = {
				...mockConnection,
				integration: integrationWithConfig,
			}

			mockSuccessfulIssueCreation()

			await provider.postMessage(connectionWithConfig, mockMessageData)

			const createIssueCall = vi
				.mocked(fetch)
				.mock.calls.find(
					(call) =>
						call[0]?.toString().includes('/issue') &&
						call[1]?.method === 'POST',
				)

			const requestBody = JSON.parse(createIssueCall![1]!.body as string)
			const description =
				requestBody.fields.description.content[0].content[0].text

			expect(description).toBe(
				'Note created by Test Author\n\n[View Note|https://example.com/notes/123]',
			)
			expect(description).not.toContain('This is the content of the test note.')
		})

		it('should handle message without note URL', async () => {
			const messageWithoutUrl: MessageData = {
				...mockMessageData,
				noteUrl: undefined,
			}

			mockSuccessfulIssueCreation()

			await provider.postMessage(mockConnection, messageWithoutUrl)

			const createIssueCall = vi
				.mocked(fetch)
				.mock.calls.find(
					(call) =>
						call[0]?.toString().includes('/issue') &&
						call[1]?.method === 'POST',
				)

			const requestBody = JSON.parse(createIssueCall![1]!.body as string)
			const description =
				requestBody.fields.description.content[0].content[0].text

			expect(description).toBe(
				'Note created by Test Author\n\n---\n\nThis is the content of the test note.',
			)
			expect(description).not.toContain('[View Note|')
		})

		it('should truncate long summaries to 255 characters', async () => {
			const longTitle = 'A'.repeat(300) // 300 characters
			const messageWithLongTitle: MessageData = {
				...mockMessageData,
				title: longTitle,
			}

			mockSuccessfulIssueCreation()

			await provider.postMessage(mockConnection, messageWithLongTitle)

			const createIssueCall = vi
				.mocked(fetch)
				.mock.calls.find(
					(call) =>
						call[0]?.toString().includes('/issue') &&
						call[1]?.method === 'POST',
				)

			const requestBody = JSON.parse(createIssueCall![1]!.body as string)
			expect(requestBody.fields.summary).toHaveLength(255)
			expect(requestBody.fields.summary.endsWith('...')).toBe(true)
		})

		it('should throw error when access token is missing', async () => {
			const integrationWithoutToken = {
				...mockIntegration,
				accessToken: null,
			} as Integration

			const connectionWithoutToken = {
				...mockConnection,
				integration: integrationWithoutToken,
			}

			await expect(
				provider.postMessage(connectionWithoutToken, mockMessageData),
			).rejects.toThrow('Access token is required')
		})

		it('should throw error when project key is missing', async () => {
			const connectionWithoutProject = {
				...mockConnection,
				externalId: null,
			} as NoteIntegrationConnection & { integration: Integration }

			await expect(
				provider.postMessage(connectionWithoutProject, mockMessageData),
			).rejects.toThrow('Project key is required')
		})

		it('should handle issue creation API failure', async () => {
			const mockResourcesResponse1 = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockIssueTypesResponse = {
				ok: true,
				json: vi.fn().mockResolvedValue(fixtures.jira.createMetaResponse),
			}

			const mockResourcesResponse2 = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockCreateIssueErrorResponse = {
				ok: false,
				text: vi.fn().mockResolvedValue('Issue creation failed'),
			}

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce(mockResourcesResponse1)
				.mockResolvedValueOnce(mockIssueTypesResponse)
				.mockResolvedValueOnce(mockResourcesResponse2)
				.mockResolvedValueOnce(mockCreateIssueErrorResponse)

			await expect(
				provider.postMessage(mockConnection, mockMessageData),
			).rejects.toThrow('Failed to create issue: Issue creation failed')
		})

		it('should handle issue types fetch failure and use default', async () => {
			const mockResourcesResponse1 = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockIssueTypesErrorResponse = {
				ok: false,
				statusText: 'Forbidden',
			}

			const mockResourcesResponse2 = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockCreateIssueResponse = {
				ok: true,
				json: vi.fn().mockResolvedValue(fixtures.jira.createIssueResponse),
			}

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce(mockResourcesResponse1)
				.mockResolvedValueOnce(mockIssueTypesErrorResponse)
				.mockResolvedValueOnce(mockResourcesResponse2)
				.mockResolvedValueOnce(mockCreateIssueResponse)

			await provider.postMessage(mockConnection, mockMessageData)

			const createIssueCall = vi
				.mocked(fetch)
				.mock.calls.find(
					(call) =>
						call[0]?.toString().includes('/issue') &&
						call[1]?.method === 'POST',
				)

			const requestBody = JSON.parse(createIssueCall![1]!.body as string)
			expect(requestBody.fields.issuetype.name).toBe('Task') // Default fallback
		})

		it('should handle authentication error and attempt token refresh', async () => {
			const { decryptToken } = await import('../../../src/encryption')
			const { integrationManager } =
				await import('../../../src/integration-manager')

			// First call fails with auth error
			const mockAuthErrorResponse = {
				ok: false,
				statusText: 'Unauthorized',
			}

			// After refresh, successful responses
			const mockResourcesResponse1 = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockIssueTypesResponse = {
				ok: true,
				json: vi.fn().mockResolvedValue(fixtures.jira.createMetaResponse),
			}

			const mockResourcesResponse2 = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockCreateIssueResponse = {
				ok: true,
				json: vi.fn().mockResolvedValue(fixtures.jira.createIssueResponse),
			}

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce(mockAuthErrorResponse) // First call fails
				.mockResolvedValueOnce(mockResourcesResponse1) // After refresh - resources for issue types
				.mockResolvedValueOnce(mockIssueTypesResponse) // After refresh - issue types
				.mockResolvedValueOnce(mockResourcesResponse2) // After refresh - resources for create issue
				.mockResolvedValueOnce(mockCreateIssueResponse) // After refresh - create issue

			// Mock decryptToken to return different tokens for original and refreshed
			vi.mocked(decryptToken)
				.mockResolvedValueOnce('expired-token') // First call
				.mockResolvedValueOnce('new-access-token') // After refresh

			await provider.postMessage(mockConnection, mockMessageData)

			expect(integrationManager.refreshIntegrationTokens).toHaveBeenCalledWith(
				'integration-123',
				{ rejectedAccessToken: 'expired-token' },
			)
		})

		it('should format Jira description with proper ADF structure', async () => {
			mockSuccessfulIssueCreation()

			await provider.postMessage(mockConnection, mockMessageData)

			const createIssueCall = vi
				.mocked(fetch)
				.mock.calls.find(
					(call) =>
						call[0]?.toString().includes('/issue') &&
						call[1]?.method === 'POST',
				)

			const requestBody = JSON.parse(createIssueCall![1]!.body as string)
			const description = requestBody.fields.description

			// Verify ADF (Atlassian Document Format) structure
			expect(description).toEqual({
				type: 'doc',
				version: 1,
				content: [
					{
						type: 'paragraph',
						content: [
							{
								type: 'text',
								text: 'Note created by Test Author\n\n[View Note|https://example.com/notes/123]\n\n---\n\nThis is the content of the test note.',
							},
						],
					},
				],
			})
		})
	})
})
