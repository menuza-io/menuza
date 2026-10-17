import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { waitlistErrorInfo } from '#app/utils/reservations/waitlist-errors.ts'

const ERROR_MESSAGES: Record<string, MessageDescriptor> = {
	stale_version: msg`Someone else changed this guest first. The profile has been reloaded, so check it and try again.`,
	tag_exists: msg`A tag with this name already exists.`,
	invalid_tag: msg`Enter a tag name.`,
	system_tag: msg`Automatic tags cannot be changed by hand.`,
	invalid_note: msg`Enter the note text.`,
	invalid_guest: msg`Enter a first name.`,
	invalid_merge: msg`Choose two different guests to merge.`,
	guest_erased: msg`This guest was erased and can no longer be changed.`,
	guest_merged: msg`This guest was merged into another profile.`,
	not_found: msg`This guest no longer exists. The list has been reloaded.`,
	missing_grant: msg`You do not have permission to do that.`,
	missing_permission: msg`You do not have permission to do that.`,
	forbidden: msg`You do not have permission to do that.`,
}

export type GuestsErrorInfo = ReturnType<typeof waitlistErrorInfo>

export const guestsErrorInfo = waitlistErrorInfo

/** One translated sentence for a failed Guestbook call. */
export function guestsErrorMessage(
	err: unknown,
	translate: (descriptor: MessageDescriptor) => string,
	fallback: MessageDescriptor,
): string {
	const { code, status } = guestsErrorInfo(err)
	if (code && ERROR_MESSAGES[code]) return translate(ERROR_MESSAGES[code]!)
	if (status === 403) return translate(ERROR_MESSAGES.forbidden!)
	if (status === 404) return translate(ERROR_MESSAGES.not_found!)
	return translate(fallback)
}
