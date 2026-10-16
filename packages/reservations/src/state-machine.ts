import { type ReservationsErrorCode } from './errors.ts'

/**
 * Reservation lifecycle state machine (`architecture.md` §7, `VAL-FND-008`).
 */
export const RESERVATION_STATUSES = [
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
	'arrived',
	'partially_seated',
	'seated',
	'finished',
	'cancelled',
	'no_show',
	'declined',
	'expired',
	'disputed',
] as const

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]

export const RESERVATION_ACTORS = [
	'guest',
	'operator',
	'system',
	'voice',
] as const

export type ReservationActor = (typeof RESERVATION_ACTORS)[number]

/** Operator undo `finished -> seated` is allowed within 30 minutes of `finished_at`. */
export const FINISHED_UNDO_WINDOW_MS = 30 * 60_000

const CAPACITY_CONSUMING_STATUSES: ReadonlySet<ReservationStatus> =
	new Set<ReservationStatus>([
		'booked',
		'confirmed',
		'arrived',
		'partially_seated',
		'seated',
	])

/**
 * Return `true` iff `status` occupies table capacity (Invariant I2).
 */
export function consumesCapacity(status: ReservationStatus): boolean {
	return CAPACITY_CONSUMING_STATUSES.has(status)
}

const GUEST_TRANSITIONS: Readonly<
	Partial<Record<ReservationStatus, readonly ReservationStatus[]>>
> = {
	pending_payment: ['cancelled'],
	pending_approval: ['cancelled'],
	booked: ['confirmed', 'cancelled'],
	confirmed: ['cancelled'],
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
	pending_payment: ['booked', 'expired', 'cancelled', 'disputed'],
	pending_approval: ['expired', 'cancelled', 'disputed'],
	booked: ['confirmed', 'no_show', 'cancelled', 'disputed'],
	confirmed: ['no_show', 'cancelled', 'disputed'],
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
	pending_payment: ['booked', 'confirmed', 'cancelled', 'expired'],
	pending_approval: ['booked', 'confirmed', 'declined', 'cancelled'],
	booked: [
		'confirmed',
		'arrived',
		'partially_seated',
		'seated',
		'no_show',
		'cancelled',
	],
	confirmed: [
		'booked',
		'arrived',
		'partially_seated',
		'seated',
		'no_show',
		'cancelled',
	],
	arrived: [
		'booked',
		'confirmed',
		'partially_seated',
		'seated',
		'no_show',
		'cancelled',
	],
	partially_seated: [
		'arrived',
		'confirmed',
		'booked',
		'seated',
		'finished',
		'cancelled',
	],
	seated: ['arrived', 'confirmed', 'booked', 'partially_seated', 'finished'],
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

	const wasConsuming = consumesCapacity(input.from)
	const nowConsuming = consumesCapacity(input.to)

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
