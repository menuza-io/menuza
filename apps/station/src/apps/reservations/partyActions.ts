import {
	quickActionsFor,
	TILL_NO_SHOW_GRACE_MS,
	type QuickAction,
} from '@repo/reservations'
import { coversHere } from './arrival.ts'
import { UNDO_WINDOW_MS, type DayReservation, type TableKind } from './feed.ts'
import { canExtendStay } from './stay.ts'

/**
 * What a till may do to one booking right now, in the order the sheet offers
 * it: the next step, changing the booking, ending it. Pure, so every rule (the
 * no-show grace, the undo window, a payment, another day, someone else's
 * change) is tested apart from the sheet that draws the buttons.
 */

export type PartyActionsInput = {
	r: Pick<
		DayReservation,
		| 'status'
		| 'startAt'
		| 'seatedAt'
		| 'finishedAt'
		| 'canUndo'
		| 'tableIds'
		| 'tableLabels'
		| 'paymentStatus'
		| 'durationMin'
		| 'startAt'
		| 'endAt'
		| 'experienceId'
		| 'partySize'
		| 'arrivedCovers'
		| 'seatedCovers'
	>
	now: number
	/** Another day: no arrival, seating or no-shows (the server refuses those off today). */
	viewOnly: boolean
	/**
	 * What the table they are booked at is doing right now (null: not known, or
	 * several tables). One tap seats them there only while that table is free.
	 */
	seatTableKind?: TableKind | null
}

/** Statuses where a booking is live: it holds a table or will. */
const LIVE_STATUSES = new Set(['booked', 'confirmed', 'arrived', 'seated'])

/**
 * A booking with a deposit, a card held on it, or any refund state: the server
 * refuses a size or time change, a cancel and a no-show from a till
 * (`manager_required`). Anything but `none` counts, so `refund_pending`,
 * `refunded` or `fee_pending` lock it too, whatever `depositState` makes of them.
 */
export const hasPayment = (r: Pick<DayReservation, 'paymentStatus'>) =>
	r.paymentStatus !== 'none'

/**
 * Money is on the booking as far as the server's lock for a till is concerned:
 * a payment or a card on it, or a booked experience. A policy amount without
 * either is not in the day feed: the server refuses that one itself
 * (`manager_required`, said as such), so the stand cannot hide the button for it.
 */
export const hasMoneyOn = (
	r: Pick<DayReservation, 'paymentStatus' | 'experienceId'>,
) => hasPayment(r) || Boolean(r.experienceId)

export type UndoKind = 'seat' | 'finish' | 'no_show'

export type PartyActions = {
	/** Choose a table for them (they are expected or at the stand). */
	canSeat: boolean
	canFinish: boolean
	/** Mark them here, when they are not at the stand yet. */
	canArrive: boolean
	canConfirm: boolean
	canChange: boolean
	/**
	 * What changing it means: size and time for a booking still to come, the
	 * party size alone for a party already seated ("we're six now").
	 */
	changeKind: 'size_time' | 'size'
	/** Move a seated party to another table. */
	canMove: boolean
	/** Add 15 minutes to a seated party's stay. */
	canExtend: boolean
	/**
	 * Some of a party of two or more are here: mark how many at the door
	 * (a booking not marked here yet). The server keeps the count as
	 * `arrivedCovers` on an arrived booking and cannot raise it afterwards.
	 */
	canPartlyHere: boolean
	/**
	 * A party only partly here (arrived, short of its size): seat as many as are
	 * here now, with a stepper for how many. It replaces the plain seating, which
	 * is for a party that is all here.
	 */
	canSeatPart: boolean
	/** Put right the last step: which one, or null. */
	undo: UndoKind | null
	/** A no-show: only once the grace after the booked time has passed. */
	canNoShow: boolean
	canCancel: boolean
	/** Waiting on a deposit: a manager's call in the app, not the till's. */
	awaitingPayment: boolean
	/**
	 * It has a deposit or a card on it: changing it, cancelling it and a no-show
	 * are a manager's (the sheet says so instead of offering them).
	 */
	managerHandles: boolean
	/**
	 * The table they are booked at, when they are at the stand and seating
	 * them there is one tap: "Seat at Table 3" leads, "Other table" follows.
	 */
	seatAt: { label: string; tableId: string } | null
	/** The party has ended (finished, no-show, cancelled): book them again. */
	canBookAgain: boolean
	/** Whether any button shows at all. */
	any: boolean
}

