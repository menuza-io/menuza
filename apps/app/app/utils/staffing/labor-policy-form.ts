import {
	laborPolicyBaseSchema,
	laborPolicyProblems,
	type LaborPolicyFields,
	type LaborPolicyProblem,
} from '@repo/staffing'

/**
 * Pure helpers behind the labor policy settings screen: standard starter
 * values, the patch the API wants, a client-side mirror of the server's
 * cross-field rules, and the unit conversions (hours, multipliers). Nothing here
 * asserts a legal requirement: the starter values are a convenient place to
 * begin, and the screen says so.
 */

/** The fields this screen edits. Everything else in the policy is left alone. */
export const EDITABLE_POLICY_KEYS = [
	'timeTrackingEnabled',
	'weekStartsOn',
	'workdayStartMinute',
	'lateGraceMinutes',
	'preventEarlyMinutes',
	'allowUnscheduled',
	'missedClockOutReminderMinutes',
	'autoClockOutMinutes',
	'noClockInAlertMinutes',
	'preShiftReminderMinutes',
	'overtimeAlertMinutes',
	'rounding',
	'dailyOvertime',
	'dailyDoubleTime',
	'weeklyOvertime',
	'holiday',
	'breakRules',
	'longShiftMinutes',
	'timesheetApprovalMode',
	'aggregateOvertimeAcrossScopes',
] as const satisfies ReadonlyArray<keyof LaborPolicyFields>
export type EditablePolicyKey = (typeof EDITABLE_POLICY_KEYS)[number]

/** Sunday-first week in KSA; Monday-first elsewhere (the neutral default). */
export function defaultWeekStart(dataRegion: string | null | undefined) {
	return dataRegion?.toLowerCase() === 'ksa' ? 0 : 1
}

/**
 * A sensible place to start for a typical workplace. It asks for little: reminders
 * rather than hard blocks, a meal break that is tracked but not enforced, and
 * no overtime until someone chooses it. It is a starting point, not advice.
 */
export function starterPolicy(
	dataRegion: string | null | undefined,
): Pick<LaborPolicyFields, EditablePolicyKey> {
	return {
		timeTrackingEnabled: true,
		weekStartsOn: defaultWeekStart(dataRegion),
		workdayStartMinute: 4 * 60,
		lateGraceMinutes: 5,
		preventEarlyMinutes: 10,
		allowUnscheduled: true,
		missedClockOutReminderMinutes: 30,
		autoClockOutMinutes: null,
		noClockInAlertMinutes: 15,
		preShiftReminderMinutes: 240,
		overtimeAlertMinutes: 60,
		rounding: { mode: 'none', incrementMinutes: 1 },
		dailyOvertime: null,
		dailyDoubleTime: null,
		weeklyOvertime: null,
		holiday: { dates: [], multiplierBp: 10_000 },
		breakRules: {
			rules: [
				{
					kind: 'meal',
					afterMinutes: 6 * 60,
					minutes: 30,
					paid: false,
					mandatory: false,
				},
			],
			autoDeduction: null,
		},
		longShiftMinutes: 12 * 60,
		timesheetApprovalMode: 'approve',
		aggregateOvertimeAcrossScopes: null,
	}
}

/** Starter values merged onto a policy, keeping the choice nobody made for them. */
export function applyStarter(
	policy: LaborPolicyFields,
	dataRegion: string | null | undefined,
): LaborPolicyFields {
	const starter = starterPolicy(dataRegion)
	return {
		...policy,
		...starter,
		// Never invent an answer to a question the owner has not answered.
		aggregateOvertimeAcrossScopes: policy.aggregateOvertimeAcrossScopes,
	}
}

export const WEEKLY_OVERTIME_PRESET = {
	thresholdMinutes: 40 * 60,
	multiplierBp: 15_000,
} as const
export const DAILY_OVERTIME_PRESET = {
	thresholdMinutes: 8 * 60,
	multiplierBp: 15_000,
} as const
export const DAILY_DOUBLE_TIME_PRESET = {
	thresholdMinutes: 12 * 60,
	multiplierBp: 20_000,
} as const

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

/** Only the fields that changed: the API merges a patch onto the saved policy. */
export function buildPolicyPatch(
	baseline: LaborPolicyFields,
	current: LaborPolicyFields,
): Partial<Pick<LaborPolicyFields, EditablePolicyKey>> {
	const patch: Record<string, unknown> = {}
	for (const key of EDITABLE_POLICY_KEYS) {
		if (!same(baseline[key], current[key])) patch[key] = current[key]
	}
	return patch as Partial<Pick<LaborPolicyFields, EditablePolicyKey>>
}

export function isDirty(
	baseline: LaborPolicyFields,
	current: LaborPolicyFields,
): boolean {
	return Object.keys(buildPolicyPatch(baseline, current)).length > 0
}

/**
 * Problems the server would refuse, found before the request: the shared
 * cross-field rules, plus the ones a form can break by emptying a box.
 */
export function policyFormProblems(
	policy: LaborPolicyFields,
): LaborPolicyProblem[] {
	const parsed = laborPolicyBaseSchema.safeParse(policy)
	if (!parsed.success) {
		return parsed.error.issues.map((issue) => ({
			path: issue.path.join('.'),
			code: 'out_of_range',
		}))
	}
	return laborPolicyProblems(parsed.data)
}

/** First problem for a path (exact or a child of it), for inline messages. */
export function problemFor(
	problems: readonly LaborPolicyProblem[],
	path: string,
): LaborPolicyProblem | undefined {
	return problems.find(
		(problem) => problem.path === path || problem.path.startsWith(`${path}.`),
	)
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** 90 -> "1.5", 120 -> "2". At most two decimals; never trailing zeros. */
export function minutesToHoursText(minutes: number): string {
	const hours = Math.round((minutes / 60) * 100) / 100
	return String(hours)
}

/** "1.5" -> 90. Empty, negative or non-numeric input is `null`. */
export function hoursTextToMinutes(text: string): number | null {
	const normalized = text.trim().replace(',', '.')
	if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null
	const minutes = Math.round(Number(normalized) * 60)
	return Number.isFinite(minutes) ? minutes : null
}

/** 15000 -> "1.5", 20000 -> "2". */
export function bpToMultiplierText(bp: number): string {
	return String(Math.round(bp / 100) / 100)
}

/** "1.5" -> 15000. Anything outside the API range (1x to 4x) is `null`. */
export function multiplierTextToBp(text: string): number | null {
	const normalized = text.trim().replace(',', '.')
	if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null
	const bp = Math.round(Number(normalized) * 10_000)
	return bp >= 10_000 && bp <= 40_000 ? bp : null
}

/** Minutes after midnight as `HH:MM` for a time input. */
export function minuteToTimeValue(minute: number): string {
	const hours = Math.floor(minute / 60)
	const mins = minute % 60
	return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

export function timeValueToMinute(value: string): number | null {
	const match = /^(\d{2}):(\d{2})$/.exec(value)
	if (!match) return null
	const hours = Number(match[1])
	const mins = Number(match[2])
	if (hours > 23 || mins > 59) return null
	return hours * 60 + mins
}
