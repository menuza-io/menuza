import { BUILTIN_LABOR_POLICY, laborPolicyProblems } from '@repo/staffing'
import { describe, expect, it } from 'vitest'
import {
	applyStarter,
	bpToMultiplierText,
	buildPolicyPatch,
	defaultWeekStart,
	hoursTextToMinutes,
	isDirty,
	minuteToTimeValue,
	minutesToHoursText,
	multiplierTextToBp,
	policyFormProblems,
	problemFor,
	sentenceFieldRange,
	starterPolicy,
	timeValueToMinute,
	WEEKLY_OVERTIME_PRESET,
} from './labor-policy-form.ts'

describe('standard starter policy', () => {
	it('is valid for the server cross-field rules in both regions', () => {
		for (const region of ['us', 'ksa', null]) {
			const policy = applyStarter(BUILTIN_LABOR_POLICY, region)
			expect(policyFormProblems(policy)).toEqual([])
			expect(laborPolicyProblems(policy)).toEqual([])
		}
	})

	it('asserts no overtime and no hard break rule', () => {
		const starter = starterPolicy('us')
		expect(starter.weeklyOvertime).toBeNull()
		expect(starter.dailyOvertime).toBeNull()
		expect(starter.dailyDoubleTime).toBeNull()
		expect(starter.rounding.mode).toBe('none')
		expect(starter.breakRules.rules.every((rule) => !rule.mandatory)).toBe(true)
	})

	it('starts the week on Sunday in KSA and Monday elsewhere', () => {
		expect(defaultWeekStart('ksa')).toBe(0)
		expect(defaultWeekStart('KSA')).toBe(0)
		expect(defaultWeekStart('us')).toBe(1)
		expect(defaultWeekStart(undefined)).toBe(1)
	})

	it('never answers the multi-scope overtime question for the owner', () => {
		const chosen = {
			...BUILTIN_LABOR_POLICY,
			aggregateOvertimeAcrossScopes: true,
		}
		expect(applyStarter(chosen, 'us').aggregateOvertimeAcrossScopes).toBe(true)
		expect(
			applyStarter(BUILTIN_LABOR_POLICY, 'us').aggregateOvertimeAcrossScopes,
		).toBeNull()
	})
})

describe('buildPolicyPatch', () => {
	it('contains only what changed', () => {
		const next = {
			...BUILTIN_LABOR_POLICY,
			lateGraceMinutes: 10,
			weeklyOvertime: { ...WEEKLY_OVERTIME_PRESET },
		}
		expect(buildPolicyPatch(BUILTIN_LABOR_POLICY, next)).toEqual({
			lateGraceMinutes: 10,
			weeklyOvertime: { thresholdMinutes: 2400, multiplierBp: 15000 },
		})
		expect(isDirty(BUILTIN_LABOR_POLICY, next)).toBe(true)
		expect(isDirty(BUILTIN_LABOR_POLICY, { ...BUILTIN_LABOR_POLICY })).toBe(
			false,
		)
	})

	it('treats structurally equal nested values as unchanged', () => {
		const copy = structuredClone(BUILTIN_LABOR_POLICY)
		expect(buildPolicyPatch(BUILTIN_LABOR_POLICY, copy)).toEqual({})
	})

	it('never sends fields the screen does not edit', () => {
		const next = {
			...BUILTIN_LABOR_POLICY,
			requirePhoto: true,
			publishLeadHours: 9,
		}
		expect(buildPolicyPatch(BUILTIN_LABOR_POLICY, next)).toEqual({})
	})
})

describe('policyFormProblems', () => {
	it('catches double time that starts before overtime', () => {
		const problems = policyFormProblems({
			...BUILTIN_LABOR_POLICY,
			dailyOvertime: { thresholdMinutes: 600, multiplierBp: 15000 },
			dailyDoubleTime: { thresholdMinutes: 480, multiplierBp: 20000 },
		})
		expect(problemFor(problems, 'dailyDoubleTime')?.code).toBe(
			'double_time_before_overtime',
		)
	})

	it('reports out-of-range values with their path', () => {
		const problems = policyFormProblems({
			...BUILTIN_LABOR_POLICY,
			lateGraceMinutes: 999,
		})
		expect(problemFor(problems, 'lateGraceMinutes')).toBeDefined()
	})

	it('finds child paths from a parent path', () => {
		const problems = [{ path: 'breakRules.rules.1', code: 'duplicate_rule' }]
		expect(problemFor(problems, 'breakRules')?.code).toBe('duplicate_rule')
		expect(problemFor(problems, 'rounding')).toBeUndefined()
	})
})

describe('sentenceFieldRange', () => {
	it('reads each sentence box range from the schema, in the unit it shows', () => {
		expect(sentenceFieldRange('longShiftMinutes')).toEqual({
			unit: 'hours',
			min: 1,
			max: 48,
		})
		expect(
			sentenceFieldRange('breakRules.autoDeduction.deductMinutes'),
		).toEqual({ unit: 'minutes', min: 1, max: 240 })
		expect(sentenceFieldRange('breakRules.autoDeduction.afterMinutes')).toEqual(
			{ unit: 'hours', min: 1 / 60, max: 24 },
		)
		expect(sentenceFieldRange('weeklyOvertime.thresholdMinutes')).toEqual({
			unit: 'hours',
			min: 1 / 60,
			max: 168,
		})
	})

	it('has no range for other settings', () => {
		expect(sentenceFieldRange('lateGraceMinutes')).toBeNull()
		expect(sentenceFieldRange('weeklyOvertime')).toBeNull()
	})
})

describe('unit conversions', () => {
	it('round-trips hours', () => {
		expect(minutesToHoursText(90)).toBe('1.5')
		expect(minutesToHoursText(2400)).toBe('40')
		expect(hoursTextToMinutes('1.5')).toBe(90)
		expect(hoursTextToMinutes('1,5')).toBe(90)
		expect(hoursTextToMinutes('8')).toBe(480)
	})

	it('refuses junk hour input', () => {
		for (const bad of ['', 'abc', '-1', '1.555', '1e3', ' ']) {
			expect(hoursTextToMinutes(bad)).toBeNull()
		}
	})

	it('converts multipliers within the API range', () => {
		expect(bpToMultiplierText(15000)).toBe('1.5')
		expect(multiplierTextToBp('1.5')).toBe(15000)
		expect(multiplierTextToBp('2')).toBe(20000)
		expect(multiplierTextToBp('0.9')).toBeNull()
		expect(multiplierTextToBp('4.01')).toBeNull()
		expect(multiplierTextToBp('x')).toBeNull()
	})

	it('converts the workday start to and from a time value', () => {
		expect(minuteToTimeValue(0)).toBe('00:00')
		expect(minuteToTimeValue(4 * 60 + 5)).toBe('04:05')
		expect(timeValueToMinute('04:05')).toBe(245)
		expect(timeValueToMinute('24:00')).toBeNull()
		expect(timeValueToMinute('4:5')).toBeNull()
	})
})
