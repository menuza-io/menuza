import { db, eq, UserOrganization } from '@repo/database'
import { describe, expect, it } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { executeTool, type MCPContext } from './server.server'
import './tools.server'

async function contextFor(role: 'admin' | 'member' | 'viewer' | 'guest') {
	const { user, organization } = await setupTestOrgWithUser(role)
	return { user, organization } as unknown as MCPContext
}

function text(result: { content: { text?: string }[] }) {
	return result.content.map((item) => item.text ?? '').join('\n')
}

// A token or API key proves membership only. Each tool checks, on every call,
// the permission its app page requires.
describe('MCP tool permissions', () => {
	it('refuses both tools to a guest, whose role grants neither permission', async () => {
		const context = await contextFor('guest')
		expect(
			text(await executeTool('find_user', { query: 'a' }, context)),
		).toMatch(/Permission denied: find_user needs the read:member:any/)
		expect(
			text(
				await executeTool(
					'get_user_notes',
					{ username: context.user.username },
					context,
				),
			),
		).toMatch(/Permission denied: get_user_notes needs the read:note:own/)
	})

	it('allows a member, and stops on the next call after a demotion', async () => {
		const context = await contextFor('member')
		expect(
			text(await executeTool('find_user', { query: 'zzz-none' }, context)),
		).not.toMatch(/Permission denied/)

		await db
			.update(UserOrganization)
			.set({ organizationRoleId: 'org_role_guest' })
			.where(eq(UserOrganization.userId, context.user.id))

		expect(
			text(await executeTool('find_user', { query: 'zzz-none' }, context)),
		).toMatch(/Permission denied/)
	})
})
