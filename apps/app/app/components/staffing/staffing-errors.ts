import { type I18n } from '@lingui/core'
import { msg } from '@lingui/macro'
import { StaffingRequestError } from '#app/hooks/use-staffing-client.ts'

/** Maps regional API error codes to operator-facing copy. */
export function staffingErrorMessage(i18n: I18n, error: unknown) {
	const code = error instanceof StaffingRequestError ? error.code : ''
	const messages: Record<string, string> = {
		unknown_location: i18n._(msg`That location is not available.`),
		unknown_position: i18n._(msg`Choose an existing position.`),
		position_archived: i18n._(msg`That position is archived.`),
		assignment_required: i18n._(msg`Assign at least one location.`),
		duplicate_name: i18n._(msg`A position with that name already exists.`),
		already_terminated: i18n._(msg`This person is already terminated.`),
		already_active: i18n._(msg`This person is already active.`),
		invalid_rows: i18n._(msg`Fix the highlighted rows and try again.`),
		no_rows: i18n._(msg`Paste at least one person.`),
		not_found: i18n._(msg`This record no longer exists. Refresh the page.`),
		unknown_staff: i18n._(msg`That person is no longer on the team.`),
		staff_inactive: i18n._(msg`That person is terminated.`),
		staff_not_assigned: i18n._(
			msg`That person is not assigned to this location. Add the location on the Team page.`,
		),
		invalid_dates: i18n._(msg`Repeat days must be in the same week.`),
		location_change: i18n._(
			msg`A shift cannot move to another location. Delete it and add a new one.`,
		),
		nothing_to_copy: i18n._(msg`That week has no shifts to copy.`),
		nothing_to_publish: i18n._(msg`There are no changes to publish.`),
		pin_taken: i18n._(
			msg`Someone else already uses that PIN. Choose another, or generate one.`,
		),
		pin_repeated: i18n._(msg`Avoid a PIN that repeats one digit.`),
		pin_sequence: i18n._(msg`Avoid a PIN that counts up or down.`),
		pin_format: i18n._(msg`A PIN is 4 to 6 digits.`),
		invalid_pin: i18n._(msg`A PIN is 4 to 6 digits.`),
		kiosk_disabled: i18n._(
			msg`Time clocks are paused in your data region. Try again later.`,
		),
		already_revoked: i18n._(msg`That time clock was already removed.`),
		entry_overlap: i18n._(
			msg`This overlaps another time card for the same person.`,
		),
		entry_locked: i18n._(
			msg`This time card is approved. Reopen it before making changes.`,
		),
		not_approved: i18n._(msg`This time card is not approved.`),
		already_clocked_in: i18n._(
			msg`This person already has an open time card. Close it first.`,
		),
		in_future: i18n._(msg`Times can’t be in the future.`),
		invalid_times: i18n._(msg`Clock-out must be after clock-in.`),
		break_too_long: i18n._(msg`The break is longer than the time worked.`),
		break_needs_clock_out: i18n._(
			msg`Add a clock-out time before recording a break.`,
		),
		region_mismatch: i18n._(
			msg`Your organization’s data region is changing. Try again shortly.`,
		),
		invalid_input: i18n._(msg`Check the highlighted fields and try again.`),
		'Write access required': i18n._(
			msg`You can view staffing data but not change it.`,
		),
		unauthorized: i18n._(msg`Your session expired. Refresh the page.`),
	}
	return (
		messages[code] ??
		i18n._(msg`Something went wrong reaching staffing data. Try again.`)
	)
}
