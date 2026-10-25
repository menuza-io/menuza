import { type ReservationsErrorCode } from './errors.ts'

/**
 * Reservation lifecycle state machine (`architecture.md` §6.4 / §7, `VAL-FND-008`).
 */
export const RESERVATION_STATUSES = [
	'requested',
	'pending_payment',
	'booked',
	'confirmed',
	'partially_arrived',
	'arrived',
	'partially_seated',
	'seated',
	'finished',
	'cancelled',
	'no_show',
	'declined',
	'expired',
] as const

export type CanonicalReservationStatus = (typeof RESERVATION_STATUSES)[number]
export type LegacyReservationStatus = 'pending_approval' | 'disputed'
export type ReservationStatus =
	CanonicalReservationStatus | LegacyReservationStatus

export const RESERVATION_ACTORS = [
	'guest',
	'operator',
	'system',
	'voice',
] as const

export type ReservationActor = (typeof RESERVATION_ACTORS)[number]

/** Operator undo `finished -> seated` is allowed within 30 minutes of `finished_at`. */
export const FINISHED_UNDO_WINDOW_MS = 30 * 60_000

/**
 * A till (the Station host stand) calls a booking a no-show only this long
 * after its time: a mis-tap cannot mark tonight's guest.
 */
export const TILL_NO_SHOW_GRACE_MS = 15 * 60_000

/**
 * How long a till can still put right a no-show or a cleared table: its own
 * person's change, or the system's (an automatic no-show), never someone else's.
 */
export const TILL_UNDO_WINDOW_MS = 30 * 60_000

const CAPACITY_CONSUMING_STATUSES: ReadonlySet<ReservationStatus> =
	new Set<ReservationStatus>([
		'pending_payment',
		'booked',
		'confirmed',
		'partially_arrived',
		'arrived',
		'partially_seated',
		'seated',
	])

export type ConsumesCapacityOptions = {
	requestHoldsCapacity?: boolean
	paymentExpiresAtMs?: number | null
	nowMs?: number
}

/**
 * Return `true` iff `status` occupies table capacity (Invariant I2, `architecture.md` §6.4).
 */
export function consumesCapacity(
	status: ReservationStatus,
	opts?: ConsumesCapacityOptions,
): boolean {
	if (status === 'requested' || status === 'pending_approval') {
		return opts?.requestHoldsCapacity === true
	}
	if (status === 'pending_payment') {
		if (
			opts?.paymentExpiresAtMs !== undefined &&
			opts.paymentExpiresAtMs !== null &&
			opts.nowMs !== undefined &&
			opts.paymentExpiresAtMs <= opts.nowMs
		) {
			return false
		}
		return true
	}
	return CAPACITY_CONSUMING_STATUSES.has(status)
}

const GUEST_TRANSITIONS: Readonly<
	Partial<Record<ReservationStatus, readonly ReservationStatus[]>>
> = {
	requested: ['cancelled'],
	pending_payment: ['cancelled'],
	pending_approval: ['cancelled'],
	booked: ['confirmed', 'cancelled'],
	confirmed: ['cancelled'],
	partially_arrived: ['cancelled'],
	arrived: ['cancelled'],
}

const VOICE_TRANSITIONS: Readonly<
	Partial<Record<ReservationStatus, readonly ReservationStatus[]>>
> = {
	booked: ['confirmed', 'cancelled'],
	confirmed: ['cancelled'],
}

const SYSTEM_TRANSITIONS: Readonly<
	Partial<Record<ReservationStatus, readonly ReservationStatus[]>>
> = {
	requested: ['expired', 'cancelled', 'disputed'],
	pending_payment: ['booked', 'expired', 'cancelled', 'disputed'],
	pending_approval: ['expired', 'cancelled', 'disputed'],
	booked: ['confirmed', 'no_show', 'cancelled', 'disputed'],
	confirmed: ['no_show', 'cancelled', 'disputed'],
	partially_arrived: ['disputed'],
	arrived: ['disputed'],
	partially_seated: ['disputed'],
	seated: ['finished', 'disputed'],
	finished: ['disputed'],
	cancelled: ['disputed'],
	no_show: ['disputed'],
	declined: ['disputed'],
	expired: ['disputed'],
}

const OPERATOR_TRANSITIONS: Readonly<
	Partial<Record<ReservationStatus, readonly ReservationStatus[]>>
> = {
	requested: ['booked', 'confirmed', 'declined', 'cancelled'],
	pending_payment: ['booked', 'confirmed', 'cancelled', 'expired'],
	pending_approval: ['booked', 'confirmed', 'declined', 'cancelled'],
	booked: [
		'confirmed',
		'partially_arrived',
		'arrived',
		'partially_seated',
		'seated',
		'no_show',
		'cancelled',
	],
	confirmed: [
		'booked',
		'partially_arrived',
		'arrived',
		'partially_seated',
		'seated',
		'no_show',
		'cancelled',
	],
	partially_arrived: [
		'booked',
		'confirmed',
		'arrived',
		'partially_seated',
		'seated',
		'no_show',
		'cancelled',
	],
	arrived: [
		'booked',
		'confirmed',
		'partially_arrived',
		'partially_seated',
		'seated',
		'no_show',
		'cancelled',
	],
	partially_seated: [
		'partially_arrived',
		'arrived',
		'confirmed',
		'booked',
		'seated',
		'finished',
		'cancelled',
	],
	seated: [
		'partially_arrived',
		'arrived',
		'confirmed',
		'booked',
		'partially_seated',
		'finished',
	],
	finished: ['seated'],
	no_show: ['booked', 'confirmed', 'arrived', 'seated', 'cancelled'],
	cancelled: ['booked', 'confirmed'],
	declined: ['booked'],
}

