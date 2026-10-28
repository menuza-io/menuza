import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

/**
 * Translated copy for the failures the region answers on the QR operator
 * routes (tables, tabs, settings). The region's English `message` is never
 * shown: a known code, or failing that the HTTP status, picks the sentence.
 */
export const QR_ERROR_MESSAGES: Record<string, MessageDescriptor> = {
	stale_tab: msg`This tab changed since you opened it. Check the new total.`,
	tab_closed: msg`This tab is already closed.`,
	tab_not_found: msg`This tab no longer exists. The list has been reloaded.`,
	tab_open: msg`Close or void the open tab at this table before archiving it.`,
	payment_pending: msg`The guest is paying this tab online. Wait a moment and refresh, or stop the online payment.`,
	payment_review: msg`This tab was paid online. Check the payment before you close it.`,
	table_label_taken: msg`A table with this label already exists at this location.`,
	table_limit: msg`This location has reached the most tables it can have.`,
	table_not_found: msg`This table no longer exists. The list has been reloaded.`,
	invalid_request: msg`Check the details and try again.`,
	forbidden: msg`You do not have permission to do that.`,
}

const FORBIDDEN = QR_ERROR_MESSAGES.forbidden!
const FALLBACK: MessageDescriptor = msg`That did not work. Try again.`

/** The sentence for a failed QR operator request (code, then status). */
export function qrErrorMessage(cause: unknown, translate: I18n['_']): string {
	const failure =
		cause && typeof cause === 'object'
			? (cause as { code?: unknown; status?: unknown })
			: null
	const code = typeof failure?.code === 'string' ? failure.code : null
	const label = code ? QR_ERROR_MESSAGES[code] : undefined
	if (label) return translate(label)
	if (failure?.status === 401 || failure?.status === 403) {
		return translate(FORBIDDEN)
	}
	return translate(FALLBACK)
}
