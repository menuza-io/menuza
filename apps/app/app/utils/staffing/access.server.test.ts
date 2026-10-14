import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
	and,
	ConfigFlag,
	db,
	eq,
	inArray,
	OrganizationRole,
	Permission,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import {
	STAFFING_FLAG_KEYS,
	STAFFING_PERMISSION_LIST,
	STAFFING_PERMISSIONS,
	type StaffingFeature,
} from '@repo/staffing'
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
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	getStaffingFeatureState,
	getStaffingNavAccess,
	isStaffingFeatureEnabled,
	requireStaffingAccess,
	requireStaffingFeature,
	userHasStaffingPermission,
} from './access.server.ts'
import { STAFF_SECTION_REQUIREMENTS } from './sections.ts'

const createdFlagIds: string[] = []

async function setFlag(
	feature: StaffingFeature,
	organizationId: string | null,
	value: unknown = true,
) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: STAFFING_FLAG_KEYS[feature],
			value,
			level: organizationId ? 'organization' : 'system',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	createdFlagIds.push(row!.id)
}

async function enableAll(organizationId: string) {
	for (const feature of Object.keys(STAFFING_FLAG_KEYS) as StaffingFeature[]) {
		await setFlag(feature, organizationId)
	}
}

async function createCustomRole(
	organizationId: string,
	permissionIds: string[],
) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	if (permissionIds.length) {
		await db
			.insert(_OrganizationPermissionToRole)
			.values(
				permissionIds.map((permissionId) => ({ A: role!.id, B: permissionId })),
			)
	}
	return role!.id
}

async function memberWithRole(organizationId: string, roleId: string) {
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, roleId)
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

function req(slug: string, cookie: string) {
	return createAuthenticatedRequest(
		`http://localhost:3000/${slug}/staff/team`,
		{},
		cookie,
	)
}

async function statusOf(promise: Promise<unknown>): Promise<number | 'ok'> {
	try {
		await promise
		return 'ok'
	} catch (error) {
		if (error instanceof Response) return error.status
		throw error
	}
}

afterEach(async () => {
	if (createdFlagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, createdFlagIds))
		createdFlagIds.length = 0
	}
})

describe('staffing feature flags', () => {
	it('are all off by default for an organization with no flag rows', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		expect(await getStaffingFeatureState(organization.id)).toEqual({
			enabled: false,
			timeclock: false,
			scheduling: false,
			labor: false,
			hiring: false,
		})
		for (const feature of Object.keys(
			STAFFING_FLAG_KEYS,
		) as StaffingFeature[]) {
			expect(await isStaffingFeatureEnabled(organization.id, feature)).toBe(
				false,
			)
			expect(
				await statusOf(requireStaffingFeature(organization.id, feature)),
			).toBe(404)
		}
	})

	it('hides every route from a built-in admin while the master flag is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		for (const requirement of Object.values(STAFF_SECTION_REQUIREMENTS)) {
			expect(
				await statusOf(
					requireStaffingAccess(
						req(organization.slug, cookie),
						organization.slug,
						requirement,
					),
				),
			).toBe(404)
		}
	})

	it('needs the master flag even when a child flag is on', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag('timeclock', organization.id)
		await setFlag('hiring', organization.id)
		expect((await getStaffingFeatureState(organization.id)).timeclock).toBe(
			false,
		)
		expect(await isStaffingFeatureEnabled(organization.id, 'timeclock')).toBe(
			false,
		)
	})

	it('turns on only the children that are set once the master is on', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		await setFlag('scheduling', organization.id)
		expect(await getStaffingFeatureState(organization.id)).toEqual({
			enabled: true,
			timeclock: false,
			scheduling: true,
			labor: false,
			hiring: false,
		})
	})

	it.each([['true'], [1], ['yes'], [{}], [false]])(
		'does not treat the stored value %j as on',
		async (value) => {
			const { organization } = await setupTestOrgWithUser('admin')
			await setFlag('enabled', organization.id, value)
			expect(await isStaffingFeatureEnabled(organization.id)).toBe(false)
		},
	)

	it('does not leak a flag from one organization to another', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await enableAll(a.organization.id)
		expect(await isStaffingFeatureEnabled(a.organization.id)).toBe(true)
		expect(await isStaffingFeatureEnabled(b.organization.id)).toBe(false)
		// A's admin cannot use B's slug to reach B's staffing either.
		expect(
			await statusOf(
				requireStaffingAccess(
					req(b.organization.slug, a.cookie),
					b.organization.slug,
					STAFF_SECTION_REQUIREMENTS.team,
				),
			),
		).toBe(404)
	})

	it('lets an organization flag of false override a system-wide true', async () => {
		const on = await setupTestOrgWithUser('admin')
		const off = await setupTestOrgWithUser('admin')
		await setFlag('enabled', null, true)
		await setFlag('enabled', off.organization.id, false)
		expect(await isStaffingFeatureEnabled(on.organization.id)).toBe(true)
		expect(await isStaffingFeatureEnabled(off.organization.id)).toBe(false)
	})
})

