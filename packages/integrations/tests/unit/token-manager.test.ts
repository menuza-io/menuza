import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryChain, mockDb, resetMockDb } from '../utils/mock-database'

vi.mock('@repo/database', () => {
	const table = new Proxy({}, { get: (_, property) => property })
	const operator = vi.fn((...args: unknown[]) => args)
	return {
		db: mockDb,
		Integration: table,
		IntegrationLog: table,
		and: operator,
		eq: operator,
		isNotNull: operator,
	}
})

vi.mock('../../src/encryption', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/encryption')>()
	return {
		...actual,
		integrationEncryption: {
			encryptTokenData: vi.fn(),
			decryptTokenData: vi.fn(),
			validateToken: vi.fn(),
		},
	}
})

import { integrationEncryption } from '../../src/encryption'
import { type IntegrationProvider } from '../../src/provider'
import { tokenManager } from '../../src/token-manager'

describe('TokenManager with Drizzle', () => {
	beforeEach(() => {
		resetMockDb()
		vi.mocked(integrationEncryption.encryptTokenData).mockResolvedValue({
			encryptedAccessToken: 'encrypted-access',
			encryptedRefreshToken: 'encrypted-refresh',
			expiresAt: new Date(),
			iv: 'iv',
		})
		vi.mocked(integrationEncryption.decryptTokenData).mockResolvedValue({
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
		})
		vi.mocked(integrationEncryption.validateToken).mockReturnValue({
			isValid: true,
			needsRefresh: false,
		})
	})

	it('stores encrypted token data with an update query', async () => {
		const result = await tokenManager.storeTokenData('integration-1', {
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
		})

		expect(result).toEqual({ success: true })
		expect(mockDb.update).toHaveBeenCalled()
	})

	it('loads and decrypts token data from a selected integration', async () => {
		mockDb.select.mockImplementationOnce(() =>
			queryChain([
				{
					accessToken: 'encrypted-access',
					refreshToken: 'encrypted-refresh',
					tokenExpiresAt: null,
					config: JSON.stringify({ scope: 'read' }),
				},
			]),
		)

		await expect(tokenManager.getTokenData('integration-1')).resolves.toEqual({
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
		})
		expect(mockDb.select).toHaveBeenCalled()
	})

	it('identifies integrations whose expiry is within five minutes', async () => {
		mockDb.select.mockImplementationOnce(() =>
			queryChain([
				{ id: 'soon', tokenExpiresAt: new Date(Date.now() + 60_000) },
				{ id: 'later', tokenExpiresAt: new Date(Date.now() + 3_600_000) },
			]),
		)

		await expect(
			tokenManager.checkTokensNeedingRefresh('organization-1'),
		).resolves.toEqual(['soon'])
	})

	it('keeps a valid connection active after a transient refresh failure', async () => {
		mockDb.select.mockImplementationOnce(() =>
			queryChain([
				{
					accessToken: 'encrypted-access',
					refreshToken: 'encrypted-refresh',
					tokenExpiresAt: new Date(Date.now() + 60_000),
					config: '{}',
				},
			]),
		)
		vi.mocked(integrationEncryption.validateToken).mockReturnValue({
			isValid: true,
			needsRefresh: true,
		})
		const provider = {
			name: 'test',
			refreshToken: vi
				.fn()
				.mockRejectedValue(new Error('temporary provider failure')),
		} as unknown as IntegrationProvider
		await expect(
			tokenManager.getValidAccessToken('integration-1', provider),
		).resolves.toBe('access-token')
		expect(mockDb.update).not.toHaveBeenCalled()
	})

	it('returns null when a token record cannot be loaded', async () => {
		mockDb.select.mockImplementationOnce(() => queryChain([]))

		await expect(tokenManager.getTokenData('missing')).resolves.toBeNull()
	})
})
