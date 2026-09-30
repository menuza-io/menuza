import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockDb, queryChain } from '../utils/mock-database'

vi.mock('../../src/encryption', () => ({
	encryptToken: vi.fn().mockResolvedValue('encrypted-token'),
	decryptToken: vi.fn().mockResolvedValue('decrypted-token'),
}))

vi.mock('@repo/database', () => {
	const table = new Proxy({}, { get: (_, property) => property })
	return {
		db: mockDb,
		Integration: table,
		IntegrationLog: table,
		NoteIntegrationConnection: table,
		Organization: table,
		OrganizationNote: table,
		and: vi.fn(),
		count: vi.fn(),
		desc: vi.fn(),
		eq: vi.fn(),
		gte: vi.fn(),
		isNull: vi.fn(),
	}
})

vi.mock('../../src/oauth-manager', () => ({
	OAuthStateManager: {
		generateState: vi.fn().mockReturnValue('state-1'),
		registerStateNonce: vi.fn().mockResolvedValue(undefined),
		validateState: vi.fn().mockResolvedValue({
			organizationId: 'org-1',
			providerName: 'slack',
			timestamp: Date.now(),
		}),
	},
}))

import { oauthFlow } from '../../src/oauth-flow'
import { integrationManager } from '../../src/integration-manager'

describe('OAuth flow', () => {
	beforeEach(() => {
		process.env.SLACK_CLIENT_ID = 'test-client'
		process.env.SLACK_CLIENT_SECRET = 'test-secret'
	})

	it('delegates OAuth start to the registered provider', async () => {
		const provider = {
			name: 'oauth-test',
			type: 'productivity' as const,
			getAuthUrl: vi
				.fn()
				.mockResolvedValue('https://example.test/authorize?state=state-1'),
		} as any
		integrationManager.registerProvider(provider)

		await expect(
			oauthFlow.start('org-1', 'oauth-test', 'https://example.test/callback'),
		).resolves.toEqual({
			authUrl: 'https://example.test/authorize?state=state-1',
			state: 'state-1',
		})
		expect(provider.getAuthUrl).toHaveBeenCalled()
	})

	it('deduplicates concurrent callbacks for the same state', async () => {
		const integration = {
			id: 'int-1',
			organizationId: 'org-1',
			providerName: 'slack',
		}
		mockDb.select.mockImplementation(() => queryChain([]))
		mockDb.insert.mockImplementation(() => queryChain([integration] as any))

		let calls = 0
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const provider = {
			name: 'slack',
			type: 'productivity' as const,
			handleCallback: vi.fn(async () => {
				calls++
				await gate
				return { accessToken: 'token' }
			}),
		}
		integrationManager.registerProvider(provider as any)

		const params = { organizationId: 'org-1', code: 'code', state: 'state-1' }
		const first = oauthFlow.complete('slack', params)
		const second = oauthFlow.complete('slack', params)
		release()

		const [a, b] = await Promise.all([first, second])
		expect(calls).toBe(1)
		expect(provider.handleCallback).toHaveBeenCalledTimes(1)
		expect(a).toEqual(b)
	})

	it('rejects a callback whose state belongs to another provider', async () => {
		const provider = {
			name: 'jira',
			type: 'productivity' as const,
		} as any
		integrationManager.registerProvider(provider)

		await expect(
			oauthFlow.complete('jira', {
				organizationId: 'org-1',
				code: 'code',
				state: 'state-1',
			}),
		).rejects.toThrow('Provider name mismatch in OAuth state')
	})
})
