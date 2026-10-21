import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { waitlistErrorInfo } from '#app/utils/reservations/waitlist-errors.ts'

/**
 * Translated copy for the failures a host can hit on the stand (seat, arrive,
 * assign, load the day). The server's English `message` is never shown: a
 * known code, or failing that the HTTP status, picks the sentence.
 */
const ERROR_MESSAGES: Record<string, MessageDescriptor> = {
	stale_version: msg`Someone else changed this booking first. The board has been reloaded, so check it and try again.`,
	invalid_transition: msg`That change is no longer possible for this booking. The board has been reloaded.`,
	table_conflict: msg`That table is taken for this booking's time. Pick another table or resolve the overlap.`,
	table_occupied: msg`That table is taken for this booking's time. Pick another table or resolve the overlap.`,
	table_blocked: msg`That table is blocked for this booking's time. Pick another table.`,
	slot_unavailable: msg`That time is no longer available.`,
	service_closed: msg`The service is closed at that time.`,
	cutoff_passed: msg`It is too late to change this booking that way.`,
	payment_required: msg`This booking needs a payment first.`,
	rate_limited: msg`Too many requests. Wait a moment and try again.`,
	not_found: msg`This booking no longer exists. The board has been reloaded.`,
	reservations_disabled: msg`Reservations are turned off for this organization.`,
	location_not_found: msg`This location is no longer available.`,
	unauthorized_scope: msg`You do not have access to this location.`,
	forbidden_grant: msg`You do not have permission to do that.`,
	missing_grant: msg`You do not have permission to do that.`,
	missing_permission: msg`You do not have permission to do that.`,
	forbidden: msg`You do not have permission to do that.`,
}

const STATUS_MESSAGES: Record<number, MessageDescriptor> = {
	401: msg`Your session has ended. Sign in again to keep working.`,
	403: msg`You do not have permission to do that.`,
	404: msg`This booking no longer exists. The board has been reloaded.`,
	409: msg`Someone else changed this first. The board has been reloaded, so check it and try again.`,
	429: msg`Too many requests. Wait a moment and try again.`,
}

/** One translated sentence for a failed host-stand call; falls back to `fallback`. */
export function hostErrorMessage(
	err: unknown,
	tx: (descriptor: MessageDescriptor) => string,
	fallback: MessageDescriptor,
): string {
	const { code, status } = waitlistErrorInfo(err)
	if (code && ERROR_MESSAGES[code]) return tx(ERROR_MESSAGES[code]!)
	if (status && STATUS_MESSAGES[status]) {
		return tx(STATUS_MESSAGES[status]!)
	}
	return tx(fallback)
}

/** Copy for a day feed that cannot load: access problems are called out, the rest is generic. */
export function hostLoadErrorMessage(
	failure: { status: number | null; code: string | null },
	tx: (descriptor: MessageDescriptor) => string,
): string {
	if (failure.status === 401) return tx(STATUS_MESSAGES[401]!)
	if (failure.status === 403 || failure.status === 404) {
		return tx(msg`You do not have access to reservations for this location.`)
	}
	if (failure.code && ERROR_MESSAGES[failure.code]) {
		return tx(ERROR_MESSAGES[failure.code]!)
	}
	return tx(msg`The reservations could not be loaded. Try again.`)
}
