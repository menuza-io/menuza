import { addDays } from '@repo/zoned-time'
import { instantToLocal, localToInstant } from './time.ts'

/**
 * Transactional message kinds, quiet-hours scheduling, dedupe keys, and
 * regional channel rules (`architecture.md` §9, `VAL-FND-008`).
 */
export const MESSAGE_KINDS = [
	'confirmation',
	'reminder_24h',
	'reminder_2h',
	'reconfirm_request',
	'cancelled',
	'modified',
	'request_received',
	'request_approved',
	'request_declined',
	'payment_link',
	'payment_expired',
	'waitlist_joined',
	'waitlist_table_ready',
	'notify_slot_opened',
	'post_visit_thank_you',
	'no_show_notice',
] as const

export type MessageKind = (typeof MESSAGE_KINDS)[number]

export type MessageChannel = 'email' | 'sms'

export type QuietHoursConfig = {
	/** Default 22:00 (1320) */
	startMin?: number
	/** Default 08:00 (480) */
	endMin?: number
}

const NON_URGENT_SCHEDULED_KINDS: ReadonlySet<MessageKind> = new Set([
	'reminder_24h',
	'reminder_2h',
	'reconfirm_request',
	'post_visit_thank_you',
	'notify_slot_opened',
])

export type ScheduleForInput = {
	kind: MessageKind
	startAtMs?: number
	finishedAtMs?: number
	nowMs: number
	timeZone: string
	quietHours?: QuietHoursConfig
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
		// Crosses midnight (e.g. 22:00..08:00)
		return clockMin >= quietStartMin || clockMin < quietEndMin
	}
	return clockMin >= quietStartMin && clockMin < quietEndMin
}

/**
 * Compute when `kind` should be sent (`scheduledForMs`), applying quiet-hours
 * shifting (`22:00..08:00` local) to non-urgent automated messages.
 */
export function scheduleFor(input: ScheduleForInput): ScheduleForResult {
	const quietStartMin = input.quietHours?.startMin ?? 22 * 60 // 22:00
	const quietEndMin = input.quietHours?.endMin ?? 8 * 60 // 08:00

	let targetMs: number
	switch (input.kind) {
		case 'reminder_24h':
		case 'reconfirm_request': {
			if (input.startAtMs === undefined) {
				return { skip: true, scheduledForMs: null, shiftedForQuietHours: false }
			}
			targetMs = input.startAtMs - 24 * 3600_000
			// If booking was made less than 24h before start:
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
			targetMs = input.startAtMs - 2 * 3600_000
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

	// Shift to the next quietEndMin (08:00 local)
	const shiftCalendarDate =
		localTarget.clockMin >= quietStartMin
			? addDays(localTarget.calendarDate, 1)
			: localTarget.calendarDate
	const shiftedMs = localToInstant(
		shiftCalendarDate,
		quietEndMin,
		input.timeZone,
	).instantMs

	// If this is a pre-arrival reminder, ensure shifted time is still at least 60 minutes before startAtMs
	if (
		input.startAtMs !== undefined &&
		(input.kind === 'reminder_24h' ||
			input.kind === 'reminder_2h' ||
			input.kind === 'reconfirm_request')
	) {
		const minLeadMs = 60 * 60_000
		if (shiftedMs > input.startAtMs - minLeadMs) {
			return {
				skip: true,
				scheduledForMs: null,
				shiftedForQuietHours: true,
			}
		}
	}

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
