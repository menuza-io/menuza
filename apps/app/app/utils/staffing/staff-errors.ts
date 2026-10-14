import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { StaffApiError } from './staff-client.ts'

/**
 * Plain-language messages for the short error codes the regional API returns.
 * Each one says what went wrong and what to do next. Anything unknown falls
 * back to a generic line; raw server text is never shown to the manager.
 */
const MESSAGES: Record<string, MessageDescriptor> = {
	employee_number_taken: msg`That payroll ID is already used by someone else.`,
	scope_out_of_scope: msg`You do not have access to that workplace.`,
	unrestricted_scope_required: msg`This needs access to every workplace.`,
	duplicate_assignment: msg`Each workplace can only be added once.`,
	multiple_primary: msg`Only one workplace can be the main one.`,
	staff_terminated: msg`This person has left. Rehire them first.`,
	already_terminated: msg`This person has already left.`,
	not_eligible_for_rehire: msg`They were marked not eligible for rehire.`,
	not_terminated: msg`This person has not left.`,
	already_assigned: msg`They already work at that workplace.`,
	assignment_inactive: msg`They no longer work at that workplace.`,
	position_name_taken: msg`A position with that name already exists.`,
	position_archived: msg`That position is archived.`,
	primary_job_exists: msg`They already have a main position at that workplace.`,
	job_exists: msg`They already have that position at this workplace.`,
	job_closed: msg`Only the current pay row can change.`,
	no_change: msg`Nothing about the pay would change.`,
	pin_unavailable: msg`Could not make a PIN. Try again.`,
	region_mismatch: msg`Staff data is held in a different region from this account.`,
	token_unavailable: msg`We could not confirm your access. Reload the page.`,
	invalid_policy: msg`Some settings do not fit together. Check the highlighted fields.`,
	stale_version: msg`Someone else changed these settings. Reload to see their changes, then try again.`,
	aggregate_overtime_required: msg`Choose how overtime is counted for people who work at more than one workplace.`,
	too_many_pending_codes: msg`This workplace already has several unused pairing codes. Cancel one or wait for them to expire.`,
	time_zone_required: msg`Set this workplace's time zone before pairing a tablet.`,
	kiosk_disabled: msg`Kiosk time clocks are turned off right now.`,
	device_revoked: msg`That tablet has already been removed.`,
	already_used: msg`That pairing code was already used.`,
	not_found: msg`We could not find that. It may have been removed.`,
	'Staff member not found': msg`We could not find that person.`,
	'Position not found': msg`We could not find that position.`,
	'Job not found': msg`We could not find that position record.`,
	'Assignment not found': msg`We could not find that workplace.`,
	'Note not found': msg`We could not find that note.`,
	'Impersonated sessions are read-only': msg`You are viewing as another user. Staff data is read-only.`,
	Forbidden: msg`You do not have permission to do that.`,
	Unauthorized: msg`Your session expired. Reload the page.`,
	'Invalid request': msg`Check the highlighted fields and try again.`,
}

const FALLBACK = msg`Something went wrong. Try again.`
const OFFLINE = msg`We could not reach the staff service. Check your connection.`

export function describeStaffError(
	error: unknown,
	translate: (descriptor: MessageDescriptor) => string,
): string {
	if (error instanceof StaffApiError) {
		const known = MESSAGES[error.code]
		if (known) return translate(known)
		if (error.status === 403) return translate(MESSAGES.Forbidden!)
		return withReference(translate(FALLBACK), `${error.status} ${error.code}`)
	}
	if (error instanceof TypeError) return translate(OFFLINE)
	return withReference(
		translate(FALLBACK),
		error instanceof Error ? error.message : 'unknown',
	)
}

/**
 * A short, technical reference appended to the generic message so a report
 * ("... (404 Endpoint Not Found)") points straight at the cause. It only ever
 * carries the HTTP status and the server's short error code, never raw bodies.
 */
function withReference(message: string, reference: string): string {
	const safe = reference.replace(/[^\w .:-]/g, '').slice(0, 60)
	return safe ? `${message} (${safe})` : message
}

/** Field-level issues from a 400, keyed by the field path the server used. */
export function fieldIssues(error: unknown): Record<string, string> {
	if (!(error instanceof StaffApiError)) return {}
	const out: Record<string, string> = {}
	for (const issue of error.issues) {
		if (issue.path && !(issue.path in out)) out[issue.path] = issue.code
	}
	return out
}
