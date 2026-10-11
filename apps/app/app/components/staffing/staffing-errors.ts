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
