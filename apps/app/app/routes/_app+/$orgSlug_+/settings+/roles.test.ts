import { and, db, eq, OrganizationRole } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader as viewLoader } from './roles.$roleId.tsx'
import { action as editAction } from './roles.$roleId_.edit.tsx'
import {
	action as deleteAction,
	loader as indexLoader,
} from './roles._index.tsx'
import { action as createAction } from './roles.new.tsx'

function createRoleRequest(
	url: string,
	cookie: string,
	values: Record<string, string | string[]>,
) {
	const formData = new FormData()
	for (const [key, value] of Object.entries(values)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			formData.append(key, item)
		}
	}
	return createAuthenticatedRequest(
		url,
		{ method: 'POST', body: formData },
		cookie,
	)
}

describe('settings/roles route integration', () => {
	it('lets a built-in organization admin load, create, view, update, and delete a custom role across dedicated routes', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const roleName = `Content editor ${crypto.randomUUID().slice(0, 8)}`

		// 1. Index loader
		const loadResult = await indexLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as any)
		expect(loadResult.roles.some((role) => role.id === 'org_role_admin')).toBe(
			true,
		)

		// 2. Create role via roles.new action
		const createResponse = await createAction({
			request: createRoleRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/new`,
				cookie,
				{
					name: roleName,
					description: 'Can edit notes and website content.',
					permissionIds: ['org_perm_create_note_own'],
				},
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as any)
		// Creation redirects back to roles list with toast
		expect(createResponse).toBeInstanceOf(Response)
		const res = createResponse as Response
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(
			`/${organization.slug}/settings/roles`,
		)

		// 3. Post-create index check
		const postCreateLoad = await indexLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as any)

		// Custom roles must appear above built-in roles
		const firstCustomIndex = postCreateLoad.roles.findIndex((r) => !r.isBuiltIn)
		const firstBuiltInIndex = postCreateLoad.roles.findIndex((r) => r.isBuiltIn)
		expect(firstCustomIndex).toBeGreaterThanOrEqual(0)
		expect(firstCustomIndex).toBeLessThan(firstBuiltInIndex)

		// Built-in roles must expose their assigned permissions for read-only inspection
		const adminRole = postCreateLoad.roles.find(
			(r) => r.id === 'org_role_admin',
		)
		expect(adminRole).toBeDefined()
		expect(adminRole!.isBuiltIn).toBe(true)
		expect(adminRole!.permissionIds.length).toBeGreaterThan(0)

		const [created] = await db
			.select()
			.from(OrganizationRole)
			.where(
				and(
					eq(OrganizationRole.organizationId, organization.id),
					eq(OrganizationRole.name, roleName),
				),
			)
			.limit(1)
		expect(created).toBeDefined()

		// 4. View role via roles.$roleId loader
		const viewResult = await viewLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/${created!.id}`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug, roleId: created!.id },
			context: {},
		} as any)
		expect(viewResult.role.id).toBe(created!.id)
		expect(viewResult.role.permissionIds).toContain('org_perm_create_note_own')
		expect(viewResult.canEdit).toBe(true)

		// 5. Update role via roles.$roleId_.edit action
		const updateResponse = await editAction({
			request: createRoleRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/${created!.id}/edit`,
				cookie,
				{
					name: `${roleName} updated`,
					description: 'Updated description.',
					permissionIds: ['org_perm_read_note_org'],
				},
			),
			params: { orgSlug: organization.slug, roleId: created!.id },
			context: {},
		} as any)
		expect(updateResponse).toBeInstanceOf(Response)
		expect((updateResponse as Response).status).toBe(302)

		// 6. Delete role via roles._index action
		const deleteResult = await deleteAction({
			request: createRoleRequest(
				`http://localhost:3000/${organization.slug}/settings/roles`,
				cookie,
				{
					intent: 'delete-role',
					roleId: created!.id,
				},
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as any)
		expect(deleteResult).toMatchObject({ message: 'Role deleted.' })
	})

	it('denies an ordinary member access to admin role management', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('member')
		await expect(
			indexLoader({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/settings/roles`,
					{},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as any),
		).rejects.toMatchObject({ status: 403 })
	})

	it('rejects crafted foreign-role updates and deletes', async () => {
		const first = await setupTestOrgWithUser('admin')
		const second = await setupTestOrgWithUser('admin')
		const [foreignRole] = await db
			.insert(OrganizationRole)
			.values({
				organizationId: second.organization.id,
				name: `Foreign ${crypto.randomUUID().slice(0, 8)}`,
				description: '',
				level: 0,
			})
			.returning()

		try {
			await expect(
				editAction({
					request: createRoleRequest(
						`http://localhost:3000/${first.organization.slug}/settings/roles/${foreignRole!.id}/edit`,
						first.cookie,
						{
							name: 'Attempted edit',
							description: '',
						},
					),
					params: {
						orgSlug: first.organization.slug,
						roleId: foreignRole!.id,
					},
					context: {},
				} as any),
			).rejects.toMatchObject({ status: 404 })

			const deleteResult = await deleteAction({
				request: createRoleRequest(
					`http://localhost:3000/${first.organization.slug}/settings/roles`,
					first.cookie,
					{
						intent: 'delete-role',
						roleId: foreignRole!.id,
					},
				),
				params: { orgSlug: first.organization.slug },
				context: {},
			} as any)
			expect(deleteResult).toMatchObject({
				error: 'This custom role was not found.',
			})
		} finally {
			await db
				.delete(OrganizationRole)
				.where(eq(OrganizationRole.id, foreignRole!.id))
		}
	})
})
