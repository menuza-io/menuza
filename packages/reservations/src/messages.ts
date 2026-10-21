import { addDays } from '@repo/zoned-time'
import { instantToLocal, localToInstant } from './time.ts'

/**
 * Transactional message kinds, quiet-hours scheduling, dedupe keys, and
 * regional channel rules (`architecture.md` §9, `VAL-FND-008`, `VAL-MSG-016`).
 */
export const MESSAGE_KINDS = [
	'confirmation',
	'modification',
	'cancellation_guest',
	'cancellation_restaurant',
	'reminder',
	'reconfirm_request',
	'request_received',
	'request_approved',
	'request_declined',
	'waitlist_joined',
	'waitlist_ready',
	'notify_available',
	'payment_required',
	'payment_received',
	'refund_issued',
	'fee_charged',
	'fee_action_required',
	'late_payment_refunded',
] as const

export type CanonicalMessageKind = (typeof MESSAGE_KINDS)[number]
export type LegacyMessageKind =
	| 'reminder_24h'
	| 'reminder_2h'
	| 'cancelled'
	| 'modified'
	| 'payment_link'
	| 'payment_expired'
	| 'waitlist_table_ready'
	| 'notify_slot_opened'
	| 'post_visit_thank_you'
	| 'no_show_notice'

export type MessageKind = CanonicalMessageKind | LegacyMessageKind

export type MessageChannel = 'email' | 'sms'

export type QuietHoursConfig = {
	/** Default 21:00 (1260) */
	startMin?: number
	/** Default 08:00 (480) */
	endMin?: number
}

const PRE_ARRIVAL_REMINDER_KINDS: ReadonlySet<MessageKind> =
	new Set<MessageKind>([
		'reminder',
		'reminder_24h',
		'reminder_2h',
		'reconfirm_request',
	])

const NON_URGENT_SCHEDULED_KINDS: ReadonlySet<MessageKind> =
	new Set<MessageKind>([
		'reminder',
		'reminder_24h',
		'reminder_2h',
		'reconfirm_request',
		'post_visit_thank_you',
		'notify_available',
		'notify_slot_opened',
	])

export type ScheduleForInput = {
	kind: MessageKind
	startAtMs?: number
	finishedAtMs?: number
	nowMs: number
	timeZone: string
	quietHours?: QuietHoursConfig
	/** Optional reminder offset in minutes before `startAtMs` (default 1440 for `reminder`/`reminder_24h`, 120 for `reminder_2h`). */
	leadMin?: number
}

export type ScheduleForResult = {
	skip: boolean
	scheduledForMs: number | null
	shiftedForQuietHours: boolean
}

function isInsideQuietHours(
	clockMin: number,
	quietStartMin: number,
	quietEndMin: number,
): boolean {
	if (quietStartMin > quietEndMin) {
		// Crosses midnight (e.g. 21:00..08:00)
		return clockMin >= quietStartMin || clockMin < quietEndMin
	}
	return clockMin >= quietStartMin && clockMin < quietEndMin
}

/**
 * Compute when `kind` should be sent (`scheduledForMs`), applying quiet-hours
 * shifting (`21:00..08:00` local default) to non-urgent automated messages (`architecture.md` §9.4).
 *
 * Pre-arrival reminders (`reminder`, `reminder_24h`, `reminder_2h`, `reconfirm_request`)
 * whose target time falls inside quiet hours are moved **earlier** out of quiet hours
 * (to `quietStartMin`, default `21:00`), or skipped if that earlier send time is in the
 * past (`< nowMs`) or outside the reminder window.
 */
