import { BUILTIN_LABOR_POLICY } from '@repo/staffing'
import { describe, expect, it } from 'vitest'
import { policyFormProblems } from '#app/utils/staffing/labor-policy-form.ts'
import {
	applyPreset,
	detectPreset,
	LABOR_PRESET_IDS,
} from '#app/utils/staffing/labor-presets.ts'

describe('labor presets', () => {
	it.each(LABOR_PRESET_IDS)(
		'%s is a valid policy and detects as itself',
		(id) => {
			const policy = applyPreset(id, BUILTIN_LABOR_POLICY, 'us')
			expect(policyFormProblems(policy)).toEqual([])
			expect(detectPreset(policy, 'us')).toBe(id)
		},
	)

	it('treats a never-saved policy and any edited preset as custom', () => {
		expect(detectPreset(BUILTIN_LABOR_POLICY, 'us')).toBe('custom')
		const edited = {
			...applyPreset('starter', BUILTIN_LABOR_POLICY, 'us'),
			lateGraceMinutes: 9,
		}
		expect(detectPreset(edited, 'us')).toBe('custom')
	})

	it('never answers the multi-scope overtime question for the owner', () => {
		const answered = {
			...BUILTIN_LABOR_POLICY,
			aggregateOvertimeAcrossScopes: true,
		}
		for (const id of LABOR_PRESET_IDS) {
			expect(
				applyPreset(id, answered, 'us').aggregateOvertimeAcrossScopes,
			).toBe(true)
			expect(
				applyPreset(id, BUILTIN_LABOR_POLICY, 'us')
					.aggregateOvertimeAcrossScopes,
			).toBeNull()
		}
	})

	it('strict deducts a missing break and locks timesheets; relaxed does neither', () => {
		const strict = applyPreset('strict', BUILTIN_LABOR_POLICY, 'us')
		expect(strict.breakRules.autoDeduction).toEqual({
			afterMinutes: 360,
			deductMinutes: 30,
		})
		expect(strict.timesheetApprovalMode).toBe('approve_lock')
		expect(strict.allowUnscheduled).toBe(false)
		const relaxed = applyPreset('relaxed', BUILTIN_LABOR_POLICY, 'us')
		expect(relaxed.breakRules.autoDeduction).toBeNull()
		expect(relaxed.timesheetApprovalMode).toBe('none')
	})
})
