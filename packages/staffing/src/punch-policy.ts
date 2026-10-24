import {
	type BreakKind,
	type BreakRule,
	type LaborPolicyFields,
} from './labor-policy.ts'
import { type LaborRules } from './rules.ts'
import {
	computeTimecard,
	computeWeek,
	type TimeBreak,
	type TimeEntryInput,
} from './time-math.ts'
import { weekStartFor } from './tz.ts'

/**
 * Pure punch policy: the decisions a clock-in or clock-out is subject to, the
 * issue taxonomy of a time entry, and the cached minute totals stored on it.
 * No I/O. tenant-api calls these inside its punch transaction, and the
 * timesheet code reuses them, so a card can never be judged two ways.
 */

// ---------------------------------------------------------------------------
// Issue taxonomy
// ---------------------------------------------------------------------------

export const ENTRY_ISSUE_CODES = [
	'missing_clock_out',
	'unscheduled',
	'late',
	'early_in',
	'early_out',
	'missed_break',
	'auto_clock_out',
	'edited',
	'long_shift',
	'open_break',
	'negative_duration',
	'break_outside_entry',
	'overlapping_breaks',
	'offline_punch',
	'clock_skew',
	'auto_break_deducted',
	'late_sync',
	'offline_override',
] as const
export type EntryIssueCode = (typeof ENTRY_ISSUE_CODES)[number]

/**
 * Issues that come from how the punches arrived (or from a person) and so
 * cannot be recomputed from the times alone. They persist across recomputes.
 */
export const PUNCH_FLAG_ISSUES = [
	'unscheduled',
	'late',
	'early_in',
	'early_out',
	'offline_punch',
	'clock_skew',
	'late_sync',
	'offline_override',
	'auto_clock_out',
	'edited',
] as const satisfies readonly EntryIssueCode[]
export type PunchFlagIssue = (typeof PUNCH_FLAG_ISSUES)[number]

/**
 * Issues that keep a closed card in the needs-review queue until a manager
 * deals with it. The rest (late, unscheduled, offline, ...) are information
 * shown on the card.
 */
export const REVIEW_ISSUES = [
	'missing_clock_out',
	'auto_clock_out',
	'long_shift',
	'missed_break',
	'clock_skew',
	'late_sync',
	'offline_override',
	'open_break',
	'negative_duration',
	'break_outside_entry',
	'overlapping_breaks',
] as const satisfies readonly EntryIssueCode[]

export function isEntryIssueCode(value: unknown): value is EntryIssueCode {
	return (
		typeof value === 'string' &&
		(ENTRY_ISSUE_CODES as readonly string[]).includes(value)
	)
}

export function needsReview(issues: readonly string[]): boolean {
	return issues.some((issue) =>
		(REVIEW_ISSUES as readonly string[]).includes(issue),
	)
}

/** Status of an entry right after it closes (approval is a manager action). */
export function statusAfterClose(
	issues: readonly string[],
): 'closed' | 'needs_review' {
	return needsReview(issues) ? 'needs_review' : 'closed'
}

// ---------------------------------------------------------------------------
// Clock-in and clock-out decisions
// ---------------------------------------------------------------------------

export type ShiftWindow = {
	id: string
	startAt: number
	endAt: number
	positionId: string | null
}

/**
 * `undefined`: the schedule is not available, so nothing about scheduling can
 * be judged. `null`: the schedule is known and no shift matches.
 */
export type ShiftLookup = ShiftWindow | null | undefined

type SchedulePolicy = Pick<
	LaborPolicyFields,
	'lateGraceMinutes' | 'preventEarlyMinutes' | 'allowUnscheduled'
>

export type ClockInDecision =
	| {
			ok: true
			flags: Array<'unscheduled' | 'late' | 'early_in'>
			shift: ShiftWindow | null
	  }
	| { ok: false; code: 'early_clock_in'; earliestAt: number }
	| { ok: false; code: 'unscheduled_not_allowed' }

const MS_PER_MINUTE = 60_000

export function decideClockIn(input: {
	policy: SchedulePolicy
	atMs: number
	shift: ShiftLookup
}): ClockInDecision {
	const { policy, atMs, shift } = input
	if (shift === undefined) return { ok: true, flags: [], shift: null }
	if (shift === null) {
		if (!policy.allowUnscheduled) {
			return { ok: false, code: 'unscheduled_not_allowed' }
		}
		return { ok: true, flags: ['unscheduled'], shift: null }
	}
	if (policy.preventEarlyMinutes !== null) {
		const earliestAt =
			shift.startAt - policy.preventEarlyMinutes * MS_PER_MINUTE
		if (atMs < earliestAt)
			return { ok: false, code: 'early_clock_in', earliestAt }
	}
	const flags: Array<'late' | 'early_in'> = []
	const grace = policy.lateGraceMinutes * MS_PER_MINUTE
	if (atMs > shift.startAt + grace) flags.push('late')
	else if (
		policy.preventEarlyMinutes === null &&
		atMs < shift.startAt - grace
	) {
		// With a prevent-early window the manager has said how early is fine, so
		// arriving inside it is not an issue.
		flags.push('early_in')
	}
	return { ok: true, flags, shift }
}

