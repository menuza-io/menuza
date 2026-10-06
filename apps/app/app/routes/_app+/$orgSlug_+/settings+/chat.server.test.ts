import { db, eq, Organization } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { action, loader } from './chat.server.ts'

describe('tenant chat settings', () => {
	it('rejects retention changes submitted directly by a tenant admin', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		const { cookie } = await createTestSession(user.id)
		await db
			.update(Organization)
			.set({ chatRetentionDays: 90 })
			.where(eq(Organization.id, organization.id))

		const response = await action({
			request: createAuthenticatedRequest(
				`http://localhost:3001/${organization.slug}/settings/chat`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ intent: 'retention', days: 30 }),
				},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
			url: new URL(`http://localhost:3001/${organization.slug}/settings/chat`),
			pattern: '/:orgSlug/settings/chat',
		})

		expect(response).toEqual({ ok: false, error: 'Invalid request.' })
		const unchanged = await db.query.Organization.findFirst({
			where: eq(Organization.id, organization.id),
		})
		expect(unchanged?.chatRetentionDays).toBe(90)
	})

	it('returns channel settings without the platform retention policy', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		const { cookie } = await createTestSession(user.id)

		const response = await loader({
			request: createAuthenticatedRequest(
				`http://localhost:3001/${organization.slug}/settings/chat`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
			url: new URL(`http://localhost:3001/${organization.slug}/settings/chat`),
			pattern: '/:orgSlug/settings/chat',
		})

		expect(response.data).not.toHaveProperty('retentionDays')
		expect(response.data).toHaveProperty('channels')
	})
})
