import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validateInstanceUrl } from '@repo/security'
import { queryChain, mockDb, resetMockDb } from './utils/mock-database'

vi.mock('@repo/database', () => {
	const table = new Proxy({}, { get: (_, property) => property })
	return {
		db: mockDb,
		Integration: table,
		and: vi.fn(),
		eq: vi.fn(),
	}
})

describe('Jira configuration protection', () => {
	beforeEach(() => {
		resetMockDb()
	})

	it('rejects non-HTTPS or credential-bearing Jira URLs', () => {
		expect(validateInstanceUrl('http://jira.atlassian.net').valid).toBe(false)
		expect(
			validateInstanceUrl('https://user:password@jira.atlassian.net').valid,
		).toBe(false)
	})

	it('rejects an untrusted Jira instance before updating the row', async () => {
		const { handleUpdateIntegrationConfig } =
			await import('../src/route-handlers/update-config')
		mockDb.select.mockImplementationOnce(() =>
			queryChain([
				{ id: 'integration-1', organizationId: 'org-1', providerName: 'jira' },
			]),
		)
		const formData = new FormData()
		formData.set('intent', 'update-integration-config')
		formData.set('integrationId', 'integration-1')
		formData.set(
			'config',
			JSON.stringify({ instanceUrl: 'https://attacker.example' }),
		)

		const response = await handleUpdateIntegrationConfig(
			{
				request: new Request('https://app.example/settings', {
					method: 'POST',
					body: formData,
				}),
				params: {},
				context: {},
			} as any,
			{
				requireUserId: vi.fn().mockResolvedValue('user-1'),
				isOrganizationMember: vi.fn().mockResolvedValue(true),
				requireOrgPermission: vi.fn().mockResolvedValue(undefined),
			},
		)

		expect(response.status).toBe(400)
		expect(mockDb.update).not.toHaveBeenCalled()
	})
})
