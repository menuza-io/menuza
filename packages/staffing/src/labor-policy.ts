import { z } from 'zod'
import {
	type LaborRules,
	NEUTRAL_LABOR_RULES,
	ROUNDING_MODES,
	thresholdRuleSchema,
} from './rules.ts'
import {
	basisPointsSchema,
	localDateSchema,
	timeZoneSchema,
} from './schemas.ts'

/**
 * Labor policy: the configurable rules one scope's time clock follows. It is
 * data, not law: nothing here asserts a legal requirement, and every overtime
 * or cost figure computed from it is an estimate. A scope row overrides the
 * organization default row; with neither, the built-in defaults below apply.
 */

export const GEOFENCE_MODES = ['off', 'flag', 'block'] as const
export type GeofenceMode = (typeof GEOFENCE_MODES)[number]

export const TIMESHEET_APPROVAL_MODES = [
	'none',
	'approve',
	'approve_lock',
] as const
export type TimesheetApprovalMode = (typeof TIMESHEET_APPROVAL_MODES)[number]

export const SCHEDULE_VISIBILITIES = ['own', 'team'] as const
export type ScheduleVisibility = (typeof SCHEDULE_VISIBILITIES)[number]

export const BREAK_KINDS = ['meal', 'rest'] as const
export type BreakKind = (typeof BREAK_KINDS)[number]

/** One break requirement: after `afterMinutes` on shift, take `minutes`. */
export const breakRuleSchema = z
	.object({
		kind: z.enum(BREAK_KINDS),
		/** Shift length (minutes since clock-in) at which the break is due. */
		afterMinutes: z
			.number()
			.int()
			.min(1)
			.max(60 * 24),
		/** Minimum length of a break that satisfies the rule. */
		minutes: z.number().int().min(1).max(240),
		paid: z.boolean(),
		/** A mandatory rule that was not met raises the `missed_break` issue. */
		mandatory: z.boolean(),
	})
	.strict()
export type BreakRule = z.infer<typeof breakRuleSchema>

export const breakRulesSchema = z
	.object({
		rules: z.array(breakRuleSchema).max(6),
		/** Deduct an unpaid break when none was recorded on a long shift. */
		autoDeduction: z
			.object({
				afterMinutes: z
					.number()
					.int()
					.min(1)
					.max(60 * 24),
				deductMinutes: z.number().int().min(1).max(240),
			})
			.strict()
			.nullable(),
	})
	.strict()
export type BreakRules = z.infer<typeof breakRulesSchema>

export const NO_BREAK_RULES: BreakRules = { rules: [], autoDeduction: null }

const holidaySchema = z
	.object({
		dates: z.array(localDateSchema).max(366),
		multiplierBp: basisPointsSchema,
	})
	.strict()

const roundingSchema = z
	.object({
		mode: z.enum(ROUNDING_MODES),
		incrementMinutes: z.number().int().min(1).max(60),
	})
	.strict()

const geofenceSchema = z
	.object({
		mode: z.enum(GEOFENCE_MODES),
		radiusMeters: z.number().int().min(25).max(5000).nullable(),
	})
	.strict()

const thresholdStrict = thresholdRuleSchema.strict()

