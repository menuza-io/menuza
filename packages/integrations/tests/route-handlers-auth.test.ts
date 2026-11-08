import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { integrationManager } from '../src/integration-manager'
import { handleJiraCurrentUser } from '../src/route-handlers/jira-current-user'
import { handleJiraSearchUsers } from '../src/route-handlers/jira-search-users'
import { handleUpdateIntegrationConfig } from '../src/route-handlers/update-config'
import { mockDb, queryChain, resetMockDb } from './utils/mock-database'

/**
 * The Jira bot-user routes act on the integration the request names (the one
 * on the settings page that is open). They check the member against that
 * integration's organization, not the member's default one: someone in
 * organizations A (default) and B who manages B can manage B's integration.
 */

const ORG_B = 'org-b'
const jiraInOrgB = {
	id: 'integration-b',
	organizationId: ORG_B,
	providerName: 'jira',
	providerType: 'productivity',
	accessToken: 'access-token-ciphertext',
	refreshToken: 'refresh-token-ciphertext',
	config: '{}',
}

function auth({ member = true, permitted = true } = {}) {
	return {
		requireUserId: vi.fn(async () => 'user-1'),
		// A member of A (their default) and, unless `member` is false, of B.
		isOrganizationMember: vi.fn(
			async (_userId: string, organizationId: string) =>
				organizationId === 'org-a' || (member && organizationId === ORG_B),
		),
		requireOrgPermission: vi.fn(async () => {
			if (!permitted) throw new Response('Forbidden', { status: 403 })
		}),
	}
}

function saveConfig(deps: ReturnType<typeof auth>) {
	const body = new FormData()
	body.set('intent', 'update-integration-config')
	body.set('integrationId', jiraInOrgB.id)
	body.set('config', JSON.stringify({ useBotUser: false }))
	const request = new Request('https://app.example/api/integrations/update', {
		method: 'POST',
		body,
	})
	return handleUpdateIntegrationConfig(
		{ request, params: {}, context: {} } as any,
		deps,
	)
}

function jiraRoute(
	handler: typeof handleJiraCurrentUser | typeof handleJiraSearchUsers,
	deps: ReturnType<typeof auth>,
) {
	const request = new Request(
		`https://app.example/api/integrations/jira/${jiraInOrgB.id}/x?query=ann`,
	)
	return handler(
		{ request, params: { integrationId: jiraInOrgB.id }, context: {} } as any,
		deps,
	)
}

beforeEach(() => {
	resetMockDb()
	mockDb.select.mockImplementation(() => queryChain([jiraInOrgB]))
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('update-config', () => {
	it("saves the config of an integration in the member's other organization", async () => {
		const deps = auth()

		const response = await saveConfig(deps)

		expect(response.status).toBe(200)
		const body = await response.text()
		expect(JSON.parse(body)).toEqual({ success: true })
		expect(body).not.toContain('ciphertext')
		expect(deps.requireOrgPermission).toHaveBeenCalledWith(
			expect.any(Request),
			ORG_B,
			'update:settings:any',
		)
		expect(mockDb.update).toHaveBeenCalled()
	})

	it("answers 404 to someone outside the integration's organization", async () => {
		const deps = auth({ member: false })

		const response = await saveConfig(deps)

		expect(response.status).toBe(404)
		expect(deps.requireOrgPermission).not.toHaveBeenCalled()
		expect(mockDb.update).not.toHaveBeenCalled()
	})

	it('answers 404 for an integration that does not exist', async () => {
		mockDb.select.mockImplementation(() => queryChain([]))
		const deps = auth()

		const response = await saveConfig(deps)

		expect(response.status).toBe(404)
		expect(mockDb.update).not.toHaveBeenCalled()
	})

	it('answers 403 to a member without the settings permission', async () => {
		const deps = auth({ permitted: false })

		const response = await saveConfig(deps)

		expect(response.status).toBe(403)
		expect(mockDb.update).not.toHaveBeenCalled()
	})
})

describe.each([
	['current-user', handleJiraCurrentUser, 'getCurrentUserDetails'],
	['search-users', handleJiraSearchUsers, 'searchUsers'],
] as const)('jira %s', (_name, handler, method) => {
	function stubJira() {
		const jira = { [method]: vi.fn(async () => ({ accountId: 'bot-1' })) }
		vi.spyOn(integrationManager, 'getProvider').mockReturnValue(jira as any)
		return jira[method]
	}

	it("serves an integration in the member's other organization", async () => {
		const call = stubJira()
		const deps = auth()

		const response = await jiraRoute(handler, deps)

		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ accountId: 'bot-1' })
		expect(call).toHaveBeenCalledWith(
			expect.objectContaining({ id: jiraInOrgB.id, organizationId: ORG_B }),
			...(method === 'searchUsers' ? ['ann'] : []),
		)
		expect(deps.requireOrgPermission).toHaveBeenCalledWith(
			expect.any(Request),
			ORG_B,
			'update:settings:any',
		)
	})

	it("answers 404 to someone outside the integration's organization", async () => {
		const call = stubJira()

		const response = await jiraRoute(handler, auth({ member: false }))

		expect(response.status).toBe(404)
		expect(call).not.toHaveBeenCalled()
	})

	it('answers 403 to a member without the settings permission', async () => {
		const call = stubJira()

		const response = await jiraRoute(handler, auth({ permitted: false }))

		expect(response.status).toBe(403)
		expect(call).not.toHaveBeenCalled()
	})
})
