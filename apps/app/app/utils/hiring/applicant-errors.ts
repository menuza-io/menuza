import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { StaffApiError } from '#app/utils/staffing/staff-client.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'

/**
 * Plain-language answers for the codes the hiring API refuses with. Each says
 * what is wrong and what to do. Codes this table does not know fall back to the
 * general staff messages, and raw server text is never shown.
 */
const MESSAGES: Record<string, MessageDescriptor> = {
	'Application not found': msg`We could not find that applicant. They may have been removed, or you may not have access to them.`,
	already_hired: msg`This person has already been hired.`,
	already_declined: msg`This applicant has already been declined.`,
	application_declined: msg`This applicant was declined. Move them back into the pipeline first.`,
	application_closed: msg`This applicant is no longer in the running.`,
	duplicate_application: msg`This person has applied again and has an open application for the same job. Open that one instead.`,
	stage_change_not_allowed: msg`That move is not allowed. Use Hire or Decline for those.`,
	interview_in_past: msg`Pick a time that has not passed yet.`,
	interview_too_far: msg`Pick a time within the next year.`,
	scope_required: msg`Choose where the interview takes place.`,
	staff_exists: msg`Someone on your team already has this email or phone number. Check the team list before hiring.`,
	staff_terminated_match: msg`A former team member has this email or phone number. Rehire them from the team list instead.`,
	'Position not found': msg`That position no longer exists. Pick another.`,
	position_archived: msg`That position is archived. Pick another.`,
	employee_number_taken: msg`That payroll ID is already used by someone else.`,
	'Interview not found': msg`We could not find that interview.`,
	rate_limit_exceeded: msg`Too many requests. Wait a moment and try again.`,
}

export function describeApplicantError(
	error: unknown,
	translate: (descriptor: MessageDescriptor) => string,
): string {
	if (error instanceof StaffApiError) {
		const known = MESSAGES[error.code]
		if (known) return translate(known)
	}
	return describeStaffError(error, translate)
}
