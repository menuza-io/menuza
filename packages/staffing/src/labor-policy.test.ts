import { describe, expect, it } from 'vitest'
import {
	applyLaborPolicyPatch,
	BUILTIN_LABOR_POLICY,
	laborPolicyBaseSchema,
	laborPolicyPatchSchema,
	laborPolicyProblems,
	laborPolicyToRules,
} from './labor-policy.ts'

describe('labor policy', () => {
	it('the built-in policy is valid, neutral, and has no overtime choice made', () => {
		expect(laborPolicyBaseSchema.safeParse(BUILTIN_LABOR_POLICY).success).toBe(
			true,
		)
		expect(laborPolicyProblems(BUILTIN_LABOR_POLICY)).toEqual([])
		expect(BUILTIN_LABOR_POLICY.aggregateOvertimeAcrossScopes).toBeNull()
		expect(BUILTIN_LABOR_POLICY.dailyOvertime).toBeNull()
		expect(BUILTIN_LABOR_POLICY.weeklyOvertime).toBeNull()
		expect(BUILTIN_LABOR_POLICY.timesheetApprovalMode).toBe('none')
	})

	it('maps policy fields onto the shared time-math rules', () => {
		const rules = laborPolicyToRules({
			...BUILTIN_LABOR_POLICY,
			weekStartsOn: 0,
			weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 15000 },
			breakRules: {
				rules: [],
				autoDeduction: { afterMinutes: 360, deductMinutes: 30 },
			},
			aggregateOvertimeAcrossScopes: true,
		})
		expect(rules.weekStartsOn).toBe(0)
		expect(rules.weeklyOvertime?.thresholdMinutes).toBe(2400)
		expect(rules.autoBreakDeduction).toEqual({
			afterMinutes: 360,
			deductMinutes: 30,
		})
		expect(rules.aggregateOvertimeAcrossScopes).toBe(true)
	})

	it('treats an unchosen aggregation setting as per-scope', () => {
		expect(
			laborPolicyToRules(BUILTIN_LABOR_POLICY).aggregateOvertimeAcrossScopes,
		).toBe(false)
	})

	it('patches merge field by field and re-validate', () => {
		const next = applyLaborPolicyPatch(BUILTIN_LABOR_POLICY, {
			lateGraceMinutes: 10,
			expectedVersion: 3,
		})
		expect(next.lateGraceMinutes).toBe(10)
		expect(next.weekStartsOn).toBe(BUILTIN_LABOR_POLICY.weekStartsOn)
		expect(() =>
			applyLaborPolicyPatch(BUILTIN_LABOR_POLICY, { lateGraceMinutes: 999 }),
		).toThrow()
	})

	it('rejects unknown keys and out-of-range values in a patch', () => {
		expect(laborPolicyPatchSchema.safeParse({ nope: 1 }).success).toBe(false)
		expect(laborPolicyPatchSchema.safeParse({ weekStartsOn: 7 }).success).toBe(
			false,
		)
		expect(
			laborPolicyPatchSchema.safeParse({
				rounding: { mode: 'up', incrementMinutes: 0 },
			}).success,
		).toBe(false)
		expect(
			laborPolicyPatchSchema.safeParse({
				dailyOvertime: { thresholdMinutes: 480, multiplierBp: 5000 },
			}).success,
		).toBe(false)
		expect(
			laborPolicyPatchSchema.safeParse({ timeZone: 'Mars/Base' }).success,
		).toBe(false)
	})

	it('flags cross-field problems with stable codes and no values', () => {
		const problems = laborPolicyProblems({
			...BUILTIN_LABOR_POLICY,
			dailyOvertime: { thresholdMinutes: 600, multiplierBp: 15000 },
			dailyDoubleTime: { thresholdMinutes: 600, multiplierBp: 20000 },
			rounding: { mode: 'none', incrementMinutes: 15 },
			geofence: { mode: 'block', radiusMeters: null },
			autoClockOutMinutes: 60,
			missedClockOutReminderMinutes: 90,
			breakRules: {
				rules: [
					{
						kind: 'meal',
						afterMinutes: 300,
						minutes: 30,
						paid: false,
						mandatory: true,
					},
					{
						kind: 'meal',
						afterMinutes: 300,
						minutes: 20,
						paid: false,
						mandatory: false,
					},
				],
				autoDeduction: { afterMinutes: 30, deductMinutes: 60 },
			},
		})
		expect(problems.map((p) => p.code).sort()).toEqual(
			[
				'deduction_longer_than_shift',
				'double_time_before_overtime',
				'duplicate_rule',
				'increment_with_no_rounding',
				'radius_required',
				'reminder_after_auto_clock_out',
			].sort(),
		)
	})

	it('has alert settings with sensible defaults, each of which can be turned off', () => {
		expect(BUILTIN_LABOR_POLICY.noClockInAlertMinutes).toBe(15)
		expect(BUILTIN_LABOR_POLICY.preShiftReminderMinutes).toBe(240)
		expect(BUILTIN_LABOR_POLICY.overtimeAlertMinutes).toBe(60)
		const off = applyLaborPolicyPatch(BUILTIN_LABOR_POLICY, {
			noClockInAlertMinutes: null,
			preShiftReminderMinutes: null,
			overtimeAlertMinutes: null,
		})
		expect(off.noClockInAlertMinutes).toBeNull()
		expect(off.preShiftReminderMinutes).toBeNull()
		expect(off.overtimeAlertMinutes).toBeNull()
	})

	it.each([
		['noClockInAlertMinutes', 0],
		['noClockInAlertMinutes', 241],
		['preShiftReminderMinutes', 14],
		['preShiftReminderMinutes', 60 * 48 + 1],
		['overtimeAlertMinutes', 14],
		['overtimeAlertMinutes', 60 * 24 + 1],
		['overtimeAlertMinutes', 1.5],
		['noClockInAlertMinutes', '15'],
	])('rejects %s = %s', (key, value) => {
		expect(laborPolicyPatchSchema.safeParse({ [key]: value }).success).toBe(
			false,
		)
	})
})
