import {
	STAFFING_PERMISSIONS as P,
	STAFFING_PERMISSION_LIST,
} from '@repo/staffing'
import { describe, expect, it } from 'vitest'
import {
	STAFFING_IMPLIED_PERMISSION_IDS,
	TENANT_ROLE_PERMISSION_IDS,
} from '#app/utils/organization/tenant-role-permissions.ts'
import {
	getStaffingRolePreset,
	isStaffingRolePresetKey,
	permissionIdFor,
	presetPermissionIds,
	STAFFING_ROLE_PRESET_KEYS,
	STAFFING_ROLE_PRESETS,
} from './role-presets.ts'

describe('staffing role presets', () => {
	it('offers exactly shift manager, general manager and hiring manager', () => {
		expect(STAFFING_ROLE_PRESETS.map((preset) => preset.name)).toEqual([
			'Shift manager',
			'General manager',
			'Hiring manager',
		])
		expect(STAFFING_ROLE_PRESETS.map((preset) => preset.key)).toEqual([
			...STAFFING_ROLE_PRESET_KEYS,
		])
	})

	it('only ever names permissions a custom role may hold', () => {
		const allowed = new Set<string>(TENANT_ROLE_PERMISSION_IDS)
		for (const preset of STAFFING_ROLE_PRESETS) {
			for (const id of presetPermissionIds(preset)) {
				expect(allowed.has(id), `${preset.key}: ${id}`).toBe(true)
			}
		}
	})

	it('maps every staffing permission to a grantable id', () => {
		const allowed = new Set<string>(TENANT_ROLE_PERMISSION_IDS)
		for (const permission of STAFFING_PERMISSION_LIST) {
			expect(allowed.has(permissionIdFor(permission))).toBe(true)
		}
		expect(permissionIdFor(P.READ_STAFF_PAY)).toBe(
			'org_perm_read_staff_pay_any',
		)
	})

	it('always pairs an update or approve grant with the read grant it implies', () => {
		for (const preset of STAFFING_ROLE_PRESETS) {
			const ids = new Set(presetPermissionIds(preset))
			for (const id of ids) {
				for (const implied of STAFFING_IMPLIED_PERMISSION_IDS[id] ?? []) {
					expect(
						ids.has(implied),
						`${preset.key}: ${id} needs ${implied}`,
					).toBe(true)
				}
			}
		}
	})

	it('gives a shift manager schedule, time cards and staff read, and nothing sensitive', () => {
		const ids = presetPermissionIds(getStaffingRolePreset('shift_manager'))
		expect(ids).toEqual(
			[
				'org_perm_read_staff_any',
				'org_perm_read_schedule_any',
				'org_perm_update_schedule_any',
				'org_perm_read_timesheet_any',
				'org_perm_update_timesheet_any',
			].sort(),
		)
	})

	it('gives a general manager everything a shift manager has, plus pay, labor, approval and hiring', () => {
		const shift = new Set(
			presetPermissionIds(getStaffingRolePreset('shift_manager')),
		)
		const general = new Set(
			presetPermissionIds(getStaffingRolePreset('general_manager')),
		)
		for (const id of shift) expect(general.has(id)).toBe(true)
		for (const id of [
			'org_perm_update_staff_any',
			'org_perm_read_staff_pay_any',
			'org_perm_update_staff_pay_any',
			'org_perm_read_labor_any',
			'org_perm_approve_timesheet_any',
			'org_perm_read_hiring_any',
			'org_perm_update_hiring_any',
		]) {
			expect(general.has(id)).toBe(true)
		}
	})

	it('keeps private details and labor policy out of every preset', () => {
		for (const preset of STAFFING_ROLE_PRESETS) {
			const ids = presetPermissionIds(preset)
			expect(ids.some((id) => id.includes('staff_private'))).toBe(false)
			expect(ids.some((id) => id.includes('labor_policy'))).toBe(false)
		}
	})

	it('gives a hiring manager hiring and staff read, not schedules, time cards or pay', () => {
		const ids = presetPermissionIds(getStaffingRolePreset('hiring_manager'))
		expect(ids).toEqual(
			[
				'org_perm_read_staff_any',
				'org_perm_read_hiring_any',
				'org_perm_update_hiring_any',
			].sort(),
		)
	})

	it('recognizes only known preset keys', () => {
		expect(isStaffingRolePresetKey('shift_manager')).toBe(true)
		for (const bad of ['', 'admin', 'Shift manager', null, undefined, 3]) {
			expect(isStaffingRolePresetKey(bad)).toBe(false)
		}
	})
})
