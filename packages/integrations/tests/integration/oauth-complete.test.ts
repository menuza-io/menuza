import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { integrationManager } from '../../src/integration-manager'
import { oauthFlow } from '../../src/oauth-flow'
import { OAuthStateManager } from '../../src/oauth-manager'
import '../../src/providers'
import { mockDb, queryChain, resetMockDb } from '../utils/mock-database'

// The nonce table is a database; an in-memory set keeps the same one-use rule.
const nonces = vi.hoisted(() => ({
	live: new Set<string>(),
	used: new Set<string>(),
}))
vi.mock('../../src/oauth-nonce-store.ts', () => ({
	registerOAuthNonce: async (nonce: string) => {
		nonces.live.add(nonce)
	},
	consumeOAuthNonce: async (nonce: string) => {
		if (!nonces.live.delete(nonce)) return false
		nonces.used.add(nonce)
		return true
	},
	isOAuthNonceConsumed: async (nonce: string) => nonces.used.has(nonce),
}))

const CALLBACK =
	'https://app.example.test/api/integrations/oauth/callback?provider=slack'

/**
 * The whole OAuth 2 round trip with the real state manager and the real Slack
 * provider (demo credentials, so no network): the provider validates the same
 * state again inside `handleCallback`, which must not count as a replay.
 */
describe('oauthFlow.complete', () => {
	beforeEach(() => {
		resetMockDb()
		OAuthStateManager.clearConsumedNonces()
		nonces.live.clear()
		nonces.used.clear()
		delete process.env.SLACK_CLIENT_ID
		delete process.env.SLACK_CLIENT_SECRET
		// The saved tokens are encrypted for real (tests/setup.ts sets a
		// placeholder key that is not one).
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', 'ab'.repeat(32))
		// Saving goes through the scoped lookups of the database layer, which this
		// suite does not mock; the state and organization checks are what it covers.
		vi.spyOn(integrationManager, 'createIntegration').mockResolvedValue({
			id: 'integration-1',
			organizationId: 'org-1',
			providerName: 'slack',
		} as never)
		vi.spyOn(integrationManager, 'logIntegrationActivity').mockResolvedValue(
			undefined as never,
		)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it('returns the state the provider will echo back', async () => {
		const { authUrl, state } = await oauthFlow.start('org-1', 'slack', CALLBACK)
		expect(new URL(authUrl).searchParams.get('state')).toBe(state)
	})

	it('connects when the provider validates the state itself', async () => {
		const { state } = await oauthFlow.start('org-1', 'slack', CALLBACK)
		await expect(
			oauthFlow.complete('slack', {
				organizationId: 'org-1',
				code: 'code-1',
				state,
			}),
		).resolves.toMatchObject({ id: 'integration-1' })
	})

	it('refuses a state started for another organization', async () => {
		const { state } = await oauthFlow.start('org-1', 'slack', CALLBACK)
		await expect(
			oauthFlow.complete('slack', {
				organizationId: 'org-2',
				code: 'code-1',
				state,
			}),
		).rejects.toThrow('Organization mismatch in OAuth state')
		expect(mockDb.insert).not.toHaveBeenCalled()
	})

	it('needs the organization the app verified', async () => {
		const { state } = await oauthFlow.start('org-1', 'slack', CALLBACK)
		await expect(
			oauthFlow.complete('slack', {
				organizationId: '',
				code: 'code-1',
				state,
			}),
		).rejects.toThrow('Missing organization')
		expect(mockDb.insert).not.toHaveBeenCalled()
	})
})
