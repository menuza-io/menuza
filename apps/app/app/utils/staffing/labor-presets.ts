import { type LaborPolicyFields } from '@repo/staffing'
import {
	EDITABLE_POLICY_KEYS,
	starterPolicy,
} from '#app/utils/staffing/labor-policy-form.ts'

/**
 * Starting points for the labor rules screen. Each one is only a set of
 * ordinary settings the person can change afterwards: nothing here asserts a
 * legal requirement, and the screen says so. The standard starter is the
 * existing one; strict and relaxed are the same values nudged in one direction.
 */
export const LABOR_PRESET_IDS = ['starter', 'strict', 'relaxed'] as const
export type LaborPresetId = (typeof LABOR_PRESET_IDS)[number]
export type LaborPresetChoice = LaborPresetId | 'custom'

type PresetFields = ReturnType<typeof starterPolicy>

function presetFields(
	id: LaborPresetId,
	dataRegion: string | null | undefined,
): PresetFields {
	const starter = starterPolicy(dataRegion)
	switch (id) {
		case 'starter':
			return starter
		case 'strict':
			return {
				...starter,
				allowUnscheduled: false,
				breakRules: {
					rules: starter.breakRules.rules.map((rule) => ({
						...rule,
						mandatory: true,
					})),
					autoDeduction: { afterMinutes: 6 * 60, deductMinutes: 30 },
				},
				timesheetApprovalMode: 'approve_lock',
			}
		case 'relaxed':
			return {
				...starter,
				allowUnscheduled: true,
				preventEarlyMinutes: null,
				lateGraceMinutes: 15,
				missedClockOutReminderMinutes: null,
				noClockInAlertMinutes: null,
				preShiftReminderMinutes: null,
				overtimeAlertMinutes: null,
				breakRules: { rules: [], autoDeduction: null },
				longShiftMinutes: 16 * 60,
				timesheetApprovalMode: 'none',
			}
	}
}

/** The preset's values merged onto a policy, leaving the unanswered multi-scope choice alone. */
export function applyPreset(
	id: LaborPresetId,
	policy: LaborPolicyFields,
	dataRegion: string | null | undefined,
): LaborPolicyFields {
	return {
		...policy,
		...presetFields(id, dataRegion),
		aggregateOvertimeAcrossScopes: policy.aggregateOvertimeAcrossScopes,
	}
}

/** Which preset the policy matches exactly, or `custom` once anything differs. */
export function detectPreset(
	policy: LaborPolicyFields,
	dataRegion: string | null | undefined,
): LaborPresetChoice {
	for (const id of LABOR_PRESET_IDS) {
		const fields = presetFields(id, dataRegion)
		const matches = EDITABLE_POLICY_KEYS.every(
			(key) =>
				key === 'aggregateOvertimeAcrossScopes' ||
				JSON.stringify(policy[key]) === JSON.stringify(fields[key]),
		)
		if (matches) return id
	}
	return 'custom'
}
