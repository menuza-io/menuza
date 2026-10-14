import {
	ConfigFlag,
	db,
	eq,
	inArray,
	OrganizationRole,
	_OrganizationPermissionToRole,
} from '@repo/database'
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
import { action as editAction } from './roles.$roleId_.edit.tsx'
import { action as createAction, loader as newLoader } from './roles.new.tsx'

function roleRequest(
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

async function grantsOf(roleId: string) {
	const rows = await db
		.select({ id: _OrganizationPermissionToRole.B })
		.from(_OrganizationPermissionToRole)
		.where(eq(_OrganizationPermissionToRole.A, roleId))
	return rows.map((r) => r.id).sort()
}

async function findRole(organizationId: string, name: string) {
	const rows = await db
		.select({
			id: OrganizationRole.id,
			name: OrganizationRole.name,
			organizationId: OrganizationRole.organizationId,
		})
		.from(OrganizationRole)
		.where(eq(OrganizationRole.organizationId, organizationId))
	return rows.find((r) => r.name === name)
}

describe('staffing permissions in the role editor actions', () => {
	it('stores the read grant that an update grant implies, even if the form omits it', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const name = `Pay manager ${crypto.randomUUID().slice(0, 8)}`
		const response = (await createAction({
			request: roleRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/new`,
				cookie,
				{
					name,
					description: '',
					permissionIds: [
						'org_perm_update_staff_pay_any',
						'org_perm_approve_timesheet_any',
					],
				},
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as any)) as Response
		expect(response.status).toBe(302)
		const role = await findRole(organization.id, name)
		expect(await grantsOf(role!.id)).toEqual([
			'org_perm_approve_timesheet_any',
			'org_perm_read_staff_pay_any',
			'org_perm_read_timesheet_any',
			'org_perm_update_staff_pay_any',
		])
	})

	it('adds implied read grants when a role is edited', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const name = `Scheduler ${crypto.randomUUID().slice(0, 8)}`
		await createAction({
			request: roleRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/new`,
				cookie,
				{
					name,
					description: '',
					permissionIds: ['org_perm_read_note_own'],
				},
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as any)
		const role = await findRole(organization.id, name)
		const response = (await editAction({
			request: roleRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/${role!.id}/edit`,
				cookie,
				{
					name,
					description: '',
					permissionIds: ['org_perm_update_schedule_any'],
				},
			),
			params: { orgSlug: organization.slug, roleId: role!.id },
			context: {},
		} as any)) as Response
		expect(response.status).toBe(302)
		expect(await grantsOf(role!.id)).toEqual([
			'org_perm_read_schedule_any',
			'org_perm_update_schedule_any',
		])
	})

	it('grants nothing from a crafted form that mixes in a non-custom permission', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const name = `Crafted ${crypto.randomUUID().slice(0, 8)}`
		const result = (await createAction({
			request: roleRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/new`,
				cookie,
				{
					name,
					description: '',
					permissionIds: [
						'org_perm_read_staff_any',
						'org_perm_update_member_any',
					],
				},
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as any)) as { error?: string }
		expect(result.error).toMatch(/not available for custom roles/)
		expect(await findRole(organization.id, name)).toBeUndefined()
	})

	it('keeps staffing role management to built-in admins', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('member')
		await expect(
			createAction({
				request: roleRequest(
					`http://localhost:3000/${organization.slug}/settings/roles/new`,
					cookie,
					{
						name: 'Sneaky',
						description: '',
						permissionIds: ['org_perm_update_staff_pay_any'],
					},
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as any),
		).rejects.toMatchObject({ status: 403 })
		expect(
			await db
				.select()
				.from(OrganizationRole)
				.where(inArray(OrganizationRole.name, ['Sneaky'])),
		).toHaveLength(0)
	})
})

describe('staffing in the role editor loader', () => {
	it('keeps the staff groups hidden until the master flag is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const load = () =>
			newLoader({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/settings/roles/new`,
					{},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as any) as Promise<{ staffingEnabled: boolean }>

		expect((await load()).staffingEnabled).toBe(false)

		// A child flag alone does not count.
		const [child] = await db
			.insert(ConfigFlag)
			.values({
				key: 'staffing.hiring',
				value: true,
				level: 'organization',
				organizationId: organization.id,
			})
			.returning({ id: ConfigFlag.id })
		expect((await load()).staffingEnabled).toBe(false)

		const [master] = await db
			.insert(ConfigFlag)
			.values({
				key: 'staffing.enabled',
				value: true,
				level: 'organization',
				organizationId: organization.id,
			})
			.returning({ id: ConfigFlag.id })
		expect((await load()).staffingEnabled).toBe(true)

		await db
			.delete(ConfigFlag)
			.where(inArray(ConfigFlag.id, [child!.id, master!.id]))
	})
})
