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
		if (error.code === 'unit_in_use') {
			return msg`This unit is already used by stock, so it cannot be changed.`
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
