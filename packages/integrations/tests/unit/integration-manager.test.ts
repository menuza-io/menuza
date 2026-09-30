import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryChain, mockDb, resetMockDb } from '../utils/mock-database'
import { MockProvider, createTestIntegration } from '../utils/test-helpers'

vi.mock('@repo/database', () => {
	const table = new Proxy({}, { get: (_, property) => property })
	const operator = vi.fn((...args: unknown[]) => args)
	return {
		db: mockDb,
		Integration: table,
		IntegrationLog: table,
		NoteIntegrationConnection: table,
		Organization: table,
		OrganizationNote: table,
		and: operator,
		count: operator,
		desc: operator,
		eq: operator,
		gte: operator,
		isNull: operator,
	}
})

vi.mock('../../src/encryption', () => ({
	encryptToken: vi.fn().mockResolvedValue('encrypted-token'),
	decryptToken: vi.fn().mockResolvedValue('decrypted-token'),
}))

import { IntegrationManager } from '../../src/integration-manager'
import { providerRegistry } from '../../src/provider'

describe('IntegrationManager with Drizzle', () => {
	let manager: IntegrationManager
	let provider: MockProvider

	beforeEach(() => {
		resetMockDb()
		manager = IntegrationManager.getInstance()
		provider = new MockProvider()
		manager.registerProvider(provider)
	})

	it('creates an integration through insert().values().returning()', async () => {
		const integration = createTestIntegration()
		mockDb.select.mockImplementationOnce(() => queryChain([]))
		mockDb.insert.mockImplementationOnce(() => queryChain([integration]))

		await expect(
			manager.createIntegration({
				organizationId: 'org-1',
				providerName: 'mock',
				tokenData: { accessToken: 'access-token' },
			}),
		).resolves.toEqual(integration)
		expect(mockDb.insert).toHaveBeenCalled()
	})

	it('hydrates an integration and its connection collection', async () => {
		const integration = createTestIntegration()
		mockDb.select
			.mockImplementationOnce(() => queryChain([integration]))
			.mockImplementationOnce(() => queryChain([]))
			.mockImplementationOnce(() => queryChain([]))

		const result = await manager.getIntegration(integration.id)

		expect(result).toMatchObject({ ...integration, connections: [] })
		expect(mockDb.select).toHaveBeenCalledTimes(3)
	})

	it('updates configuration and writes an activity log', async () => {
		const integration = createTestIntegration()
		mockDb.select.mockImplementationOnce(() =>
			queryChain([{ providerName: integration.providerName }]),
		)
		mockDb.update.mockImplementationOnce(() => queryChain([integration]))

		await expect(
			manager.updateIntegrationConfig(integration.id, { enabled: true }),
		).resolves.toEqual(integration)
		expect(mockDb.update).toHaveBeenCalled()
		expect(mockDb.insert).toHaveBeenCalled()
	})

	it('rejects channel lookup for a missing integration', async () => {
		mockDb.select.mockImplementationOnce(() => queryChain([]))

		await expect(manager.getAvailableChannels('missing')).rejects.toThrow(
			'Integration not found or inactive',
		)
	})

	it('keeps provider registration independent from database operations', () => {
		expect(manager.getProvider('mock')).toBe(provider)
		providerRegistry.unregister('mock')
	})
})
