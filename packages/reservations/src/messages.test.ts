import { describe, expect, it } from 'vitest'
import {
	MESSAGE_KINDS,
	channelsFor,
	dedupeKey,
	scheduleFor,
} from './messages.ts'
import { instantToLocal, localToInstant } from './time.ts'

describe('message schedule, quiet hours, dedupe keys, and regional channels', () => {
	const timeZone = 'America/New_York'
	const nowMs = localToInstant('2026-06-10', 12 * 60, timeZone).instantMs

	it('defines all 16 message kinds', () => {
		expect(MESSAGE_KINDS).toHaveLength(16)
		expect(MESSAGE_KINDS).toContain('confirmation')
		expect(MESSAGE_KINDS).toContain('reminder_24h')
		expect(MESSAGE_KINDS).toContain('reminder_2h')
		expect(MESSAGE_KINDS).toContain('waitlist_table_ready')
		expect(MESSAGE_KINDS).toContain('post_visit_thank_you')
	})

	it('shifts non-urgent reminders out of quiet hours (22:00..08:00) and skips late reminders that fall inside quiet hours too close to start', () => {
		// Reservation at 23:00 on 2026-06-12 -> 24h before is 23:00 on 2026-06-11 (inside 22:00..08:00 quiet hours)
		// Should shift to 08:00 on 2026-06-12 (which is still 15h before the 23:00 reservation)
		const startLate = localToInstant('2026-06-12', 23 * 60, timeZone).instantMs
		const sched24h = scheduleFor({
			kind: 'reminder_24h',
			startAtMs: startLate,
			nowMs,
			timeZone,
		})
		expect(sched24h.skip).toBe(false)
		expect(sched24h.shiftedForQuietHours).toBe(true)
		const localScheduled = instantToLocal(sched24h.scheduledForMs!, timeZone)
		expect(localScheduled.calendarDate).toBe('2026-06-12')
		expect(localScheduled.clockMin).toBe(8 * 60)

		// Reservation at 08:30 on 2026-06-12 -> 2h before is 06:30 (inside 22:00..08:00 quiet hours)
		// Shifting to 08:00 leaves only 30m (< 60m minimum lead) -> reminder_2h is skipped
		const startEarlyMorning = localToInstant(
			'2026-06-12',
			8 * 60 + 30,
			timeZone,
		).instantMs
		const sched2h = scheduleFor({
			kind: 'reminder_2h',
			startAtMs: startEarlyMorning,
			nowMs,
			timeZone,
		})
		expect(sched2h.skip).toBe(true)
	})

	it('builds deterministic dedupe keys and restricts SMS to US with guest opt-in', () => {
		const k1 = dedupeKey({
			reservationId: 'res_123',
			kind: 'reminder_24h',
			channel: 'email',
			startAtMs: 1_700_000_000_000,
		})
		const k2 = dedupeKey({
			reservationId: 'res_123',
			kind: 'reminder_24h',
			channel: 'email',
			startAtMs: 1_700_000_000_000,
		})
		const kRescheduled = dedupeKey({
			reservationId: 'res_123',
			kind: 'reminder_24h',
			channel: 'email',
			startAtMs: 1_700_003_600_000,
		})
		expect(k1).toBe(k2)
		expect(k1).not.toBe(kRescheduled)

		// US with SMS opt-in and email -> ['email', 'sms']
		expect(
			channelsFor({
				dataRegion: 'us',
				smsOptIn: true,
				emailProvided: true,
				kind: 'confirmation',
			}),
		).toEqual(['email', 'sms'])

		// US without SMS opt-in -> ['email']
		expect(
			channelsFor({
				dataRegion: 'us',
				smsOptIn: false,
				emailProvided: true,
				kind: 'confirmation',
			}),
		).toEqual(['email'])

		// KSA even with smsOptIn=true -> ['email'] (never SMS in KSA)
		expect(
			channelsFor({
				dataRegion: 'ksa',
				smsOptIn: true,
				emailProvided: true,
				kind: 'confirmation',
			}),
		).toEqual(['email'])
	})
})
