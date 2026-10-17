import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

const ERROR_MESSAGES: Record<string, MessageDescriptor> = {
	stale_version: msg`Someone else changed this party first. The list has been reloaded, so check it and try again.`,
	duplicate_active_entry: msg`This guest is already on the waitlist.`,
	waitlist_full: msg`The waitlist is full. Raise the party limit in Waitlist settings to add more.`,
	invalid_status_transition: msg`That change is no longer possible for this party. The list has been reloaded.`,
	table_occupied: msg`That table is taken for this party's time. Pick another table or seat the party over the booking.`,
	table_blocked: msg`That table is blocked or held for this party's time. Pick another table or seat the party over it.`,
	swap_target_seated: msg`The party on that table has already arrived, so you cannot swap with them. Move them, pick another table, or seat over the booking.`,
	no_move_target: msg`No other table is free for the party on that table. Swap, pick another table, or seat over the booking.`,
	invalid_move_target: msg`The party on that table cannot move onto the table being seated.`,
	invalid_table: msg`That table cannot be used here. Pick another table.`,
	missing_overbook_reason: msg`Add a reason to seat this party over a booking.`,
	no_availability: msg`No table is free for this party right now. Pick a table yourself or seat the party over a booking.`,
	not_found: msg`This party is no longer on the waitlist. The list has been reloaded.`,
}

const ISSUE_MESSAGES: Record<string, MessageDescriptor> = {
	phone: msg`Enter a valid phone number, including the country code.`,
	areaPrefId: msg`That seating area is not available at this location.`,
}

export type WaitlistErrorInfo = {
	code: string | null
	status: number | null
	/** The server rejected the version the screen was looking at. */
	stale: boolean
}

type ErrorBody = {
	error?: string
	code?: string
	issues?: Array<{ path?: string; code?: string; message?: string }>
}

function bodyOf(err: unknown): ErrorBody | null {
	if (!err || typeof err !== 'object') return null
	const body = (err as { body?: unknown }).body
	return body && typeof body === 'object' ? (body as ErrorBody) : null
}

export function waitlistErrorInfo(err: unknown): WaitlistErrorInfo {
	const body = bodyOf(err)
	const code = body?.error ?? body?.code ?? null
	const rawStatus =
		err && typeof err === 'object' ? (err as { status?: unknown }).status : null
	const status = typeof rawStatus === 'number' ? rawStatus : null
	return { code, status, stale: code === 'stale_version' }
}

/** Turns a failed waitlist call into one translated sentence the host can act on. */
export function waitlistErrorMessage(
	err: unknown,
	translate: (descriptor: MessageDescriptor) => string,
	fallback: MessageDescriptor,
): string {
	const { code } = waitlistErrorInfo(err)
	if (code === 'invalid') {
		const issue = bodyOf(err)?.issues?.find(
			(candidate) => candidate.path && ISSUE_MESSAGES[candidate.path],
		)
		if (issue?.path) return translate(ISSUE_MESSAGES[issue.path]!)
	}
	if (code && ERROR_MESSAGES[code]) return translate(ERROR_MESSAGES[code]!)
	return translate(fallback)
}