export function decideClockOut(input: {
	policy: Pick<LaborPolicyFields, 'lateGraceMinutes'>
	atMs: number
	shift: ShiftLookup
}): Array<'early_out'> {
	const { policy, atMs, shift } = input
	if (!shift) return []
	return atMs < shift.endAt - policy.lateGraceMinutes * MS_PER_MINUTE
		? ['early_out']
		: []
}

/** When an entry still open becomes due for automatic closing; null when off. */
export function autoClockOutDeadline(input: {
	policy: Pick<LaborPolicyFields, 'autoClockOutMinutes'>
	clockInAt: number
	shiftEndAt: number | null
}): number | null {
	const { policy, clockInAt, shiftEndAt } = input
	if (policy.autoClockOutMinutes === null) return null
	return (shiftEndAt ?? clockInAt) + policy.autoClockOutMinutes * MS_PER_MINUTE
}

/** When the missed clock-out reminder is due; null when off. */
export function missedClockOutReminderDeadline(input: {
	policy: Pick<LaborPolicyFields, 'missedClockOutReminderMinutes'>
	clockInAt: number
	shiftEndAt: number | null
}): number | null {
	const { policy, clockInAt, shiftEndAt } = input
	if (policy.missedClockOutReminderMinutes === null) return null
	return (
		(shiftEndAt ?? clockInAt) +
		policy.missedClockOutReminderMinutes * MS_PER_MINUTE
	)
}

// ---------------------------------------------------------------------------
// Break rules
// ---------------------------------------------------------------------------

export type EntryBreak = TimeBreak & { kind: BreakKind }

/** Whether a break of `kind` is paid under the policy (rest paid, meal unpaid by default). */
export function breakIsPaid(
	rules: readonly BreakRule[],
	kind: BreakKind,
): boolean {
	const rule = rules.find((r) => r.kind === kind)
	return rule ? rule.paid : kind === 'rest'
}

/** Mandatory rules the shift reached without a long enough closed break. */
export function missedBreakRules(
	rules: readonly BreakRule[],
	elapsedMinutes: number,
	breaks: readonly EntryBreak[],
): BreakRule[] {
	return rules.filter((rule) => {
		if (!rule.mandatory || elapsedMinutes < rule.afterMinutes) return false
		return !breaks.some(
			(b) =>
				b.kind === rule.kind &&
				b.endAt !== null &&
				(b.endAt - b.startAt) / MS_PER_MINUTE >= rule.minutes,
		)
	})
}

// ---------------------------------------------------------------------------
// Entry issues
// ---------------------------------------------------------------------------

export type EntryIssueInput = {
	entry: Omit<TimeEntryInput, 'breaks'> & { breaks: readonly EntryBreak[] }
	rules: LaborRules
	breakRules: readonly BreakRule[]
	timeZone: string
	/** Used to judge an open entry; without it an open entry is never "missing". */
	nowMs?: number
	/** Issues that came with the punches (late, offline, ...), persisted as-is. */
	punchFlags?: readonly string[]
}

/**
 * Every issue an entry has: the persisted punch flags, whatever the shared time
 * math reports (long shift, overlapping breaks, ...), and break and clock-out
 * rules. Sorted by taxonomy order so the output is stable.
 */
export function computeEntryIssues(input: EntryIssueInput): EntryIssueCode[] {
	const { entry, rules, breakRules, timeZone, nowMs } = input
	const found = new Set<EntryIssueCode>()
	for (const flag of input.punchFlags ?? []) {
		if (
			(PUNCH_FLAG_ISSUES as readonly string[]).includes(flag) &&
			isEntryIssueCode(flag)
		) {
			found.add(flag)
		}
	}

	const card = computeTimecard(entry, rules, { timeZone, nowMs })
	for (const issue of card.issues) {
		if (issue !== 'open_entry') found.add(issue)
	}

	const open = entry.clockOutAt === null
	if (
		open &&
		nowMs !== undefined &&
		(nowMs - entry.clockInAt) / MS_PER_MINUTE > rules.longShiftMinutes
	) {
		found.add('missing_clock_out')
	}

	if (!entry.breakWaived) {
		const elapsed = open
			? nowMs === undefined
				? 0
				: Math.floor((nowMs - entry.clockInAt) / MS_PER_MINUTE)
			: card.elapsedMinutes
		if (missedBreakRules(breakRules, elapsed, entry.breaks).length > 0) {
			found.add('missed_break')
		}
	}

	return ENTRY_ISSUE_CODES.filter((code) => found.has(code))
}