export type TransitionContext = {
	nowMs?: number
	finishedAtMs?: number | null
}

export function canTransition(
	from: ReservationStatus,
	to: ReservationStatus,
	actor: ReservationActor,
	context?: TransitionContext,
): boolean {
	if (from === to) return false

	let table: Readonly<
		Partial<Record<ReservationStatus, readonly ReservationStatus[]>>
	>
	switch (actor) {
		case 'guest':
			table = GUEST_TRANSITIONS
			break
		case 'voice':
			table = VOICE_TRANSITIONS
			break
		case 'system':
			table = SYSTEM_TRANSITIONS
			break
		case 'operator':
			table = OPERATOR_TRANSITIONS
			break
	}

	const allowed = table[from]
	if (!allowed || !allowed.includes(to)) {
		return false
	}

	// Enforce 30-minute undo window on finished -> seated
	if (from === 'finished' && to === 'seated') {
		if (
			context?.nowMs !== undefined &&
			context.finishedAtMs !== undefined &&
			context.finishedAtMs !== null
		) {
			if (context.nowMs - context.finishedAtMs > FINISHED_UNDO_WINDOW_MS) {
				return false
			}
		}
	}

	return true
}

export type TransitionResult =
	| {
			ok: true
			from: ReservationStatus
			to: ReservationStatus
			actor: ReservationActor
			consumesCapacity: boolean
			releasedCapacity: boolean
			restoredCapacity: boolean
	  }
	| {
			ok: false
			code: ReservationsErrorCode
			from: ReservationStatus
			to: ReservationStatus
			actor: ReservationActor
	  }

export function transitionReservation(input: {
	from: ReservationStatus
	to: ReservationStatus
	actor: ReservationActor
	nowMs?: number
	finishedAtMs?: number | null
	/** Capacity options (e.g. `requestHoldsCapacity`) applied to both sides. */
	capacity?: Omit<ConsumesCapacityOptions, 'nowMs'>
}): TransitionResult {
	const allowed = canTransition(input.from, input.to, input.actor, {
		nowMs: input.nowMs,
		finishedAtMs: input.finishedAtMs,
	})
	if (!allowed) {
		return {
			ok: false,
			code: 'invalid_transition',
			from: input.from,
			to: input.to,
			actor: input.actor,
		}
	}

	const capacityOpts: ConsumesCapacityOptions = {
		...input.capacity,
		nowMs: input.nowMs,
	}
	const wasConsuming = consumesCapacity(input.from, capacityOpts)
	const nowConsuming = consumesCapacity(input.to, capacityOpts)

	return {
		ok: true,
		from: input.from,
		to: input.to,
		actor: input.actor,
		consumesCapacity: nowConsuming,
		releasedCapacity: wasConsuming && !nowConsuming,
		restoredCapacity: !wasConsuming && nowConsuming,
	}
}

export type QuickAction =
	| 'approve'
	| 'decline'
	| 'confirm'
	| 'arrive'
	| 'partially_seat'
	| 'seat'
	| 'finish'
	| 'no_show'
	| 'cancel'
	| 'undo_seat'
	| 'undo_finish'
	| 'undo_no_show'

/**
 * Return the ordered operator quick actions available for `status` (`architecture.md` §7.2).
 */
export function quickActionsFor(
	status: ReservationStatus,
	context?: TransitionContext,
): QuickAction[] {
	switch (status) {
		case 'requested':
		case 'pending_approval':
			return ['approve', 'decline', 'cancel']
		case 'pending_payment':
			return ['confirm', 'cancel']
		case 'booked':
			return [
				'confirm',
				'arrive',
				'partially_seat',
				'seat',
				'no_show',
				'cancel',
			]
		case 'confirmed':
			return ['arrive', 'partially_seat', 'seat', 'no_show', 'cancel']
		case 'partially_arrived':
			return ['arrive', 'partially_seat', 'seat', 'no_show', 'cancel']
		case 'arrived':
			return ['partially_seat', 'seat', 'no_show', 'cancel']
		case 'partially_seated':
			return ['seat', 'finish', 'undo_seat', 'cancel']
		case 'seated':
			return ['finish', 'undo_seat']
		case 'finished': {
			if (
				context?.nowMs !== undefined &&
				context.finishedAtMs !== undefined &&
				context.finishedAtMs !== null &&
				context.nowMs - context.finishedAtMs > FINISHED_UNDO_WINDOW_MS
			) {
				return []
			}
			return ['undo_finish']
		}
		case 'no_show':
			return ['undo_no_show']
		default:
			return []
	}
}
