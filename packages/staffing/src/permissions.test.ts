import { describe, expect, it } from 'vitest'
import {
	isFlagOn,
	STAFFING_CHILD_FEATURES,
	STAFFING_FLAG_KEYS,
} from './flags.ts'
import {
	grantsSatisfying,
	isStaffingPermission,
	restrictGrantsForImpersonation,
	STAFFING_PERMISSION_LIST,
	STAFFING_PERMISSIONS,
	STAFFING_SENSITIVE_TOKEN_TTL_SECONDS,
	STAFFING_TOKEN_TTL_SECONDS,
	staffingTokenTtlSeconds,
} from './permissions.ts'

describe('staffing flags', () => {
	it('uses the documented keys', () => {
		expect(STAFFING_FLAG_KEYS).toEqual({
			enabled: 'staffing.enabled',
			timeclock: 'staffing.timeclock',
			scheduling: 'staffing.scheduling',
			labor: 'staffing.labor',
			hiring: 'staffing.hiring',
		})
		expect(STAFFING_CHILD_FEATURES).toEqual([
			'timeclock',
			'scheduling',
			'labor',
			'hiring',
		])
	})
	it('only the boolean true turns a flag on', () => {
		expect(isFlagOn(true)).toBe(true)
		for (const v of [false, null, undefined, 'true', 'false', 1, 0, {}, []]) {
			expect(isFlagOn(v)).toBe(false)
		}
	})
})

describe('staffing permissions', () => {
	it('are well-formed action:entity:access strings', () => {
		for (const p of STAFFING_PERMISSION_LIST)
			expect(p).toMatch(/^[a-z]+:[a-z_]+:[a-z]+$/)
		expect(new Set(STAFFING_PERMISSION_LIST).size).toBe(18)
	})
	it('recognizes only staffing permissions', () => {
		expect(isStaffingPermission('read:staff:any')).toBe(true)
		expect(isStaffingPermission('read:menu:any')).toBe(false)
		expect(isStaffingPermission(42)).toBe(false)
	})
	it('shortens the token life for pay and private grants', () => {
		expect(staffingTokenTtlSeconds([STAFFING_PERMISSIONS.READ_STAFF])).toBe(
			STAFFING_TOKEN_TTL_SECONDS,
		)
		expect(
			staffingTokenTtlSeconds([
				STAFFING_PERMISSIONS.READ_STAFF,
				STAFFING_PERMISSIONS.READ_STAFF_PAY,
			]),
		).toBe(STAFFING_SENSITIVE_TOKEN_TTL_SECONDS)
		expect(
			staffingTokenTtlSeconds([STAFFING_PERMISSIONS.UPDATE_STAFF_PRIVATE]),
		).toBe(300)
		expect(staffingTokenTtlSeconds([], { impersonated: true })).toBe(300)
	})
	it('strips write, approve, pay, and private grants for impersonation', () => {
		expect(
			restrictGrantsForImpersonation(STAFFING_PERMISSION_LIST).sort(),
		).toEqual(
			[
				STAFFING_PERMISSIONS.READ_STAFF,
				STAFFING_PERMISSIONS.READ_SCHEDULE,
				STAFFING_PERMISSIONS.READ_SCHEDULE_OWN,
				STAFFING_PERMISSIONS.READ_TIMESHEET,
				STAFFING_PERMISSIONS.READ_LABOR,
				STAFFING_PERMISSIONS.READ_LABOR_POLICY,
				STAFFING_PERMISSIONS.READ_HIRING,
			].sort(),
		)
	})
})

describe('grantsSatisfying', () => {
	it('lists the permission itself first', () => {
		expect(grantsSatisfying('read:staff:any')).toEqual([
			'read:staff:any',
			'update:staff:any',
		])
		expect(grantsSatisfying('update:staff:any')).toEqual(['update:staff:any'])
	})
	it('lets approve satisfy a timesheet read but nothing else', () => {
		expect(grantsSatisfying('read:timesheet:any')).toContain(
			'approve:timesheet:any',
		)
		expect(grantsSatisfying('update:timesheet:any')).toEqual([
			'update:timesheet:any',
		])
	})
	it('never lets pay, private, or labor grants satisfy each other', () => {
		expect(grantsSatisfying('read:staff:any')).not.toContain(
			'read:staff_pay:any',
		)
		expect(grantsSatisfying('read:staff_pay:any')).not.toContain(
			'read:staff:any',
		)
		expect(grantsSatisfying('read:labor:any')).toEqual(['read:labor:any'])
	})
	it('only returns real staffing permissions', () => {
		for (const p of STAFFING_PERMISSION_LIST) {
			for (const g of grantsSatisfying(p))
				expect(isStaffingPermission(g)).toBe(true)
		}
	})
})
