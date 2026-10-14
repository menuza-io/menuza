import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { StaffApiError } from './staff-client.ts'
import { describeStaffError } from './staff-errors.ts'

/**
 * Plain-language answers for the codes the onboarding API refuses with. Codes
 * this table does not know fall back to the general staff messages, and raw
 * server text is never shown.
 */
const MESSAGES: Record<string, MessageDescriptor> = {
	'Template not found': msg`We could not find that template. It may have been archived.`,
	'Task not found': msg`We could not find that task. It may have been removed.`,
	'Certificate not found': msg`We could not find that certificate.`,
	unrestricted_scope_required: msg`Templates apply to every workplace, so changing one needs access to every workplace.`,
	template_limit: msg`You have reached the limit of templates. Archive one you no longer use.`,
	task_limit: msg`This person already has the most tasks a checklist can hold.`,
	template_already_applied: msg`This checklist was already added for them.`,
	certificate_limit: msg`This person already has the most certificates that can be tracked.`,
	staff_terminated: msg`This person has left. Rehire them to add tasks.`,
	link_required: msg`Add the link to the form.`,
	link_not_allowed: msg`Only a form task has a link.`,
	policy_text_required: msg`Write the policy they are acknowledging.`,
	member_required: msg`Choose who this task is for.`,
	label_required: msg`Say what kind of certificate this is.`,
	expires_before_issued: msg`The expiry date cannot be before the issue date.`,
}

export function describeOnboardingError(
	error: unknown,
	translate: (descriptor: MessageDescriptor) => string,
): string {
	if (error instanceof StaffApiError) {
		const known = MESSAGES[error.code]
		if (known) return translate(known)
	}
	return describeStaffError(error, translate)
}
