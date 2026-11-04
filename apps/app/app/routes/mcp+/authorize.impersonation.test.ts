import {
	db,
	MCPClient,
	Organization,
	User,
	UserOrganization,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { loader } from './authorize.tsx'

const auth = vi.hoisted(() => ({
	getUserId: vi.fn(),
	getSessionUserId: vi.fn(),
}))
vi.mock('@repo/auth', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	...auth,
}))

async function seedUserWithOrg(label: string) {
	const id = `${label}${Math.random().toString(36).slice(2, 8)}`
	const [user] = await db
		.insert(User)
		.values({
			id: `u-${id}`,
			email: `${id}@example.com`,
			username: `user-${id}`,
			name: label,
		})
		.returning()
	const [org] = await db
		.insert(Organization)
		.values({ id: `o-${id}`, name: `Org ${id}`, slug: `org-${id}` })
		.returning()
	await db.insert(UserOrganization).values({
		userId: user!.id,
		organizationId: org!.id,
		organizationRoleId: 'org_role_member',
		active: true,
	})
	return { user: user!, org: org! }
}

describe('MCP consent while an administrator is impersonating', () => {
	it('shows the signed-in administrator, never the impersonated user', async () => {
		const admin = await seedUserWithOrg('admin')
		const target = await seedUserWithOrg('target')
		// getUserId would return the impersonation target; consent must not use it.
		auth.getUserId.mockResolvedValue(target.user.id)
		auth.getSessionUserId.mockResolvedValue(admin.user.id)

		const redirectUri = 'http://localhost:3000/callback'
		const clientId = `impersonation-${Math.random().toString(36).slice(2, 10)}`
		await db.insert(MCPClient).values({
			clientId,
			clientName: 'Test MCP',
			redirectUris: JSON.stringify([redirectUri]),
		})

		const url = new URL('https://app.example.test/mcp/authorize')
		url.searchParams.set('client_id', clientId)
		url.searchParams.set('redirect_uri', redirectUri)
		url.searchParams.set('code_challenge', 'x'.repeat(43))
		url.searchParams.set('code_challenge_method', 'S256')

		const data = (await loader({ request: new Request(url) } as any)) as {
			user: { id: string }
			organizations: Array<{ id: string }>
		}
		expect(data.user.id).toBe(admin.user.id)
		expect(data.organizations.map((o) => o.id)).toEqual([admin.org.id])
	})
})
