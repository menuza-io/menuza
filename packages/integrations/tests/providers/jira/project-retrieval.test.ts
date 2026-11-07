import { describe, it, expect, beforeEach, vi } from 'vitest'
import { JiraProvider } from '../../../src/providers/jira/provider'
import { fixtures } from '../../utils/fixtures'
import type { Integration } from '@repo/database/types'

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

describe('JiraProvider - Project Retrieval', () => {
	let provider: JiraProvider
	let mockIntegration: Integration

	beforeEach(() => {
		provider = new JiraProvider()

		mockIntegration = {
			...fixtures.testData.integration,
			providerName: 'jira',
		} as Integration

		// Reset fetch mock
		global.fetch = vi.fn()
	})

	describe('getAvailableChannels', () => {
		it('should successfully retrieve and map Jira projects to channels', async () => {
			// Mock accessible resources response
			const mockResourcesResponse = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			// Mock projects response
			const mockProjectsResponse = {
				ok: true,
				json: vi.fn().mockResolvedValue(fixtures.jira.projectsResponse),
			}

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce(mockResourcesResponse) // Accessible resources
				.mockResolvedValueOnce(mockProjectsResponse) // Projects

			const channels = await provider.getAvailableChannels(mockIntegration)

			expect(channels).toHaveLength(2)

			// Check first project mapping
			expect(channels[0]).toEqual({
				id: 'TEST',
				name: 'TEST - Test Project',
				type: 'public',
				metadata: {
					projectId: '10001',
					projectKey: 'TEST',
					projectName: 'Test Project',
					projectType: 'software',
					description: 'A test project for integration testing',
					lead: {
						accountId: '123456:abcd-efgh-ijkl',
						displayName: 'Test User',
					},
					avatarUrls: {
						'16x16':
							'https://test.atlassian.net/secure/projectavatar?size=xsmall&pid=10001',
						'24x24':
							'https://test.atlassian.net/secure/projectavatar?size=small&pid=10001',
						'32x32':
							'https://test.atlassian.net/secure/projectavatar?size=medium&pid=10001',
						'48x48':
							'https://test.atlassian.net/secure/projectavatar?size=large&pid=10001',
					},
				},
			})

			// Check second project mapping
			expect(channels[1]).toEqual({
				id: 'DEMO',
				name: 'DEMO - Demo Project',
				type: 'public',
				metadata: {
					projectId: '10002',
					projectKey: 'DEMO',
					projectName: 'Demo Project',
					projectType: 'business',
					description: 'Demo project for testing',
					lead: undefined,
					avatarUrls: undefined,
				},
			})

			// Verify API calls
			expect(fetch).toHaveBeenCalledWith(
				'https://api.atlassian.com/oauth/token/accessible-resources',
				expect.objectContaining({
					headers: {
						Authorization: 'Bearer decrypted-access-token',
						Accept: 'application/json',
					},
				}),
			)

			expect(fetch).toHaveBeenCalledWith(
				'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3/project/search?expand=lead,description',
				expect.objectContaining({
					headers: {
						Authorization: 'Bearer decrypted-access-token',
						Accept: 'application/json',
					},
				}),
			)
		})

		it('should throw error when access token is missing', async () => {
			const integrationWithoutToken = {
				...mockIntegration,
				accessToken: null,
			} as Integration

			await expect(
				provider.getAvailableChannels(integrationWithoutToken),
			).rejects.toThrow('Access token is required')
		})

		it('should handle API failure when fetching accessible resources', async () => {
			const mockErrorResponse = {
				ok: false,
				statusText: 'Unauthorized',
			}

			global.fetch = vi.fn().mockResolvedValue(mockErrorResponse)

			await expect(
				provider.getAvailableChannels(mockIntegration),
			).rejects.toThrow('Failed to get accessible resources: Unauthorized')
		})

		it('should handle API failure when fetching projects', async () => {
			const mockResourcesResponse = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockProjectsErrorResponse = {
				ok: false,
				statusText: 'Forbidden',
			}

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce(mockResourcesResponse) // Accessible resources
				.mockResolvedValueOnce(mockProjectsErrorResponse) // Projects error

			await expect(
				provider.getAvailableChannels(mockIntegration),
			).rejects.toThrow('Failed to get projects: Forbidden')
		})

		it('should handle empty projects response', async () => {
			const mockResourcesResponse = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockEmptyProjectsResponse = {
				ok: true,
				json: vi.fn().mockResolvedValue({
					values: [],
					total: 0,
					isLast: true,
				}),
			}

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce(mockResourcesResponse)
				.mockResolvedValueOnce(mockEmptyProjectsResponse)

			const channels = await provider.getAvailableChannels(mockIntegration)

			expect(channels).toHaveLength(0)
		})

		it('should handle projects without optional fields', async () => {
			const mockResourcesResponse = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockMinimalProjectsResponse = {
				ok: true,
				json: vi.fn().mockResolvedValue({
					values: [
						{
							id: '10003',
							key: 'MIN',
							name: 'Minimal Project',
							projectTypeKey: 'software',
							// No description, lead, or avatarUrls
						},
					],
					total: 1,
					isLast: true,
				}),
			}

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce(mockResourcesResponse)
				.mockResolvedValueOnce(mockMinimalProjectsResponse)

			const channels = await provider.getAvailableChannels(mockIntegration)

			expect(channels).toHaveLength(1)
			expect(channels[0]).toEqual({
				id: 'MIN',
				name: 'MIN - Minimal Project',
				type: 'public',
				metadata: {
					projectId: '10003',
					projectKey: 'MIN',
					projectName: 'Minimal Project',
					projectType: 'software',
					description: undefined,
					lead: undefined,
					avatarUrls: undefined,
				},
			})
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
			const mockResourcesResponse = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockProjectsResponse = {
				ok: true,
				json: vi.fn().mockResolvedValue(fixtures.jira.projectsResponse),
			}

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce(mockAuthErrorResponse) // First call fails
				.mockResolvedValueOnce(mockResourcesResponse) // After refresh - resources
				.mockResolvedValueOnce(mockProjectsResponse) // After refresh - projects

			// Mock decryptToken to return different tokens for original and refreshed
			vi.mocked(decryptToken)
				.mockResolvedValueOnce('expired-token') // First call
				.mockResolvedValueOnce('new-access-token') // After refresh

			const channels = await provider.getAvailableChannels(mockIntegration)

			expect(channels).toHaveLength(2)
			expect(integrationManager.refreshIntegrationTokens).toHaveBeenCalledWith(
				'integration-123',
				{ rejectedAccessToken: 'expired-token' },
			)
		})

		it('should handle authentication error when no refresh token is available', async () => {
			const integrationWithoutRefreshToken = {
				...mockIntegration,
				refreshToken: null,
			} as Integration

			const mockAuthErrorResponse = {
				ok: false,
				statusText: 'Unauthorized',
			}

			global.fetch = vi.fn().mockResolvedValue(mockAuthErrorResponse)

			await expect(
				provider.getAvailableChannels(integrationWithoutRefreshToken),
			).rejects.toThrow(
				'Jira access token expired and no refresh token is available',
			)
		})

		it('should handle token refresh failure', async () => {
			const { integrationManager } =
				await import('../../../src/integration-manager')

			const mockAuthErrorResponse = {
				ok: false,
				statusText: 'Unauthorized',
			}

			global.fetch = vi.fn().mockResolvedValue(mockAuthErrorResponse)

			// Mock refresh to fail
			vi.mocked(integrationManager.refreshIntegrationTokens).mockRejectedValue(
				new Error('Refresh failed'),
			)

			await expect(
				provider.getAvailableChannels(mockIntegration),
			).rejects.toThrow(
				'Authentication failed and token refresh failed: Refresh failed',
			)
		})

		it('should handle missing accessible resources', async () => {
			const mockEmptyResourcesResponse = {
				ok: true,
				json: vi.fn().mockResolvedValue([]), // Empty resources array
			}

			global.fetch = vi.fn().mockResolvedValue(mockEmptyResourcesResponse)

			await expect(
				provider.getAvailableChannels(mockIntegration),
			).rejects.toThrow('No accessible Jira resource found')
		})

		it('should use project key as channel ID for consistency', async () => {
			const mockResourcesResponse = {
				ok: true,
				json: vi
					.fn()
					.mockResolvedValue(fixtures.jira.accessibleResourcesResponse),
			}

			const mockProjectsResponse = {
				ok: true,
				json: vi.fn().mockResolvedValue({
					values: [
						{
							id: '99999', // Different from key
							key: 'UNIQUE',
							name: 'Unique Project',
							projectTypeKey: 'software',
						},
					],
					total: 1,
					isLast: true,
				}),
			}

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce(mockResourcesResponse)
				.mockResolvedValueOnce(mockProjectsResponse)

			const channels = await provider.getAvailableChannels(mockIntegration)

			expect(channels[0].id).toBe('UNIQUE') // Should use key, not id
			expect(channels[0].metadata.projectId).toBe('99999') // But metadata should have both
			expect(channels[0].metadata.projectKey).toBe('UNIQUE')
		})
	})
})
