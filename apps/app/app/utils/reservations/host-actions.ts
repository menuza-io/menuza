import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
	quickActionsFor,
	type QuickAction,
	type ReservationStatus,
} from '@repo/reservations'

/**
 * What a host can do to one party from the stand. The state machine
 * (`quickActionsFor`) decides what is allowed; this picks the ONE primary
 * action a card shows as a button and puts the rest in its menu.
 */

export type HostAction = {
	action: QuickAction
	/** Target status for a transition; `null` opens the detail sheet instead. */
	to: string | null
}

const TARGET_STATUS: Partial<Record<QuickAction, string>> = {
	confirm: 'confirmed',
	arrive: 'arrived',
	partially_seat: 'partially_seated',
	seat: 'seated',
	finish: 'finished',
	no_show: 'no_show',
	undo_seat: 'arrived',
	undo_finish: 'seated',
	undo_no_show: 'booked',
}

export const HOST_ACTION_LABELS: Record<QuickAction, MessageDescriptor> = {
	approve: msg`Approve`,
	decline: msg`Decline`,
	confirm: msg`Confirm`,
	arrive: msg`Arrived`,
	partially_seat: msg`Seat part of the party`,
	seat: msg`Seat`,
	finish: msg`Finish`,
	no_show: msg`Mark no-show`,
	cancel: msg`Cancel booking…`,
	undo_seat: msg`Undo seating`,
	undo_finish: msg`Reopen table`,
	undo_no_show: msg`Undo no-show`,
}

/** First allowed action wins; the order is "what a host does next" per status. */
const PRIMARY_BY_STATUS: Partial<Record<string, QuickAction>> = {
	booked: 'arrive',
	confirmed: 'arrive',
	partially_arrived: 'arrive',
	arrived: 'seat',
	partially_seated: 'seat',
	seated: 'finish',
	pending_payment: 'confirm',
}

function toHostAction(action: QuickAction): HostAction {
	return { action, to: TARGET_STATUS[action] ?? null }
}

export function hostActionsFor(
	status: string,
	context?: { nowMs?: number; finishedAtMs?: number | null },
): { primary: HostAction | null; secondary: HostAction[] } {
	const allowed = quickActionsFor(status as ReservationStatus, context)
	const wanted = PRIMARY_BY_STATUS[status]
	const primaryAction = wanted && allowed.includes(wanted) ? wanted : null
	const secondary = allowed
		// Requests are decided in the Requests tab, not on a board card.
		.filter((a) => a !== primaryAction && a !== 'approve' && a !== 'decline')
		.map(toHostAction)
	return {
		primary: primaryAction ? toHostAction(primaryAction) : null,
		secondary,
	}
}

/** Statuses where "running late" makes sense. */
export function canMarkRunningLate(status: string): boolean {
	return (
		status === 'booked' ||
		status === 'confirmed' ||
		status === 'partially_arrived' ||
		status === 'pending_payment'
	)
}

/** Which board column a party belongs in. */
export type BoardColumn = 'upcoming' | 'seated' | 'finished' | 'requests'

const FINISHED = new Set([
	'finished',
	'completed',
	'cancelled',
	'no_show',
	'declined',
	'expired',
])

export function boardColumnFor(status: string): BoardColumn {
	if (status === 'seated' || status === 'partially_seated') return 'seated'
	if (FINISHED.has(status)) return 'finished'
	if (status === 'requested' || status === 'pending_approval') return 'requests'
	return 'upcoming'
}
