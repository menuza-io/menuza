import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type TimesheetStatus } from '@repo/staffing'

/**
 * Words for time card issues and statuses. Short labels for chips, longer help
 * for the review queue and the card sheet. Unknown codes (an issue a newer node
 * knows about) fall back to a generic label rather than a raw code.
 */

export const ISSUE_LABELS: Record<string, MessageDescriptor> = {
	missing_clock_out: msg`Missing clock-out`,
	unscheduled: msg`Unscheduled`,
	late: msg`Late`,
	early_in: msg`Early in`,
	early_out: msg`Early out`,
	missed_break: msg`Missed break`,
	auto_clock_out: msg`Auto clock-out`,
	edited: msg`Edited`,
	long_shift: msg`Long shift`,
	open_break: msg`Break not ended`,
	negative_duration: msg`Ends before it starts`,
	break_outside_entry: msg`Break outside shift`,
	overlapping_breaks: msg`Breaks overlap`,
	offline_punch: msg`Offline punch`,
	clock_skew: msg`Clock was off`,
	late_sync: msg`Sent late`,
	offline_override: msg`Check the rules`,
	auto_break_deducted: msg`Break deducted`,
}

export const ISSUE_HELP: Record<string, MessageDescriptor> = {
	missing_clock_out: msg`Clocked in and never clocked out. Set the time they left.`,
	auto_clock_out: msg`The system clocked them out. Check the time is right.`,
	long_shift: msg`Longer than your long-shift limit. Check it is not a missed clock-out.`,
	missed_break: msg`A required break was not taken or not recorded.`,
	clock_skew: msg`The tablet clock was off when this was punched. Check the times.`,
	late_sync: msg`Saved offline and sent more than 12 hours later. Check the times.`,
	offline_override: msg`Clocked in offline where the rules would have asked first (no shift, too early, or which job). Check it.`,
	open_break: msg`A break was started and never ended. Set when it ended.`,
	negative_duration: msg`The times do not add up. Fix the start or the end.`,
	break_outside_entry: msg`A break falls outside the shift. Fix its times.`,
	overlapping_breaks: msg`Two breaks overlap. Fix their times.`,
	unscheduled: msg`Clocked in without a scheduled shift.`,
	late: msg`Clocked in after the scheduled start.`,
	early_in: msg`Clocked in before the scheduled start.`,
	early_out: msg`Clocked out before the scheduled end.`,
	edited: msg`A manager changed this card.`,
	offline_punch: msg`Punched while the tablet was offline and sent later.`,
	auto_break_deducted: msg`A break was deducted automatically by your rules.`,
}

export const STATUS_LABELS: Record<TimesheetStatus, MessageDescriptor> = {
	open: msg`Open`,
	needs_review: msg`Needs review`,
	closed: msg`Closed`,
	approved: msg`Approved`,
	locked: msg`Locked`,
}

export const FALLBACK_ISSUE_LABEL = msg`Check this card`