describe('requireStaffingAccess permissions', () => {
	it('lets a built-in admin into every section when everything is on', async () => {
		const { organization, cookie, user } = await setupTestOrgWithUser('admin')
		await enableAll(organization.id)
		for (const requirement of Object.values(STAFF_SECTION_REQUIREMENTS)) {
			const result = await requireStaffingAccess(
				req(organization.slug, cookie),
				organization.slug,
				requirement,
			)
			expect(result.organizationId).toBe(organization.id)
			expect(result.userId).toBe(user.id)
		}
	})

	it('refuses a built-in member, viewer, and guest with 403 even when flags are on', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableAll(organization.id)
		for (const roleId of [
			'org_role_member',
			'org_role_viewer',
			'org_role_guest',
		]) {
			const { cookie } = await memberWithRole(organization.id, roleId)
			for (const requirement of Object.values(STAFF_SECTION_REQUIREMENTS)) {
				expect(
					await statusOf(
						requireStaffingAccess(
							req(organization.slug, cookie),
							organization.slug,
							requirement,
						),
					),
				).toBe(403)
			}
		}
	})

	it('treats the inert own-scope grants as no access to the manager sections', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableAll(organization.id)
		const roleId = await createCustomRole(organization.id, [
			'org_perm_read_schedule_own',
			'org_perm_create_timeclock_own',
		])
		const { cookie } = await memberWithRole(organization.id, roleId)
		expect(
			await statusOf(
				requireStaffingAccess(
					req(organization.slug, cookie),
					organization.slug,
					STAFF_SECTION_REQUIREMENTS.schedule,
				),
			),
		).toBe(403)
	})

	it('gives a custom role only the sections it was granted', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableAll(organization.id)
		const roleId = await createCustomRole(organization.id, [
			'org_perm_read_schedule_any',
		])
		const { cookie, user } = await memberWithRole(organization.id, roleId)
		const r = (
			requirement: (typeof STAFF_SECTION_REQUIREMENTS)[keyof typeof STAFF_SECTION_REQUIREMENTS],
		) =>
			statusOf(
				requireStaffingAccess(
					req(organization.slug, cookie),
					organization.slug,
					requirement,
				),
			)
		expect(await r(STAFF_SECTION_REQUIREMENTS.schedule)).toBe('ok')
		expect(await r(STAFF_SECTION_REQUIREMENTS.team)).toBe(403)
		expect(await r(STAFF_SECTION_REQUIREMENTS.timeclock)).toBe(403)
		expect(await r(STAFF_SECTION_REQUIREMENTS.hiring)).toBe(403)
		expect(
			await userHasStaffingPermission(
				user.id,
				organization.id,
				STAFFING_PERMISSIONS.READ_STAFF_PAY,
			),
		).toBe(false)
	})

	it('does not let schedule access imply pay, private, or labor access', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const roleId = await createCustomRole(organization.id, [
			'org_perm_read_staff_any',
			'org_perm_update_schedule_any',
			'org_perm_read_member_any',
		])
		const { user } = await memberWithRole(organization.id, roleId)
		const has = (
			p: (typeof STAFFING_PERMISSIONS)[keyof typeof STAFFING_PERMISSIONS],
		) => userHasStaffingPermission(user.id, organization.id, p)
		expect(await has(STAFFING_PERMISSIONS.READ_STAFF)).toBe(true)
		expect(await has(STAFFING_PERMISSIONS.READ_SCHEDULE)).toBe(true) // update implies read
		expect(await has(STAFFING_PERMISSIONS.UPDATE_SCHEDULE)).toBe(true)
		expect(await has(STAFFING_PERMISSIONS.READ_STAFF_PAY)).toBe(false)
		expect(await has(STAFFING_PERMISSIONS.READ_STAFF_PRIVATE)).toBe(false)
		expect(await has(STAFFING_PERMISSIONS.READ_LABOR)).toBe(false)
		expect(await has(STAFFING_PERMISSIONS.UPDATE_STAFF)).toBe(false)
		expect(await has(STAFFING_PERMISSIONS.APPROVE_TIMESHEET)).toBe(false)
	})

	it('lets approve satisfy a time card read, but never the reverse', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const approver = await memberWithRole(
			organization.id,
			await createCustomRole(organization.id, [
				'org_perm_approve_timesheet_any',
			]),
		)
		const reader = await memberWithRole(
			organization.id,
			await createCustomRole(organization.id, ['org_perm_read_timesheet_any']),
		)
		expect(
			await userHasStaffingPermission(
				approver.user.id,
				organization.id,
				STAFFING_PERMISSIONS.READ_TIMESHEET,
			),
		).toBe(true)
		expect(
			await userHasStaffingPermission(
				reader.user.id,
				organization.id,
				STAFFING_PERMISSIONS.APPROVE_TIMESHEET,
			),
		).toBe(false)
	})

	it('refuses a deactivated member, a non-member, and an anonymous request', async () => {
		const { organization, user, cookie } = await setupTestOrgWithUser('admin')
		await enableAll(organization.id)
		const outsider = await setupTestOrgWithUser('admin')
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(
				and(
					eq(UserOrganization.userId, user.id),
					eq(UserOrganization.organizationId, organization.id),
				),
			)
		const requirement = STAFF_SECTION_REQUIREMENTS.team
		expect(
			await statusOf(
				requireStaffingAccess(
					req(organization.slug, cookie),
					organization.slug,
					requirement,
				),
			),
		).toBe(404)
		expect(
			await statusOf(
				requireStaffingAccess(
					req(organization.slug, outsider.cookie),
					organization.slug,
					requirement,
				),
			),
		).toBe(404)
		const anonymous = new Request(
			`http://localhost:3000/${organization.slug}/staff/team`,
		)
		expect(
			await statusOf(
				requireStaffingAccess(anonymous, organization.slug, requirement),
			),
		).not.toBe('ok')
	})

	it('does not let a member of another organization borrow a role grant', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('member')
		await enableAll(a.organization.id)
		await enableAll(b.organization.id)
		// Admin of A is only a plain member of B: no staffing access in B.
		await db.insert(UserOrganization).values({
			userId: a.user.id,
			organizationId: b.organization.id,
			organizationRoleId: 'org_role_member',
		})
		expect(
			await userHasStaffingPermission(
				a.user.id,
				a.organization.id,
				STAFFING_PERMISSIONS.READ_STAFF,
			),
		).toBe(true)
		expect(
			await userHasStaffingPermission(
				a.user.id,
				b.organization.id,
				STAFFING_PERMISSIONS.READ_STAFF,
			),
		).toBe(false)
	})
})