/** Every policy field, without cross-field rules. */
export const laborPolicyBaseSchema = z.object({
	/** Per-scope switch: false means the clock accepts no punches here. */
	timeTrackingEnabled: z.boolean(),
	/** Time zone snapshot used when the control plane cannot be reached. */
	timeZone: timeZoneSchema.nullable(),
	weekStartsOn: z.number().int().min(0).max(6),
	workdayStartMinute: z.number().int().min(0).max(1439),
	/** Minutes after a shift's start before a clock-in counts as late. */
	lateGraceMinutes: z.number().int().min(0).max(120),
	/** Block clock-ins earlier than this many minutes before the shift; null is off. */
	preventEarlyMinutes: z.number().int().min(1).max(240).nullable(),
	allowUnscheduled: z.boolean(),
	/** Minutes past the scheduled end to remind about a missed clock-out; null is off. */
	missedClockOutReminderMinutes: z
		.number()
		.int()
		.min(5)
		.max(60 * 24)
		.nullable(),
	/**
	 * Close an entry still open this many minutes after its scheduled end (or
	 * after clock-in when no shift matched) and flag it for review; null is off.
	 */
	autoClockOutMinutes: z
		.number()
		.int()
		.min(30)
		.max(60 * 48)
		.nullable(),
	/**
	 * Alert managers when a scheduled person has not clocked in this many minutes
	 * after the shift started; null is off. Needs the schedule.
	 */
	noClockInAlertMinutes: z.number().int().min(1).max(240).nullable(),
	/**
	 * Email a person this many minutes before a scheduled shift; null is off.
	 * Needs the schedule.
	 */
	preShiftReminderMinutes: z
		.number()
		.int()
		.min(15)
		.max(60 * 48)
		.nullable(),
	/**
	 * Alert managers when a person working now is this many minutes short of an
	 * overtime threshold (and again when it is reached); null is off.
	 */
	overtimeAlertMinutes: z
		.number()
		.int()
		.min(15)
		.max(60 * 24)
		.nullable(),
	rounding: roundingSchema,
	dailyOvertime: thresholdStrict.nullable(),
	dailyDoubleTime: thresholdStrict.nullable(),
	weeklyOvertime: thresholdStrict.nullable(),
	holiday: holidaySchema,
	breakRules: breakRulesSchema,
	longShiftMinutes: z
		.number()
		.int()
		.min(60)
		.max(60 * 48),
	geofence: geofenceSchema,
	requirePhoto: z.boolean(),
	timesheetApprovalMode: z.enum(TIMESHEET_APPROVAL_MODES),
	scheduleVisibility: z.enum(SCHEDULE_VISIBILITIES),
	publishLeadHours: z
		.number()
		.int()
		.min(0)
		.max(24 * 30),
	/** Most people that may be off on one day; null is no cap. */
	timeOffMaxPerDay: z.number().int().min(1).max(1000).nullable(),
	/** Labor target as basis points of sales (3000 = 30%); null is none. */
	laborTargetBp: z.number().int().min(100).max(10_000).nullable(),
	/**
	 * Count overtime across all of a person's scopes. No default: it is
	 * null until chosen, and must be chosen wherever staff work at more than one
	 * scope.
	 */
	aggregateOvertimeAcrossScopes: z.boolean().nullable(),
	rulePack: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
	rulePackVersion: z.number().int().min(1),
})

export type LaborPolicyFields = z.infer<typeof laborPolicyBaseSchema>

export type LaborPolicyProblem = {
	path: string
	code: string
}

/**
 * Cross-field rules, returned as problems rather than thrown so a route can
 * answer with stable codes and no echoed values.
 */
export function laborPolicyProblems(
	policy: LaborPolicyFields,
): LaborPolicyProblem[] {
	const problems: LaborPolicyProblem[] = []
	if (
		policy.dailyDoubleTime &&
		policy.dailyOvertime &&
		policy.dailyDoubleTime.thresholdMinutes <=
			policy.dailyOvertime.thresholdMinutes
	) {
		problems.push({
			path: 'dailyDoubleTime',
			code: 'double_time_before_overtime',
		})
	}
	if (
		policy.rounding.mode === 'none' &&
		policy.rounding.incrementMinutes !== 1
	) {
		problems.push({
			path: 'rounding.incrementMinutes',
			code: 'increment_with_no_rounding',
		})
	}
	if (policy.geofence.mode !== 'off' && policy.geofence.radiusMeters === null) {
		problems.push({ path: 'geofence.radiusMeters', code: 'radius_required' })
	}
	if (policy.geofence.mode === 'off' && policy.geofence.radiusMeters !== null) {
		problems.push({
			path: 'geofence.radiusMeters',
			code: 'radius_without_geofence',
		})
	}
	const auto = policy.breakRules.autoDeduction
	if (auto && auto.deductMinutes >= auto.afterMinutes) {
		problems.push({
			path: 'breakRules.autoDeduction',
			code: 'deduction_longer_than_shift',
		})
	}
	if (
		policy.autoClockOutMinutes !== null &&
		policy.missedClockOutReminderMinutes !== null &&
		policy.missedClockOutReminderMinutes >= policy.autoClockOutMinutes
	) {
		problems.push({
			path: 'missedClockOutReminderMinutes',
			code: 'reminder_after_auto_clock_out',
		})
	}
	const seen = new Set<string>()
	for (const [index, rule] of policy.breakRules.rules.entries()) {
		const key = `${rule.kind}:${rule.afterMinutes}`
		if (seen.has(key)) {
			problems.push({
				path: `breakRules.rules.${index}`,
				code: 'duplicate_rule',
			})
		}
		seen.add(key)
	}
	return problems
}