export function scheduleFor(input: ScheduleForInput): ScheduleForResult {
	const quietStartMin = input.quietHours?.startMin ?? 21 * 60 // 21:00
	const quietEndMin = input.quietHours?.endMin ?? 8 * 60 // 08:00

	let targetMs: number
	switch (input.kind) {
		case 'reminder':
		case 'reminder_24h':
		case 'reconfirm_request': {
			if (input.startAtMs === undefined) {
				return { skip: true, scheduledForMs: null, shiftedForQuietHours: false }
			}
			const leadMs = (input.leadMin ?? 24 * 60) * 60_000
			targetMs = input.startAtMs - leadMs
			// If booking was made less than leadMs before start:
			if (targetMs < input.nowMs) {
				// Only send if start is still at least 6h away
				if (input.startAtMs - input.nowMs < 6 * 3600_000) {
					return {
						skip: true,
						scheduledForMs: null,
						shiftedForQuietHours: false,
					}
				}
				targetMs = input.nowMs
			}
			break
		}
		case 'reminder_2h': {
			if (input.startAtMs === undefined) {
				return { skip: true, scheduledForMs: null, shiftedForQuietHours: false }
			}
			const leadMs = (input.leadMin ?? 2 * 60) * 60_000
			targetMs = input.startAtMs - leadMs
			if (targetMs < input.nowMs) {
				if (input.startAtMs - input.nowMs < 45 * 60_000) {
					return {
						skip: true,
						scheduledForMs: null,
						shiftedForQuietHours: false,
					}
				}
				targetMs = input.nowMs
			}
			break
		}
		case 'post_visit_thank_you': {
			const baseMs = input.finishedAtMs ?? input.nowMs
			const localBase = instantToLocal(baseMs, input.timeZone)
			const nextDay = addDays(localBase.calendarDate, 1)
			targetMs = localToInstant(nextDay, 10 * 60, input.timeZone).instantMs
			break
		}
		default:
			targetMs = input.nowMs
			break
	}

	if (!NON_URGENT_SCHEDULED_KINDS.has(input.kind)) {
		return {
			skip: false,
			scheduledForMs: targetMs,
			shiftedForQuietHours: false,
		}
	}

	const localTarget = instantToLocal(targetMs, input.timeZone)
	if (!isInsideQuietHours(localTarget.clockMin, quietStartMin, quietEndMin)) {
		return {
			skip: false,
			scheduledForMs: targetMs,
			shiftedForQuietHours: false,
		}
	}

	if (PRE_ARRIVAL_REMINDER_KINDS.has(input.kind)) {
		// Move pre-arrival reminders EARLIER to quietStartMin (default 21:00) before the quiet window
		const shiftCalendarDate =
			quietStartMin > quietEndMin && localTarget.clockMin < quietEndMin
				? addDays(localTarget.calendarDate, -1)
				: localTarget.calendarDate
		const shiftedMs = localToInstant(
			shiftCalendarDate,
			quietStartMin,
			input.timeZone,
		).instantMs

		// For a 2h reminder (`reminder_2h`), moving earlier into the previous evening (> 4h before start)
		// or before `nowMs` is outside the short-notice window -> skip
		const maxShiftBackMs =
			input.kind === 'reminder_2h' ? 2 * 3600_000 : 18 * 3600_000
		if (shiftedMs < input.nowMs || targetMs - shiftedMs > maxShiftBackMs) {
			return {
				skip: true,
				scheduledForMs: null,
				shiftedForQuietHours: true,
			}
		}

		if (
			input.startAtMs !== undefined &&
			shiftedMs > input.startAtMs - 60 * 60_000
		) {
			return {
				skip: true,
				scheduledForMs: null,
				shiftedForQuietHours: true,
			}
		}

		return {
			skip: false,
			scheduledForMs: shiftedMs,
			shiftedForQuietHours: true,
		}
	}

	// Post-visit or notify-available inside quiet hours: shift to quietEndMin (08:00 local)
	const shiftCalendarDate =
		quietStartMin > quietEndMin && localTarget.clockMin >= quietStartMin
			? addDays(localTarget.calendarDate, 1)
			: localTarget.calendarDate
	const shiftedMs = localToInstant(
		shiftCalendarDate,
		quietEndMin,
		input.timeZone,
	).instantMs

	return {
		skip: false,
		scheduledForMs: shiftedMs,
		shiftedForQuietHours: true,
	}
}

export type DedupeKeyInput = {
	reservationId?: string | null
	waitlistId?: string | null
	notifyRequestId?: string | null
	kind: MessageKind
	channel: MessageChannel
	startAtMs?: number | null
	milestone?: string | number | null
}

/**
 * Deterministic idempotency key for `reservation_message_log.dedupe_key`.
 * Including `startAtMs` allows rescheduled bookings to receive fresh reminders.
 */
export function dedupeKey(input: DedupeKeyInput): string {
	const subject = input.reservationId
		? `res:${input.reservationId}`
		: input.waitlistId
			? `wl:${input.waitlistId}`
			: input.notifyRequestId
				? `notify:${input.notifyRequestId}`
				: 'anon'
	const suffix =
		input.milestone !== undefined && input.milestone !== null
			? String(input.milestone)
			: input.startAtMs !== undefined && input.startAtMs !== null
				? String(input.startAtMs)
				: '0'
	return `${subject}:${input.kind}:${input.channel}:${suffix}`
}

export type ChannelsForInput = {
	dataRegion: 'us' | 'ksa'
	smsOptIn?: boolean | number | null
	emailProvided?: boolean | null
	kind?: MessageKind
}

/**
 * Determine delivery channels for a guest notification (`architecture.md` §9.1):
 *  - `'email'` when `emailProvided` is truthy
 *  - `'sms'` ONLY when `dataRegion === 'us'` AND `smsOptIn` is truthy (never in `'ksa'`)
 */
export function channelsFor(input: ChannelsForInput): MessageChannel[] {
	const channels: MessageChannel[] = []
	if (input.emailProvided ?? true) {
		channels.push('email')
	}
	const optedIn = input.smsOptIn === true || input.smsOptIn === 1
	if (input.dataRegion === 'us' && optedIn) {
		channels.push('sms')
	}
	return channels
}
