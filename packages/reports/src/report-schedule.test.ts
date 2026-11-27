import { describe, expect, it } from 'vitest'
import {
	dueRunKey,
	nextRetryAt,
	reportScheduleInputSchema,
	signReportUnsubscribeToken,
	verifyReportUnsubscribeToken,
	type ScheduleTiming,
} from './report-schedule.ts'

const SECRET = 'unit-test-secret-for-report-unsubscribe-0123456789'
const created = new Date('2026-11-01T00:00:00Z')
const daily = (over: Partial<ScheduleTiming> = {}): ScheduleTiming => ({
	cadence: 'daily',
	weekday: null,
	hour: 8,
	timeZone: 'America/Chicago',
	createdAt: created,
	...over,
})

describe('report schedule timing (#121)', () => {
	it('sends at the chosen hour in the schedule\'s own zone, once per local day', () => {
		// 08:00 Chicago = 14:00Z in November (CST, UTC-6).
		expect(dueRunKey(daily(), new Date('2026-11-27T13:00:00Z'))).toBeNull()
		expect(dueRunKey(daily(), new Date('2026-11-27T14:00:00Z'))).toBe('2026-11-27')
		expect(dueRunKey(daily(), new Date('2026-11-27T14:45:00Z'))).toBe('2026-11-27')
		// The same key all morning: the caller sends once per key.
		expect(dueRunKey(daily(), new Date('2026-11-27T15:10:00Z'))).toBe('2026-11-27')
	})

	it('catches up a missed tick within a few hours, then skips the day', () => {
		expect(dueRunKey(daily(), new Date('2026-11-27T18:30:00Z'))).toBe('2026-11-27')
		expect(dueRunKey(daily(), new Date('2026-11-27T21:00:00Z'))).toBeNull()
	})

	it('does not run before the schedule existed', () => {
		const t = daily({ createdAt: new Date('2026-11-27T21:00:00Z') }) // 15:00 local
		expect(dueRunKey(t, new Date('2026-11-27T21:05:00Z'))).toBeNull()
		expect(dueRunKey(t, new Date('2026-11-28T14:00:00Z'))).toBe('2026-11-28')
	})

	it('weekly runs on the chosen weekday, monthly on the 1st', () => {
		const weekly = daily({ cadence: 'weekly', weekday: 1 }) // Monday
		expect(dueRunKey(weekly, new Date('2026-11-30T14:00:00Z'))).toBe('2026-11-30')
		expect(dueRunKey(weekly, new Date('2026-12-01T14:00:00Z'))).toBeNull()
		const monthly = daily({ cadence: 'monthly' })
		expect(dueRunKey(monthly, new Date('2026-12-01T14:00:00Z'))).toBe('2026-12-01')
		expect(dueRunKey(monthly, new Date('2026-12-02T14:00:00Z'))).toBeNull()
	})

	it('uses the zone\'s date, not UTC\'s (Riyadh is ahead)', () => {
		const t = daily({ timeZone: 'Asia/Riyadh', hour: 7 })
		// 07:00 Riyadh Nov 28 = 04:00Z Nov 28
		expect(dueRunKey(t, new Date('2026-11-28T04:00:00Z'))).toBe('2026-11-28')
		expect(dueRunKey(t, new Date('2026-11-27T21:30:00Z'))).toBeNull()
	})

	it('survives a daylight-saving change', () => {
		const t = daily({ hour: 8, createdAt: new Date('2026-03-01T00:00:00Z') })
		// US DST starts 2026-03-08: 08:00 CDT = 13:00Z.
		expect(dueRunKey(t, new Date('2026-03-08T13:00:00Z'))).toBe('2026-03-08')
		expect(dueRunKey(t, new Date('2026-03-07T14:00:00Z'))).toBe('2026-03-07')
	})

	it('retries twice with backoff, then gives up', () => {
		const now = new Date('2026-11-27T14:00:00Z')
		expect(nextRetryAt(0, now)!.getTime() - now.getTime()).toBe(30 * 60_000)
		expect(nextRetryAt(1, now)!.getTime() - now.getTime()).toBe(2 * 3_600_000)
		expect(nextRetryAt(2, now)).toBeNull()
	})

	it('validates a schedule input', () => {
		const ok = reportScheduleInputSchema.safeParse({
			cadence: 'weekly',
			weekday: 2,
			hour: 7,
			timeZone: 'Asia/Riyadh',
		})
		expect(ok.success).toBe(true)
		for (const bad of [
			{ cadence: 'weekly', weekday: null, hour: 7, timeZone: 'UTC' },
			{ cadence: 'daily', hour: 24, timeZone: 'UTC' },
			{ cadence: 'daily', hour: 7, timeZone: 'Mars/Base' },
			{ cadence: 'hourly', hour: 7, timeZone: 'UTC' },
		]) {
			expect(reportScheduleInputSchema.safeParse(bad).success).toBe(false)
		}
	})
})

describe('report unsubscribe tokens (#121)', () => {
	it('round-trips and names one recipient', () => {
		const token = signReportUnsubscribeToken(
			{ kind: 'schedule', scheduleId: 'sch_1', userId: 'usr_1' },
			SECRET,
		)
		expect(verifyReportUnsubscribeToken(token, SECRET)).toEqual({
			kind: 'schedule',
			scheduleId: 'sch_1',
			userId: 'usr_1',
		})
		const monthly = signReportUnsubscribeToken(
			{ kind: 'monthly', organizationId: 'org_1', userId: 'usr_1' },
			SECRET,
		)
		expect(verifyReportUnsubscribeToken(monthly, SECRET)?.kind).toBe('monthly')
	})

	it('refuses forgeries, edits, other secrets and junk', () => {
		const token = signReportUnsubscribeToken(
			{ kind: 'schedule', scheduleId: 'sch_1', userId: 'usr_1' },
			SECRET,
		)
		const [payload, mac] = token.split('.')
		const forged = Buffer.from(
			JSON.stringify({ kind: 'schedule', scheduleId: 'sch_1', userId: 'usr_2' }),
		).toString('base64url')
		expect(verifyReportUnsubscribeToken(`${forged}.${mac}`, SECRET)).toBeNull()
		expect(verifyReportUnsubscribeToken(`${payload}.AAAA`, SECRET)).toBeNull()
		expect(verifyReportUnsubscribeToken(token, `${SECRET}-other`)).toBeNull()
		for (const junk of ['', 'x', 'a.b.c', `${payload}`, '.'.repeat(5), 'z'.repeat(700)]) {
			expect(verifyReportUnsubscribeToken(junk, SECRET)).toBeNull()
		}
	})

	it('refuses to sign without a real secret', () => {
		expect(() =>
			signReportUnsubscribeToken(
				{ kind: 'schedule', scheduleId: 's', userId: 'u' },
				'short',
			),
		).toThrow()
	})
})