export function partyActions({
	r,
	now,
	viewOnly,
	seatTableKind = null,
}: PartyActionsInput): PartyActions {
	const actions = quickActionsFor(r.status as never, {
		nowMs: now,
		finishedAtMs: r.finishedAt ?? null,
	})
	const awaitingPayment = r.status === 'pending_payment'
	const paid = hasPayment(r)
	// Money is a manager's: awaiting a deposit has its own line, so it is not said twice.
	const managerHandles = paid && !awaitingPayment && LIVE_STATUSES.has(r.status)
	// The server says when the till may not undo this one (someone else's change).
	const notYours = r.canUndo === false
	const has = (action: QuickAction) =>
		actions.includes(action) &&
		!(viewOnly && action !== 'confirm' && action !== 'cancel') &&
		// Confirming would waive the deposit and cancelling touches the payment.
		!(awaitingPayment && (action === 'confirm' || action === 'cancel')) &&
		// Cancelling and calling a no-show touch the payment: a manager's.
		!(paid && (action === 'cancel' || action === 'no_show')) &&
		!(notYours && (action === 'undo_finish' || action === 'undo_no_show')) &&
		// A till undoes seating only within the window (the server refuses later).
		!(
			action === 'undo_seat' &&
			r.seatedAt != null &&
			now - r.seatedAt > UNDO_WINDOW_MS
		)
	const manyInParty = r.partySize >= 2
	// Short of its size at the door: "Seat 3 now" (a stepper) takes the place of a plain seating.
	const partlyHere = coversHere(r)?.stage === 'door'
	const canSeatPart =
		manyInParty && partlyHere && r.status === 'arrived' && has('seat')
	const canSeat = has('seat') && !canSeatPart
	const canPartlyHere =
		manyInParty &&
		!viewOnly &&
		(r.status === 'booked' || r.status === 'confirmed') &&
		has('arrive')
	const atStand = r.status === 'arrived'
	const undo: UndoKind | null = has('undo_finish')
		? 'finish'
		: has('undo_no_show')
			? 'no_show'
			: has('undo_seat')
				? 'seat'
				: null
	const canFinish = has('finish')
	const canArrive = has('arrive') && r.status !== 'arrived'
	const canConfirm = has('confirm')
	const seated = r.status === 'seated' && !viewOnly
	// Size and time of a booking to come; the size alone once they are seated
	// (more people at the table). Never with money on it: the server refuses.
	const money = hasMoneyOn(r)
	const canChange =
		!money &&
		(r.status === 'booked' ||
			r.status === 'confirmed' ||
			r.status === 'arrived' ||
			seated)
	const canMove = seated
	// Lengthening a stay is a change the server locks behind the same money
	// rule as a size or time change, and it only grows up to what a till may set.
	const canExtend = seated && !money && canExtendStay(r, now)
	const canNoShow = has('no_show') && now >= r.startAt + TILL_NO_SHOW_GRACE_MS
	const canCancel = has('cancel')
	const label = r.tableLabels[0]
	const tableId = r.tableIds[0]
	// A table that is taken, taped off or being reset is not one tap away.
	const tableReady =
		seatTableKind === null ||
		seatTableKind === 'open' ||
		seatTableKind === 'soon'
	const seatAt =
		canSeat &&
		atStand &&
		tableReady &&
		r.tableIds.length === 1 &&
		label !== undefined &&
		tableId !== undefined
			? { label, tableId }
			: null
	const canBookAgain =
		r.status === 'finished' ||
		r.status === 'no_show' ||
		r.status === 'cancelled'
	return {
		canSeat,
		canSeatPart,
		canPartlyHere,
		canFinish,
		canArrive,
		canConfirm,
		canChange,
		changeKind: seated ? 'size' : 'size_time',
		canMove,
		canExtend,
		undo,
		canNoShow,
		canCancel,
		awaitingPayment,
		managerHandles,
		seatAt,
		canBookAgain,
		any:
			canSeat ||
			canSeatPart ||
			canPartlyHere ||
			canFinish ||
			canArrive ||
			canConfirm ||
			canChange ||
			canMove ||
			canExtend ||
			managerHandles ||
			undo !== null ||
			canNoShow ||
			canCancel ||
			canBookAgain,
	}
}

/** An armed cancel or no-show, with the booking as the host saw it. */
export type Armed = {
	to: 'cancelled' | 'no_show'
	version: number
	status: string
}

/**
 * Whether an armed cancel or no-show still holds: the booking is the one and
 * only as the host saw it. If another host changed it meanwhile (marked them
 * arrived), the decision was about something that is no longer true: it disarms.
 */
export const armedStillHolds = (
	armed: Armed,
	r: Pick<DayReservation, 'version' | 'status'> | null,
) => r !== null && r.version === armed.version && r.status === armed.status

/** An armed step disarms by itself after this long. */
export const ARMED_FOR_MS = 8000
