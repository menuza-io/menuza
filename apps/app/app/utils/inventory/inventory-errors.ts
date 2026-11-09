import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'

/**
 * One owner-language sentence for a failed regional inventory call. The
 * region's own message is never shown: it is English and written for
 * developers.
 */
export function inventoryErrorMessage(error: unknown): MessageDescriptor {
	if (error instanceof OperatorRequestError) {
		if (error.code === 'location_forbidden') {
			return msg`You do not have access to inventory at this location.`
		}
		if (error.status === 401 || error.status === 403) {
			return msg`You do not have access to inventory. Ask an owner to check your role.`
		}
		if (error.code === 'not_found' || error.status === 404) {
			return msg`This record is no longer here. It may have been archived or removed.`
		}
		if (error.status === 503 || error.code === 'inventory_unavailable') {
			return msg`Inventory is paused right now. Try again in a few minutes.`
		}
	}
	return msg`We could not load your inventory. Check your connection and try again.`
}

/**
 * One owner-language sentence for a failed save. A save never fails
 * silently: the form stays on screen with this message and a retry.
 */
export function inventorySaveErrorMessage(error: unknown): MessageDescriptor {
	if (error instanceof OperatorRequestError) {
		if (error.code === 'unit_in_use' || error.code === 'unit_locked') {
			return msg`This unit is already used by stock, so it cannot be changed.`
		}
		if (error.code === 'unit_mismatch') {
			return msg`That unit cannot measure this item. Pick another unit.`
		}
		if (error.code === 'limit_reached') {
			return msg`You have reached the limit for this list. Archive or remove old items first.`
		}
		if (error.code === 'idempotency_conflict') {
			return msg`This change conflicted with an earlier attempt. Close this form and try again.`
		}
		if (error.code === 'already_undone') {
			return msg`This was already undone.`
		}
		if (error.code === 'undo_expired') {
			return msg`It is too late to undo this entry.`
		}
		if (error.code === 'count_closed') {
			return msg`This count is already closed.`
		}
		if (error.code === 'task_closed') {
			return msg`This prep task was already finished or skipped.`
		}
		if (error.code === 'transfer_closed') {
			return msg`This transfer is already closed.`
		}
		if (error.code === 'send_in_progress') {
			return msg`This order is being sent right now. Wait a moment and refresh.`
		}
		if (error.code === 'currency_unknown') {
			return msg`Set a currency for this location or enter prices on the first delivery.`
		}
		if (error.code === 'currency_mismatch') {
			return msg`The currency does not match this location's currency.`
		}
		if (error.code === 'not_batch_counted' || error.code === 'batch_not_counted') {
			return msg`Turn on batch counting for this made item before recording a batch.`
		}
		if (error.code === 'not_found' || error.status === 404) {
			return msg`This record could not be found. It may have been archived or removed.`
		}
		if (error.code === 'order_not_editable') {
			return msg`This order was already sent, so its items cannot change. Start a new order instead.`
		}
		if (error.code === 'order_closed') {
			return msg`This order is already closed.`
		}
		if (error.code === 'order_empty') {
			return msg`Add at least one item before you send this order.`
		}
		if (error.code === 'supplier_mismatch') {
			return msg`That item is not bought from this supplier.`
		}
		if (error.code === 'purchasing_required') {
			return msg`This needs the purchasing role. Ask an owner to check your role.`
		}
		if (error.code === 'prices_confirmed') {
			return msg`The prices on this delivery were already confirmed.`
		}
		if (error.code === 'upload_not_configured') {
			return msg`Invoice photos are not set up for your business yet.`
		}
		if (error.code === 'email_failed') {
			return msg`The email could not be sent. Send it by WhatsApp or copy the text instead.`
		}
		if (error.code === 'feature_disabled') {
			return msg`This is not turned on for your business.`
		}
		if (error.code === 'stale_version' || error.status === 409) {
			return msg`Someone else changed this first. Close it, open it again and retry.`
		}
		if (error.code === 'location_forbidden') {
			return msg`You do not have access to inventory at this location.`
		}
		if (error.status === 401 || error.status === 403) {
			return msg`You do not have permission to change inventory. Ask an owner to check your role.`
		}
		if (error.status === 503 || error.code === 'inventory_unavailable') {
			return msg`Inventory is paused right now. Try again in a few minutes.`
		}
		if (error.status === 400 || error.status === 422) {
			return msg`Something in this form was not accepted. Check it and try again.`
		}
	}
	return msg`We could not save this. Check your connection and try again.`
}