// ---------------------------------------------------------------------------
// Cached minutes
// ---------------------------------------------------------------------------

export type CachedMinutes = {
	regularMinutes: number
	overtimeMinutes: number
	doubleTimeMinutes: number
	holidayMinutes: number
	/** Paid worked minutes: elapsed minus unpaid breaks. */
	paidMinutes: number
	unpaidBreakMinutes: number
}

export type CacheContext = { rules: LaborRules; timeZone: string }

/**
 * Cached minutes plus the estimated cost of one entry, from the same
 * `computeWeek` the timesheets and reports use. `costUnits` is unrounded (see
 * `EntryCost`); a person's total is rounded once, from the sum.
 */
export type EntryFigures = CachedMinutes & {
	costUnits: number
	/** Currency of the entry's rate snapshot; null when it has none. */
	costCurrency: string | null
	/** Worked minutes without a rate, so without a cost figure. */
	unpricedMinutes: number
}

const zeroFigures = (entry: TimeEntryInput): EntryFigures => ({
	regularMinutes: 0,
	overtimeMinutes: 0,
	doubleTimeMinutes: 0,
	holidayMinutes: 0,
	paidMinutes: 0,
	unpaidBreakMinutes: 0,
	costUnits: 0,
	costCurrency: entry.currency ?? null,
	unpricedMinutes: 0,
})

/**
 * Minutes and estimated cost for a person's entries. `entries` must hold every
 * entry of that person that touches the weeks of interest (overtime depends on
 * the whole week). Scopes are evaluated on their own unless their policy
 * aggregates overtime across scopes, in which case they share one set of
 * thresholds, taken from the most recent entry's scope.
 *
 * A shift that crosses a week boundary is split by the shared math; its figures
 * are the sum over the weeks it touches.
 */
export function computeEntryFigures(
	entries: readonly TimeEntryInput[],
	resolve: (scopeId: string) => CacheContext,
	nowMs?: number,
): Map<string, EntryFigures> {
	const result = new Map<string, EntryFigures>(
		entries.map((entry) => [entry.id, zeroFigures(entry)]),
	)

	const groups = new Map<string, TimeEntryInput[]>()
	for (const entry of entries) {
		const ctx = resolve(entry.scopeId)
		const key = ctx.rules.aggregateOvertimeAcrossScopes
			? 'all'
			: `loc:${entry.scopeId}`
		const list = groups.get(key) ?? []
		list.push(entry)
		groups.set(key, list)
	}

	for (const group of groups.values()) {
		const anchor = group.reduce((a, b) => (b.clockInAt > a.clockInAt ? b : a))
		const { rules, timeZone } = resolve(anchor.scopeId)
		const cards = group.map((e) =>
			computeTimecard(e, rules, { timeZone, nowMs }),
		)

		const weeks = new Set<string>()
		for (const card of cards) {
			for (const slice of card.slices) {
				weeks.add(weekStartFor(slice.date, rules.weekStartsOn))
			}
		}
		for (const card of cards) {
			const row = result.get(card.entryId)!
			row.unpaidBreakMinutes = card.unpaidBreakMinutes
		}
		for (const weekStartDate of [...weeks].sort()) {
			const week = computeWeek(group, rules, { timeZone, nowMs, weekStartDate })
			for (const [entryId, buckets] of Object.entries(week.entries)) {
				const row = result.get(entryId)
				if (!row) continue
				row.regularMinutes += buckets.regular
				row.overtimeMinutes += buckets.overtime
				row.doubleTimeMinutes += buckets.doubleTime
				row.holidayMinutes += buckets.holiday
				row.paidMinutes += buckets.total
			}
			for (const [entryId, cost] of Object.entries(week.entryCost)) {
				const row = result.get(entryId)
				if (!row) continue
				row.costUnits += cost.units
				row.unpricedMinutes += cost.unpricedMinutes
			}
		}
	}
	return result
}

/** Cached regular/overtime/paid/unpaid minutes: the minute half of the figures. */
export function computeCachedMinutes(
	entries: readonly TimeEntryInput[],
	resolve: (scopeId: string) => CacheContext,
	nowMs?: number,
): Map<string, CachedMinutes> {
	const result = new Map<string, CachedMinutes>()
	for (const [id, figures] of computeEntryFigures(entries, resolve, nowMs)) {
		result.set(id, {
			regularMinutes: figures.regularMinutes,
			overtimeMinutes: figures.overtimeMinutes,
			doubleTimeMinutes: figures.doubleTimeMinutes,
			holidayMinutes: figures.holidayMinutes,
			paidMinutes: figures.paidMinutes,
			unpaidBreakMinutes: figures.unpaidBreakMinutes,
		})
	}
	return result
}
