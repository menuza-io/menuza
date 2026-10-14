import { ORG_PERMISSIONS } from '@repo/auth'
import { PERMISSIONS } from '@repo/security/permission-constants'
import { STAFFING_PERMISSION_LIST, STAFFING_PERMISSIONS } from '@repo/staffing'
import { describe, expect, it } from 'vitest'
import {
	hasOnlyTenantRolePermissions,
	STAFFING_IMPLIED_PERMISSION_IDS,
	TENANT_ROLE_PERMISSION_IDS,
	withImpliedStaffingPermissions,
} from './tenant-role-permissions.ts'

const permissionId = (permission: string) =>
	`org_perm_${permission.replaceAll(':', '_')}`

const STAFFING_IDS = STAFFING_PERMISSION_LIST.map(permissionId)

describe('staffing permission lists stay in sync', () => {
	it('ORG_PERMISSIONS, the shared package, and the client constants agree', () => {
		const fromAuth = Object.entries(ORG_PERMISSIONS)
			.filter(([key]) =>
				/STAFF|SCHEDULE|TIMECLOCK|TIMESHEET|LABOR|HIRING/.test(key),
			)
			.map(([, value]) => value)
			.sort()
		expect(fromAuth).toEqual([...STAFFING_PERMISSION_LIST].sort())
		const fromSecurity = Object.entries(PERMISSIONS)
			.filter(([key]) =>
				/STAFF|SCHEDULE|TIMECLOCK|TIMESHEET|LABOR|HIRING/.test(key),
			)
			.map(([, value]) => value)
			.sort()
		expect(fromSecurity).toEqual([...STAFFING_PERMISSION_LIST].sort())
	})

	it('lets custom roles be granted exactly the 18 staffing permissions', () => {
		const granted = TENANT_ROLE_PERMISSION_IDS.filter((id) =>
			STAFFING_IDS.includes(id),
		)
		expect([...granted].sort()).toEqual([...STAFFING_IDS].sort())
		expect(hasOnlyTenantRolePermissions(STAFFING_IDS)).toBe(true)
	})

	it('still refuses permissions that are not for custom roles', () => {
		expect(hasOnlyTenantRolePermissions(['org_perm_update_member_any'])).toBe(
			false,
		)
		expect(
			hasOnlyTenantRolePermissions(['org_perm_read_staff_everything']),
		).toBe(false)
		expect(hasOnlyTenantRolePermissions(['read:staff:any'])).toBe(false)
	})
})

describe('withImpliedStaffingPermissions', () => {
	it('adds the read grant for each update grant', () => {
		expect(
			withImpliedStaffingPermissions(['org_perm_update_staff_pay_any']).sort(),
		).toEqual(['org_perm_read_staff_pay_any', 'org_perm_update_staff_pay_any'])
		expect(
			withImpliedStaffingPermissions(['org_perm_approve_timesheet_any']).sort(),
		).toEqual(['org_perm_approve_timesheet_any', 'org_perm_read_timesheet_any'])
	})

	it('does not cross entities: pay never implies roster, labor never implies pay', () => {
		expect(
			withImpliedStaffingPermissions(['org_perm_update_staff_pay_any']),
		).not.toContain('org_perm_read_staff_any')
		expect(withImpliedStaffingPermissions(['org_perm_read_labor_any'])).toEqual(
			['org_perm_read_labor_any'],
		)
	})

	it('leaves unrelated permissions alone and removes duplicates', () => {
		expect(
			withImpliedStaffingPermissions([
				'org_perm_read_note_own',
				'org_perm_update_schedule_any',
				'org_perm_read_schedule_any',
			]).sort(),
		).toEqual([
			'org_perm_read_note_own',
			'org_perm_read_schedule_any',
			'org_perm_update_schedule_any',
		])
		expect(withImpliedStaffingPermissions([])).toEqual([])
	})

	it('is idempotent', () => {
		const once = withImpliedStaffingPermissions(STAFFING_IDS)
		expect(withImpliedStaffingPermissions(once).sort()).toEqual(once.sort())
	})

	it('only maps real staffing permission ids', () => {
		for (const [grant, implied] of Object.entries(
			STAFFING_IMPLIED_PERMISSION_IDS,
		)) {
			expect(STAFFING_IDS).toContain(grant)
			for (const id of implied) expect(STAFFING_IDS).toContain(id)
		}
		expect(STAFFING_PERMISSIONS.READ_STAFF).toBe('read:staff:any')
	})
})
