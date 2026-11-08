import type * as DatabaseModule from '@repo/database'
import {
	_OrganizationPermissionToRole,
	db,
	eq,
	OrganizationRole,
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

/**
 * Workers path: `isD1Bound()` is true and `db.transaction` is not atomic
 * there, so the edit must use one `db.batch`. The proxy appends a failing
 * statement to the batch (the real batch is one transaction, like D1's).
 */
const control = vi.hoisted(() => ({
	failBatch: false,
	batches: 0,
	transactions: 0,
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	return {
		...actual,
		isD1Bound: () => true,
		db: new Proxy(actual.db, {
			get(target, prop, receiver) {
				if (prop === 'transaction') {
					return (...args: any[]) => {
						control.transactions += 1
						return (target.transaction as any)(...args)
					}
				}
				if (prop === 'batch') {
					return (statements: any[]) => {
						control.batches += 1
						const all = control.failBatch
							? [
									...statements,
									target.run(actual.sql`insert into no_such_table values (1)`),
								]
							: statements
						return target.batch(all as any)
					}
				}
				return Reflect.get(target, prop, receiver)
			},
		}),
	}
})

import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action as editAction } from './roles.$roleId_.edit.tsx'
import { action as createAction } from './roles.new.tsx'

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

describe('role edit on D1', () => {
	it('keeps the previous name and permission links when the batch fails, and swaps them when it succeeds', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const base = `http://localhost:3000/${organization.slug}/settings/roles`
		const name = `D1 role ${crypto.randomUUID().slice(0, 8)}`
		await createAction({
			request: roleRequest(`${base}/new`, cookie, {
				name,
				description: 'Original.',
				permissionIds: ['org_perm_create_note_own'],
			}),
			params: { orgSlug: organization.slug },
			context: {},
		} as any)
		const [role] = await db
			.select()
			.from(OrganizationRole)
			.where(eq(OrganizationRole.name, name))
		const links = async () =>
			(
				await db
					.select({ id: _OrganizationPermissionToRole.B })
					.from(_OrganizationPermissionToRole)
					.where(eq(_OrganizationPermissionToRole.A, role!.id))
			).map((row) => row.id)
		expect(await links()).toEqual(['org_perm_create_note_own'])

		const edit = (values: Record<string, string | string[]>) =>
			editAction({
				request: roleRequest(`${base}/${role!.id}/edit`, cookie, values),
				params: { orgSlug: organization.slug, roleId: role!.id },
				context: {},
			} as any)

		control.batches = 0
		control.transactions = 0
		control.failBatch = true
		await expect(
			edit({
				name: `${name} changed`,
				description: 'Changed.',
				permissionIds: ['org_perm_read_note_org'],
			}),
		).rejects.toThrow()
		control.failBatch = false
		expect(await links()).toEqual(['org_perm_create_note_own'])
		const [unchanged] = await db
			.select()
			.from(OrganizationRole)
			.where(eq(OrganizationRole.id, role!.id))
		expect(unchanged?.name).toBe(name)

		const response = (await edit({
			name: `${name} changed`,
			description: 'Changed.',
			permissionIds: ['org_perm_read_note_org'],
		})) as Response
		expect(response.status).toBe(302)
		expect(await links()).toEqual(['org_perm_read_note_org'])
		expect(control.batches).toBe(2)
		expect(control.transactions).toBe(0)
	})
})

describe('role create on D1', () => {
	it('leaves no orphan role when the batch fails', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const base = `http://localhost:3000/${organization.slug}/settings/roles`
		const name = `D1 create ${crypto.randomUUID().slice(0, 8)}`
		const create = () =>
			createAction({
				request: roleRequest(`${base}/new`, cookie, {
					name,
					description: 'New.',
					permissionIds: ['org_perm_create_note_own'],
				}),
				params: { orgSlug: organization.slug },
				context: {},
			} as any)
		const count = async () =>
			(
				await db
					.select()
					.from(OrganizationRole)
					.where(eq(OrganizationRole.name, name))
			).length

		control.failBatch = true
		await expect(create()).rejects.toThrow()
		control.failBatch = false
		expect(await count()).toBe(0)

		control.transactions = 0
		const response = (await create()) as Response
		expect(response.status).toBe(302)
		expect(await count()).toBe(1)
		expect(control.transactions).toBe(0)
	})
})
