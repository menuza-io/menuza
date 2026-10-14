import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { StaffApiError } from './staff-client.ts'
import { describeStaffError } from './staff-errors.ts'

/**
 * Plain-language answers for the codes the timesheet API refuses with. Each
 * says what is wrong and what to do. Codes this table does not know fall back
 * to the general staff messages, and raw server text is never shown.
 */
const MESSAGES: Record<string, MessageDescriptor> = {
	stale_version: msg`Someone else changed this time card. Reload it to see their changes, then try again.`,
	card_locked: msg`This card is locked. Unlock it first if it needs to change.`,
	card_approved: msg`This card is approved. Reopen it first if it needs to change.`,
	in_future: msg`That time has not happened yet.`,
	overlaps_existing: msg`This overlaps another time card for the same person.`,
	ends_before_start: msg`The end has to come after the start.`,
	too_long: msg`A time card cannot be longer than 48 hours.`,
	invalid_position: msg`That person does not hold that position at this workplace.`,
	position_required: msg`This person holds several positions here. Choose which one they worked.`,
	break_outside_card: msg`Each break has to fall inside the shift.`,
	breaks_overlap: msg`Breaks cannot overlap each other.`,
	breaks_need_clock_out: msg`Add the end time before adding breaks.`,
	open_card: msg`This card is still open. Add the end time first.`,
	time_zone_unavailable: msg`We could not find this workplace's time zone. Set it in the time clock settings.`,
	pay_grant_required: msg`You need pay access to change tips or rates.`,
	nothing_to_change: msg`Nothing about this card changed.`,
	needs_fix: msg`This card has a problem to fix first, like a missing clock-out or an open break.`,
	approval_not_enabled: msg`Approval is off for this workplace. Turn it on in Labor rules.`,
	lock_not_enabled: msg`Locking is off for this workplace. Turn it on in Labor rules.`,
	not_approved: msg`Only approved cards can be locked or reopened.`,
	not_locked: msg`This card is not locked.`,
	already_approved: msg`This card is already approved.`,
	already_locked: msg`This card is already locked.`,
	range_too_large: msg`That range has too many cards. Narrow the filters.`,
	invalid_pay_period: msg`That date does not start a pay period.`,
}

export function describeTimesheetError(
	error: unknown,
	translate: (descriptor: MessageDescriptor) => string,
): string {
	if (error instanceof StaffApiError) {
		const known = MESSAGES[error.code]
		if (known) return translate(known)
	}
	return describeStaffError(error, translate)
}

/** The same lookup for a per-card code inside a batch answer. */
export function describeCardCode(
	code: string | undefined,
	translate: (descriptor: MessageDescriptor) => string,
): string {
	const known = code ? MESSAGES[code] : undefined
	if (known) return translate(known)
	if (code === 'not_found') {
		return translate(
			msg`We could not find that card. It may have been removed.`,
		)
	}
	return translate(msg`This card could not be changed.`)
}
