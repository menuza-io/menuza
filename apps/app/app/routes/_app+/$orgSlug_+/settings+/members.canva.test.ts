import { db, eq, PrintCanvaConnection, UserOrganization } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'

vi.mock('@repo/common/onboarding', () => ({
	markStepCompleted: vi.fn().mockResolvedValue(undefined),
}))

// Only the Canva boundary is stubbed: the revoke call goes to canva.com.
const canva = vi.hoisted(() => ({ revoke: vi.fn(async () => {}) }))
vi.mock('#app/utils/print/canva/client.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	revokeCanvaToken: canva.revoke,
}))

const { saveCanvaConnection } =
	await import('#app/utils/print/canva/connection.server.ts')
const { action } = await import('./members.tsx')

describe('removing a member', () => {
	it("forgets and revokes the member's Canva connection in this organization", async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const member = await createTestUser()
		await db.insert(UserOrganization).values({
			userId: member.id,
			organizationId: organization.id,
			organizationRoleId: 'org_role_member',
			active: true,
		})
		await saveCanvaConnection(
			{ userId: member.id, organization: { id: organization.id } },
			{
				accessToken: 'access-member',
				refreshToken: 'refresh-member',
				expiresAt: new Date(Date.now() + 3_600_000),
				scope: 'design:meta:read',
			},
			{ userId: null, displayName: null },
		)

		const formData = new FormData()
		formData.append('intent', 'remove-member')
		formData.append('userId', member.id)
		const response = (await action({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/members`,
				{ method: 'POST', body: formData },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as any)) as Response
		expect(getResponseStatus(response)).toBe(200)

		const rows = await db
			.select({ id: PrintCanvaConnection.id })
			.from(PrintCanvaConnection)
			.where(eq(PrintCanvaConnection.userId, member.id))
		expect(rows).toHaveLength(0)
		expect(canva.revoke).toHaveBeenCalledWith('refresh-member')
	})
})