/**
 * Whether a failed recipe call means "this member or organization has no
 * recipes": the panel then disappears instead of showing an error.
 */
export function isRecipesUnavailable(error: unknown): boolean {
	return (
		error instanceof OperatorRequestError &&
		(error.code === 'feature_disabled' ||
			error.code === 'forbidden' ||
			error.status === 403 ||
			error.status === 404)
	)
}

/** One owner-language sentence for a failed recipe save or clear. */
export function recipeSaveErrorMessage(error: unknown): MessageDescriptor {
	if (error instanceof OperatorRequestError) {
		if (error.code === 'recipe_cycle') {
			return msg`An ingredient made in house uses this dish or itself, so it loops. Remove that ingredient.`
		}
		if (error.code === 'recipe_too_deep') {
			return msg`Made-in-house ingredients are nested too deeply. Simplify one of them.`
		}
		if (error.code === 'recipe_empty') {
			return msg`Add at least one ingredient, or use Clear recipe.`
		}
		if (error.code === 'not_a_made_item') {
			return msg`Only an item made in house can have its own recipe.`
		}
		if (error.code === 'unit_mismatch') {
			return msg`One of the units cannot measure its ingredient. Pick another unit.`
		}
		if (error.code === 'effective_from_too_old') {
			return msg`That start date is too far in the past.`
		}
		if (error.code === 'feature_disabled') {
			return msg`Recipes are not turned on for your business.`
		}
		if (error.code === 'forbidden' || error.status === 403) {
			return msg`You do not have permission to change recipes. Ask an owner to check your role.`
		}
	}
	return inventorySaveErrorMessage(error)
}

/** True for the 409 that means someone saved a newer version first. */
export function isStaleVersion(error: unknown): boolean {
	return error instanceof OperatorRequestError && error.code === 'stale_version'
}

/** One owner-language sentence for a failed "Record a batch". */
export function batchSaveErrorMessage(error: unknown): MessageDescriptor {
	if (error instanceof OperatorRequestError) {
		if (error.code === 'recipe_empty') {
			return msg`This item has no recipe yet. Add what goes into it first, then record a batch.`
		}
		if (error.code === 'not_a_made_item') {
			return msg`Only an item made in house can be recorded as a batch.`
		}
		if (error.code === 'not_batch_counted' || error.code === 'batch_not_counted') {
			return msg`Turn on batch counting for this made item before recording a batch.`
		}
		if (error.code === 'amount_out_of_range') {
			return msg`That amount is too small or too large. Check it and try again.`
		}
		if (error.code === 'feature_disabled') {
			return msg`Recipes are not turned on for your business.`
		}
	}
	return inventorySaveErrorMessage(error)
}

/** One owner-language sentence for a failed "Read the invoice". */
export function invoiceReadErrorMessage(error: unknown): MessageDescriptor {
	if (error instanceof OperatorRequestError) {
		if (error.code === 'reader_not_configured') {
			return msg`Reading invoice photos is not set up for your business.`
		}
		if (error.code === 'no_photo') {
			return msg`Add a photo of the invoice first.`
		}
		if (error.code === 'reader_failed') {
			return msg`The invoice could not be read. Try a clearer, straighter photo.`
		}
	}
	return inventorySaveErrorMessage(error)
}

/** True when this region cannot read invoice photos at all (the button then goes away). */
export function isInvoiceReaderMissing(error: unknown): boolean {
	return (
		error instanceof OperatorRequestError &&
		error.code === 'reader_not_configured'
	)
}
