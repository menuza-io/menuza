import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { waitlistErrorInfo } from '#app/utils/reservations/waitlist-errors.ts'

const ERROR_MESSAGES: Record<string, MessageDescriptor> = {
	stale_version: msg`Someone else changed this customer first. The profile has been reloaded, so check it and try again.`,
	tag_exists: msg`A tag with this name already exists.`,
	invalid_tag: msg`Enter a tag name.`,
	system_tag: msg`Automatic tags cannot be changed by hand.`,
	invalid_note: msg`Enter the note text.`,
	invalid_guest: msg`Enter a name.`,
	invalid_merge: msg`Choose two different customers to merge.`,
	guest_erased: msg`This customer was erased and can no longer be changed.`,
	guest_merged: msg`This customer was merged into another profile.`,
	not_found: msg`This customer no longer exists. The list has been reloaded.`,
	missing_grant: msg`You do not have permission to do that.`,
	missing_permission: msg`You do not have permission to do that.`,
	forbidden: msg`You do not have permission to do that.`,
	merge_conflicting_customers: msg`These two people are both signed in as different customers, so they cannot be merged. Each keeps their own profile, orders and marketing choices.`,
	no_dining_profile: msg`This customer has no reservation history yet.`,
	phone_managed_by_sign_in: msg`A customer's phone number is managed through sign-in and cannot be changed here.`,
	recording_delete_failed: msg`A call recording could not be deleted, so nothing was erased. Try again.`,
}

export type PeopleErrorInfo = ReturnType<typeof waitlistErrorInfo>

export const peopleErrorInfo = waitlistErrorInfo

/** One translated sentence for a failed Customers call. */
export function peopleErrorMessage(
	err: unknown,
	translate: (descriptor: MessageDescriptor) => string,
	fallback: MessageDescriptor,
): string {
	const { code, status } = peopleErrorInfo(err)
	if (code && ERROR_MESSAGES[code]) return translate(ERROR_MESSAGES[code]!)
	if (status === 403) return translate(ERROR_MESSAGES.forbidden!)
	if (status === 404) return translate(ERROR_MESSAGES.not_found!)
	return translate(fallback)
}