describe('getStaffingNavAccess', () => {
	it('hides the whole group when the master flag is off, whatever the role', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await setFlag('timeclock', organization.id)
		expect(await getStaffingNavAccess(user.id, organization.id)).toEqual({
			visible: false,
			team: false,
			timeclock: false,
			schedule: false,
			labor: false,
			hiring: false,
		})
	})

	it('shows Team alone when only the master flag is on', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		expect(await getStaffingNavAccess(user.id, organization.id)).toEqual({
			visible: true,
			team: true,
			timeclock: false,
			schedule: false,
			labor: false,
			hiring: false,
		})
	})

	it('shows every link to an admin when everything is on', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await enableAll(organization.id)
		expect(await getStaffingNavAccess(user.id, organization.id)).toEqual({
			visible: true,
			team: true,
			timeclock: true,
			schedule: true,
			labor: true,
			hiring: true,
		})
	})

	it('hides everything from a built-in member even with every flag on', async () => {
		const { organization, user } = await setupTestOrgWithUser('member')
		await enableAll(organization.id)
		expect((await getStaffingNavAccess(user.id, organization.id)).visible).toBe(
			false,
		)
	})

	it('shows a link only when both its flag and its permission allow it', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		await setFlag('scheduling', organization.id)
		const roleId = await createCustomRole(organization.id, [
			'org_perm_read_schedule_any',
			'org_perm_read_hiring_any', // hiring flag is off
		])
		const { user } = await memberWithRole(organization.id, roleId)
		expect(await getStaffingNavAccess(user.id, organization.id)).toEqual({
			visible: true,
			team: false,
			timeclock: false,
			schedule: true,
			labor: false,
			hiring: false,
		})
	})

	it('shows Labor only with the labor flag and the labor grant', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		const roleId = await createCustomRole(organization.id, [
			'org_perm_read_labor_any',
		])
		const { user } = await memberWithRole(organization.id, roleId)
		// Flag off: the grant alone shows nothing.
		expect((await getStaffingNavAccess(user.id, organization.id)).labor).toBe(
			false,
		)
		await setFlag('labor', organization.id)
		const nav = await getStaffingNavAccess(user.id, organization.id)
		expect(nav).toMatchObject({ visible: true, labor: true, team: false })
	})
})

