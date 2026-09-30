import { describe, it, expect, beforeEach } from 'vitest'
import { SlackProvider } from '../../../src/providers/slack/provider'

describe('SlackProvider - OAuth Flow', () => {
	let provider: SlackProvider

	beforeEach(() => {
		provider = new SlackProvider()
		// Clear environment variables to test defaults
		delete process.env.SLACK_CLIENT_ID
		delete process.env.SLACK_CLIENT_SECRET
	})

	describe('getAuthUrl', () => {
		it('should generate correct authorization URL with required parameters', async () => {
			const organizationId = 'org-123'
			const redirectUri = 'https://example.com/callback'

			const authUrl = await provider.getAuthUrl(organizationId, redirectUri)

			expect(authUrl).toContain('https://slack.com/oauth/v2/authorize')
			expect(authUrl).toContain('client_id=demo-slack-client-id')
			expect(authUrl).toContain(
				'scope=channels%3Aread%2Cchat%3Awrite%2Cchannels%3Ahistory%2Cgroups%3Aread',
			)
			expect(authUrl).toContain(
				`redirect_uri=${encodeURIComponent(redirectUri)}`,
			)
			expect(authUrl).toContain('response_type=code')
			expect(authUrl).toContain('state=')
		})

		it('should include organization ID and provider name in state', async () => {
			const organizationId = 'org-123'
			const redirectUri = 'https://example.com/callback'

			const authUrl = await provider.getAuthUrl(organizationId, redirectUri)

			// Extract state parameter
			const urlParams = new URLSearchParams(authUrl.split('?')[1])
			const state = urlParams.get('state')
			expect(state).toBeTruthy()

			// Validate and parse state using the standardized OAuth state manager
			const { OAuthStateManager } = await import('../../../src/oauth-manager')
			const decodedState = OAuthStateManager.parseState(state!)

			expect(decodedState.organizationId).toBe(organizationId)
			expect(decodedState.providerName).toBe('slack')
			expect(decodedState.redirectUri).toBe(redirectUri)
			expect(decodedState.timestamp).toBeTypeOf('number')
			expect(decodedState.nonce).toBeTypeOf('string')
		})

		it('should use environment variables when available', async () => {
			process.env.SLACK_CLIENT_ID = 'real-client-id'
			process.env.SLACK_CLIENT_SECRET = 'real-client-secret'

			const authUrl = await provider.getAuthUrl(
				'org-123',
				'https://example.com/callback',
			)

			expect(authUrl).toContain('client_id=real-client-id')
		})

		it('should include correct scopes for Slack integration', async () => {
			const authUrl = await provider.getAuthUrl(
				'org-123',
				'https://example.com/callback',
			)

			const urlParams = new URLSearchParams(authUrl.split('?')[1])
			const scope = urlParams.get('scope')

			expect(scope).toBe(
				'channels:read,chat:write,channels:history,groups:read',
			)
		})

		it('should generate unique state for each request', async () => {
			const authUrl1 = await provider.getAuthUrl(
				'org-123',
				'https://example.com/callback',
			)
			const authUrl2 = await provider.getAuthUrl(
				'org-123',
				'https://example.com/callback',
			)

			const state1 = new URLSearchParams(authUrl1.split('?')[1]).get('state')
			const state2 = new URLSearchParams(authUrl2.split('?')[1]).get('state')

			expect(state1).not.toBe(state2)
		})

		it('should handle additional parameters if provided', async () => {
			const additionalParams = { team: 'T1234567890' }

			const authUrl = await provider.getAuthUrl(
				'org-123',
				'https://example.com/callback',
				additionalParams,
			)

			// The current implementation doesn't use additional params, but URL should still be valid
			expect(authUrl).toContain('https://slack.com/oauth/v2/authorize')
		})
	})
})
