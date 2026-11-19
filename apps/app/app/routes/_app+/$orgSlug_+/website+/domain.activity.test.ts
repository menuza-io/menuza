/**
 * #85: domain changes show up in Website, Activity with who made them.
 */
import { AuditAction, auditService } from '@repo/audit'
import { db, eq, Organization } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { removeCustomDomainActionIntent } from '#app/components/settings/cards/organization/site-card.tsx'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
} from '#tests/test-utils.ts'
import { action } from './_index.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return { ...actual, purgeOrganizationSiteCache: vi.fn() }
})

describe('domain changes in Activity', () => {
	it('removing the custom domain is logged with the member who did it', async () => {
		const user = await insertTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		await db
			.update(Organization)
			.set({ customDomain: `eats-${organization.id.slice(0, 8)}.example.com` })
			.where(eq(Organization.id, organization.id))
		const { cookie } = await createTestSession(user.id)
		const logSpy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		try {
			await action({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/website`,
					{
						method: 'POST',
						body: new URLSearchParams({
							intent: removeCustomDomainActionIntent,
						}),
					},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as never).catch((thrown: unknown) => thrown)
			const entry = logSpy.mock.calls
				.map(([call]) => call)
				.find((call) => call.action === AuditAction.WEBSITE_DOMAIN_CHANGED)
			expect(entry).toBeTruthy()
			expect(entry!.userId).toBe(user.id)
			expect(entry!.organizationId).toBe(organization.id)
			expect(entry!.details).toContain('Disconnected')
		} finally {
			logSpy.mockRestore()
		}
	})
})
