import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { StaffApiError } from './staff-client.ts'
import { describeStaffError } from './staff-errors.ts'

/**
 * Plain-language answers for the codes the schedule API refuses with, and the
 * wording of each warning a shift can carry. Each says what is wrong and what
 * to do. Codes this table does not know fall back to the general staff
 * messages, and raw server text is never shown.
 */
const MESSAGES: Record<string, MessageDescriptor> = {
	stale_shift: msg`Someone else changed this shift. It was reloaded, so try again.`,
	stale_week: msg`The schedule changed since you opened it. It was reloaded, so check it and publish again.`,
	shift_cancelled: msg`This shift was already removed.`,
	cancel_pending: msg`This shift is waiting to be removed. Publish the week to finish, or undo the removal.`,
	not_published: msg`This shift has not been published yet, so there is nothing to undo.`,
	nothing_to_publish: msg`There is nothing new to publish this week.`,
	invalid_shift_time: msg`The end time cannot be the same as the start time, and a shift cannot be longer than 25 hours.`,
	break_exceeds_shift: msg`The unpaid break is longer than the shift.`,
	week_full: msg`This week has as many shifts as it can hold. Remove some before adding more.`,
	same_week: msg`Choose a different week to copy from.`,
	template_name_taken: msg`A template with that name already exists.`,
	empty_template: msg`There are no shifts to save. Add some shifts to this week first.`,
	too_many_slots: msg`That is too many shifts for one template. Narrow it to some positions or people.`,
	staff_not_found: msg`We could not find that person.`,
	staff_terminated: msg`This person has left, so they cannot be scheduled.`,
	position_not_found: msg`We could not find that position.`,
	time_zone_unknown: msg`We could not find this workplace's time zone. Set it in the time clock settings.`,
	request_pending: msg`There is already a request waiting on this shift.`,
	request_stale: msg`This shift changed after the request was made. Ask the person to request again.`,
	already_decided: msg`This request was already decided.`,
	not_your_shift: msg`That shift does not belong to this person.`,
	superseded: msg`A newer version of this week was published since. Resend from the latest one.`,
	email_disabled: msg`Staff email is switched off, so nothing can be sent right now.`,
	resend_too_soon: msg`This was just sent. Wait a few minutes before sending it again.`,
}

export function describeScheduleError(
	error: unknown,
	translate: (descriptor: MessageDescriptor) => string,
): string {
	if (error instanceof StaffApiError) {
		const known = MESSAGES[error.code]
		if (known) return translate(known)
	}
	return describeStaffError(error, translate)
}

/** True when the server answered that the shift or week moved on without us. */
export function isStaleError(error: unknown): boolean {
	return (
		error instanceof StaffApiError &&
		(error.code === 'stale_shift' || error.code === 'stale_week')
	)
}

/**
 * The short line shown on a flagged shift. Numbers come from the server's
 * `detail` (minutes only); names and money never travel with a conflict.
 */
export const CONFLICT_COPY: Record<string, MessageDescriptor> = {
	overlap: msg`Overlaps another shift for this person`,
	time_off: msg`Has approved time off`,
	unavailable: msg`Outside their availability`,
	overtime: msg`Reaches overtime this week`,
	min_rest: msg`Less than the minimum rest since their last shift`,
	position_mismatch: msg`Not set up for this position here`,
	not_at_scope: msg`Does not work at this workplace`,
	staff_on_leave: msg`On leave`,
}

const CONFLICT_FALLBACK = msg`Needs a look`

export function describeConflict(
	code: string,
	translate: (descriptor: MessageDescriptor) => string,
): string {
	return translate(CONFLICT_COPY[code] ?? CONFLICT_FALLBACK)
}

/** Why a recommended shift was left open. */
export const OPEN_REASON_COPY: Record<string, MessageDescriptor> = {
	time_off: msg`on time off`,
	unavailable: msg`not available`,
	overlap: msg`already booked`,
	inactive: msg`no longer working here`,
	not_at_scope: msg`no longer at this workplace`,
	position_mismatch: msg`no longer set up for the position`,
}
