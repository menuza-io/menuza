import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type WasteReason } from '@repo/inventory'

/**
 * What Stock says, in plain words (the plan's glossary: "Delivery", "Fill
 * up to", never "receiving" or "par"). Codes come from `/pos/inventory/*`
 * (`INVENTORY_POS_ERROR_CODES`); an unknown one gets a general sentence.
 */

/** Why a row the server refused for good was refused, for the sync screen. */
export const FAILURE_MESSAGES: Record<string, MessageDescriptor> = {
	count_closed: msg`The count was closed before this reached the office.`,
	wrong_location: msg`This tablet was moved to another location after this was saved.`,
	not_found: msg`The office no longer has the thing this was for.`,
	undo_expired: msg`It was too late to undo this waste.`,
	already_undone: msg`This waste was already undone.`,
	unit_mismatch: msg`The unit does not fit this item.`,
	reason_not_allowed: msg`That reason cannot be picked from a tablet.`,
	idempotency_conflict: msg`The office already has a different entry with this number.`,
	invalid_request: msg`The office could not read this entry.`,
	dependency_failed: msg`It could not be sent because what it belongs to was refused.`,
	payload_too_large: msg`This was too large to send.`,
	upload_not_configured: msg`The invoice photo could not be saved. The delivery itself was recorded.`,
	upload_failed: msg`The invoice photo could not be uploaded. The delivery itself was recorded.`,
	item_archived: msg`This item was removed from the stock list.`,
}

/** Why sending is on hold, with what to do. */
export const PAUSE_MESSAGES: Record<string, MessageDescriptor> = {
	staff_session_required: msg`Sign in with your PIN while connected to send what is saved on this tablet.`,
	staff_session_invalid: msg`Your sign-in ran out. Sign in again while connected to send what is saved on this tablet.`,
	inventory_not_enabled: msg`Stock is switched off for this tablet. What you saved stays here and goes when it is back on.`,
	inventory_disabled: msg`Stock is switched off for this restaurant. What you saved stays here and goes when it is back on.`,
	inventory_unavailable: msg`Stock is paused for now. What you saved stays here and goes when it is back on.`,
	pos_disabled: msg`Tablets are paused for now. What you saved stays here and goes when they are back on.`,
	inventory_needs_location: msg`This tablet needs a location before it can send stock. Ask a manager to set one in the Menuza app.`,
	inventory_needs_sign_in: msg`This tablet needs staff sign-in switched on before it can send stock. Ask a manager.`,
	contract_too_old: msg`This tablet needs an update before it can send stock. Reload the app.`,
	receive_needs_manager: msg`A manager must sign in to send deliveries.`,
	invalid_device: msg`The server did not recognise this tablet. It will try again.`,
	device_revoked: msg`This tablet was removed. Pair it again to send what is saved.`,
}

/** Why the last attempt failed and will be repeated. */
export const RETRY_MESSAGES: Record<string, MessageDescriptor> = {
	connection_lost: msg`No connection. It will try again by itself.`,
	rate_limited: msg`The server is busy. It will try again by itself.`,
	service_unavailable: msg`The server is not answering. It will try again by itself.`,
	internal_error: msg`The server had a problem. It will try again by itself.`,
	invalid_response: msg`The server gave an answer this tablet could not read. It will try again by itself.`,
}

const GENERAL = msg`The office refused this.`

export function failureText(code: string | null, i18n: Pick<I18n, '_'>) {
	const descriptor = (code && FAILURE_MESSAGES[code]) || GENERAL
	return i18n._(descriptor)
}

export function pauseText(code: string, i18n: Pick<I18n, '_'>) {
	const descriptor =
		PAUSE_MESSAGES[code] ??
		msg`Sending is on hold. It will go when this is fixed.`
	return i18n._(descriptor)
}

export function retryText(code: string, i18n: Pick<I18n, '_'>) {
	return i18n._(
		RETRY_MESSAGES[code] ?? msg`Sending failed. It will try again by itself.`,
	)
}

/** Whether signing in again is what clears a hold. */
export const needsSignIn = (code: string | null) =>
	code === 'staff_session_required' || code === 'staff_session_invalid'

export const WASTE_REASON_LABELS: Record<WasteReason, MessageDescriptor> = {
	expired: msg`Expired`,
	spoiled: msg`Spoiled`,
	over_prepped: msg`Over-prepped`,
	dropped: msg`Dropped`,
	returned: msg`Returned plate`,
	staff_meal: msg`Staff meal`,
	cancelled_after_cooking: msg`Cancelled after cooking`,
	remade_at_till: msg`Remade at the till`,
	other: msg`Other`,
}

/** The category as the office wrote it: a built-in key reads as words, an own category as typed. */
const CATEGORY_LABELS: Record<string, MessageDescriptor> = {
	meat: msg`Meat`,
	seafood: msg`Seafood`,
	produce: msg`Produce`,
	dairy: msg`Dairy`,
	dry_goods: msg`Dry goods`,
	bakery: msg`Bakery`,
	sauces: msg`Sauces`,
	drinks: msg`Drinks`,
	packaging: msg`Packaging`,
	cleaning: msg`Cleaning`,
	other: msg`Other`,
}

export function categoryText(category: string, i18n: Pick<I18n, '_'>): string {
	const known = CATEGORY_LABELS[category]
	if (known) return i18n._(known)
	return category.startsWith('custom:') ? category.slice(7) : category
}
