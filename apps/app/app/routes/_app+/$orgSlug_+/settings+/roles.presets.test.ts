import {
	_OrganizationPermissionToRole,
	and,
	ConfigFlag,
	db,
	eq,
	inArray,
	OrganizationRole,
} from '@repo/database'
import { STAFFING_FLAG_KEYS } from '@repo/staffing'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
	getStaffingRolePreset,
	presetPermissionIds,
} from '#app/utils/staffing/role-presets.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './roles._index.tsx'

const flagIds: string[] = []

async function enableStaffing(organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: STAFFING_FLAG_KEYS.enabled,
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

function createPreset(slug: string, cookie: string, presetKey: string) {
	const formData = new FormData()
	formData.append('intent', 'create-staffing-preset')
	formData.append('presetKey', presetKey)
	return action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/settings/roles`,
			{ method: 'POST', body: formData },
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never) as Promise<{ message?: string; error?: string }>
}

async function load(slug: string, cookie: string) {
	return (await loader({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/settings/roles`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)) as unknown as {
		staffingPresets?: Array<{ key: string; name: string; exists: boolean }>
	}
}

async function findRole(organizationId: string, name: string) {
	const [row] = await db
		.select()
		.from(OrganizationRole)
		.where(
			and(
				eq(OrganizationRole.organizationId, organizationId),
				eq(OrganizationRole.name, name),
			),
		)
	return row
}

async function grantsOf(roleId: string) {
	const rows = await db
		.select({ id: _OrganizationPermissionToRole.B })
		.from(_OrganizationPermissionToRole)
		.where(eq(_OrganizationPermissionToRole.A, roleId))
	return rows.map((row) => row.id).sort()
}

describe('staffing role presets (admin action)', () => {
	it('shows no presets while the Staff module is off, and creates nothing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect(
			(await load(organization.slug, cookie)).staffingPresets,
		).toBeUndefined()
		await expect(
			createPreset(organization.slug, cookie, 'shift_manager'),
		).rejects.toMatchObject({ status: 404 })
		expect(await findRole(organization.id, 'Shift manager')).toBeUndefined()
	})

	it('creates each preset as an editable, tenant-owned custom role with its grants', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		for (const key of ['shift_manager', 'general_manager', 'hiring_manager']) {
			const preset = getStaffingRolePreset(key as never)
			const result = await createPreset(organization.slug, cookie, key)
			expect(result.error).toBeUndefined()
			const role = await findRole(organization.id, preset.name)
			expect(role).toBeTruthy()
			// A normal custom role: no built-in level, owned by this organization.
			expect(role!.organizationId).toBe(organization.id)
			expect(role!.level).toBe(0)
			expect(await grantsOf(role!.id)).toEqual(presetPermissionIds(preset))
		}
		const listed = await load(organization.slug, cookie)
		expect(listed.staffingPresets?.every((preset) => preset.exists)).toBe(true)
	})

	it('never overwrites a role an admin already made or edited', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		await createPreset(organization.slug, cookie, 'shift_manager')
		const role = await findRole(organization.id, 'Shift manager')
		await db
			.delete(_OrganizationPermissionToRole)
			.where(eq(_OrganizationPermissionToRole.A, role!.id))
		await db.insert(_OrganizationPermissionToRole).values({
			A: role!.id,
			B: 'org_perm_read_staff_any',
		})
		const again = await createPreset(organization.slug, cookie, 'shift_manager')
		expect(again.error).toMatch(/already exists/)
		expect(await grantsOf(role!.id)).toEqual(['org_perm_read_staff_any'])
	})

	it('is per organization: another organization’s role of the same name does not block it', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await enableStaffing(a.organization.id)
		await enableStaffing(b.organization.id)
		await createPreset(a.organization.slug, a.cookie, 'hiring_manager')
		const result = await createPreset(
			b.organization.slug,
			b.cookie,
			'hiring_manager',
		)
		expect(result.error).toBeUndefined()
		expect(await findRole(b.organization.id, 'Hiring manager')).toBeTruthy()
	})

	it('rejects an unknown preset key and anything but a real preset', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		for (const key of ['', 'admin', 'owner', 'Shift manager']) {
			const result = await createPreset(organization.slug, cookie, key)
			expect(result.error).toBeTruthy()
		}
		expect(await findRole(organization.id, 'Shift manager')).toBeUndefined()
	})

	it('is limited to built-in admins', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableStaffing(organization.id)
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(member.id)
		await expect(
			createPreset(organization.slug, cookie, 'general_manager'),
		).rejects.toMatchObject({ status: 403 })
		expect(await findRole(organization.id, 'General manager')).toBeUndefined()
	})
})