describe('staffing permissions in the database', () => {
	const staffingEntities = [
		...new Set(STAFFING_PERMISSION_LIST.map((p) => p.split(':')[1]!)),
	]
	const staffingPermissionIds = STAFFING_PERMISSION_LIST.map(
		(p) => `org_perm_${p.replaceAll(':', '_')}`,
	)

	async function grantedStaffingIds(roleIdCondition: ReturnType<typeof eq>) {
		const rows = await db
			.select({
				roleId: _OrganizationPermissionToRole.A,
				permissionId: _OrganizationPermissionToRole.B,
			})
			.from(_OrganizationPermissionToRole)
			.innerJoin(Permission, eq(Permission.id, _OrganizationPermissionToRole.B))
			.where(and(roleIdCondition, inArray(Permission.entity, staffingEntities)))
		return rows.map((r) => r.permissionId).sort()
	}

	it('seeds all 18 staffing permissions', async () => {
		const rows = await db
			.select({ id: Permission.id })
			.from(Permission)
			.where(inArray(Permission.id, staffingPermissionIds))
		expect(rows).toHaveLength(18)
	})

	it('grants the built-in admin every staffing permission', async () => {
		expect(
			await grantedStaffingIds(
				eq(_OrganizationPermissionToRole.A, 'org_role_admin'),
			),
		).toEqual([...staffingPermissionIds].sort())
	})

	it('grants the built-in member only the two inert own-scope permissions', async () => {
		expect(
			await grantedStaffingIds(
				eq(_OrganizationPermissionToRole.A, 'org_role_member'),
			),
		).toEqual(['org_perm_create_timeclock_own', 'org_perm_read_schedule_own'])
	})

	it('grants viewer and guest nothing', async () => {
		expect(
			await grantedStaffingIds(
				inArray(_OrganizationPermissionToRole.A, [
					'org_role_viewer',
					'org_role_guest',
				]),
			),
		).toEqual([])
	})

	it('does not hand a role created for a new organization any staffing permission', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const roleId = await createCustomRole(organization.id, [
			'org_perm_read_member_any',
			'org_perm_read_website_any',
		])
		expect(
			await grantedStaffingIds(eq(_OrganizationPermissionToRole.A, roleId)),
		).toEqual([])
	})

	describe('migration 0018 source', () => {
		const sql = readFileSync(
			path.resolve(
				process.cwd(),
				'../../packages/database/drizzle/0018_staffing_foundation.sql',
			),
			'utf8',
		)
		const grantBlocks = sql
			.split('--> statement-breakpoint')
			.filter((statement) =>
				statement.includes('"_OrganizationPermissionToRole"'),
			)
			.join('\n')

		it('only ever grants to the built-in admin and member roles', () => {
			const roles = [...grantBlocks.matchAll(/\('(org_role_[a-z]+)',/g)].map(
				(match) => match[1],
			)
			expect(new Set(roles)).toEqual(
				new Set(['org_role_admin', 'org_role_member']),
			)
		})

		it('never copies grants from another permission to existing custom roles', () => {
			// Earlier permission migrations copied grants with INSERT ... SELECT.
			expect(grantBlocks).not.toMatch(/SELECT/i)
		})

		it('uses INSERT OR IGNORE so a re-run is safe', () => {
			expect(sql.match(/INSERT OR IGNORE INTO/g)).toHaveLength(2)
			expect(sql).not.toMatch(
				/INSERT INTO "(Permission|_OrganizationPermissionToRole)"/,
			)
		})

		it('keeps the invitation link column nullable and key-free', () => {
			expect(sql).toMatch(
				/ALTER TABLE `OrganizationInvitation` ADD `staffMemberId` text;/,
			)
		})

		it('stores only ids and generic fields in the outbox', () => {
			const start = sql.indexOf('CREATE TABLE `StaffingOutbox`')
			const table = sql.slice(start, sql.indexOf('\n);', start))
			const columns = [...table.matchAll(/^\t`(\w+)`/gm)].map((m) => m[1])
			expect(columns.sort()).toEqual(
				[
					'id',
					'organizationId',
					'kind',
					'payload',
					'status',
					'attempts',
					'nextAttemptAt',
					'lastError',
					'createdAt',
					'updatedAt',
				].sort(),
			)
		})
	})
})
