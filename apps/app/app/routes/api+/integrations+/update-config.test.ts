import { and, db, eq, Integration, UserOrganization } from '@repo/database'
import { describe, expect, it } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
} from '#tests/test-utils.ts'
import { action } from './update-config.ts'

/**
 * The Jira bot-user settings save through this route with the id of the
 * integration on the settings page that is open. The member is checked
 * against that integration's organization, not their default one, and the
 * answer never carries the stored tokens.
 */

const APP = 'http://localhost:3001'
const ORIGINAL_CONFIG = JSON.stringify({
	instanceUrl: 'https://acme.atlassian.net',
})

async function jiraIntegration(organizationId: string) {
	const [integration] = await db
		.insert(Integration)
		.values({
			organizationId,
			providerName: 'jira',
			providerType: 'productivity',
			accessToken: 'access-token-ciphertext',
			refreshToken: 'refresh-token-ciphertext',
			config: ORIGINAL_CONFIG,
		})
		.returning()
	if (!integration) throw new Error('Failed to create test integration')
	return integration
}

async function storedConfig(integrationId: string) {
	const [row] = await db
		.select({ config: Integration.config })
		.from(Integration)
		.where(eq(Integration.id, integrationId))
	return row?.config
}

async function saveConfig(cookie: string, integrationId: string) {
	const body = new FormData()
	body.set('intent', 'update-integration-config')
	body.set('integrationId', integrationId)
	body.set('config', JSON.stringify({ useBotUser: false }))
	const request = createAuthenticatedRequest(
		`${APP}/api/integrations/update-config`,
		{ method: 'POST', body },
		cookie,
	)
	try {
		return await action({ request, params: {}, context: {} } as any)
	} catch (error) {
		if (error instanceof Response) return error
		throw error
	}
}

describe('integration config route', () => {
	it('saves an integration of a member’s other (non-default) organization', async () => {
		const user = await insertTestUser()
		const home = await createTestOrganization(user.id, 'admin')
		await db
			.update(UserOrganization)
			.set({ isDefault: true })
			.where(
				and(
					eq(UserOrganization.userId, user.id),
					eq(UserOrganization.organizationId, home.id),
				),
			)
		const other = await createTestOrganization(user.id, 'admin')
		const integration = await jiraIntegration(other.id)
		const { cookie } = await createTestSession(user.id)

		const response = await saveConfig(cookie, integration.id)

		expect(response.status).toBe(200)
		const body = await response.text()
		expect(JSON.parse(body)).toEqual({ success: true })
		expect(body).not.toContain('token-ciphertext')
		await expect(storedConfig(integration.id)).resolves.toBe(
			JSON.stringify({ useBotUser: false }),
		)
	})

	it('answers 404 to someone outside the integration’s organization', async () => {
		const owner = await insertTestUser()
		const organization = await createTestOrganization(owner.id, 'admin')
		const integration = await jiraIntegration(organization.id)
		const outsider = await insertTestUser()
		await createTestOrganization(outsider.id, 'admin')
		const { cookie } = await createTestSession(outsider.id)

		const response = await saveConfig(cookie, integration.id)

		expect(response.status).toBe(404)
		await expect(storedConfig(integration.id)).resolves.toBe(ORIGINAL_CONFIG)
	})

	it('answers 403 to a member without the settings permission', async () => {
		const owner = await insertTestUser()
		const organization = await createTestOrganization(owner.id, 'admin')
		const integration = await jiraIntegration(organization.id)
		const member = await insertTestUser()
		await addOrganizationMember(member.id, organization.id)
		const { cookie } = await createTestSession(member.id)

		const response = await saveConfig(cookie, integration.id)

		expect(response.status).toBe(403)
		await expect(storedConfig(integration.id)).resolves.toBe(ORIGINAL_CONFIG)
	})
})