/** The neutral starting point: no rules assert anything. */
export const BUILTIN_LABOR_POLICY: LaborPolicyFields = {
	timeTrackingEnabled: true,
	timeZone: null,
	weekStartsOn: NEUTRAL_LABOR_RULES.weekStartsOn,
	workdayStartMinute: NEUTRAL_LABOR_RULES.workdayStartMinute,
	lateGraceMinutes: 5,
	preventEarlyMinutes: null,
	allowUnscheduled: true,
	missedClockOutReminderMinutes: null,
	autoClockOutMinutes: null,
	noClockInAlertMinutes: 15,
	preShiftReminderMinutes: 240,
	overtimeAlertMinutes: 60,
	rounding: { ...NEUTRAL_LABOR_RULES.rounding },
	dailyOvertime: null,
	dailyDoubleTime: null,
	weeklyOvertime: null,
	holiday: { dates: [], multiplierBp: 10_000 },
	breakRules: NO_BREAK_RULES,
	longShiftMinutes: NEUTRAL_LABOR_RULES.longShiftMinutes,
	geofence: { mode: 'off', radiusMeters: null },
	requirePhoto: false,
	timesheetApprovalMode: 'none',
	scheduleVisibility: 'own',
	publishLeadHours: 0,
	timeOffMaxPerDay: null,
	laborTargetBp: null,
	aggregateOvertimeAcrossScopes: null,
	rulePack: 'generic',
	rulePackVersion: 1,
}

/**
 * A patch is any subset of the fields plus the version the caller last saw, so
 * two managers cannot silently overwrite each other. `expectedVersion` is
 * required when the row already exists and ignored when it is created.
 */
export const laborPolicyPatchSchema = laborPolicyBaseSchema
	.partial()
	.extend({
		expectedVersion: z.number().int().min(1).optional(),
	})
	.strict()
export type LaborPolicyPatch = z.infer<typeof laborPolicyPatchSchema>

/** Merge a patch onto the policy it edits. Nested objects replace, not merge. */
export function applyLaborPolicyPatch(
	base: LaborPolicyFields,
	patch: LaborPolicyPatch,
): LaborPolicyFields {
	const { expectedVersion: ignoredVersion, ...fields } = patch
	void ignoredVersion
	const merged: Record<string, unknown> = { ...base }
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) merged[key] = value
	}
	return laborPolicyBaseSchema.parse(merged)
}

/** Policy fields that feed the shared time math. */
export function laborPolicyToRules(
	policy: Pick<
		LaborPolicyFields,
		| 'weekStartsOn'
		| 'workdayStartMinute'
		| 'rounding'
		| 'dailyOvertime'
		| 'dailyDoubleTime'
		| 'weeklyOvertime'
		| 'holiday'
		| 'breakRules'
		| 'longShiftMinutes'
		| 'aggregateOvertimeAcrossScopes'
	>,
): LaborRules {
	return {
		weekStartsOn: policy.weekStartsOn,
		workdayStartMinute: policy.workdayStartMinute,
		rounding: policy.rounding,
		dailyOvertime: policy.dailyOvertime,
		dailyDoubleTime: policy.dailyDoubleTime,
		weeklyOvertime: policy.weeklyOvertime,
		holiday: policy.holiday,
		autoBreakDeduction: policy.breakRules.autoDeduction,
		// Null (not yet chosen) is evaluated per scope, the conservative
		// reading; the API reports that a decision is still needed.
		aggregateOvertimeAcrossScopes:
			policy.aggregateOvertimeAcrossScopes === true,
		longShiftMinutes: policy.longShiftMinutes,
	}
}

export type LaborPolicyView = LaborPolicyFields & {
	id: string | null
	/** `null` for the organization default. */
	scopeId: string | null
	/** Where the effective values came from. */
	source: 'scope' | 'default' | 'builtin'
	version: number
	updatedAt: number | null
	/** True while staff work at several scopes and no choice was made. */
	aggregateDecisionRequired: boolean
}
