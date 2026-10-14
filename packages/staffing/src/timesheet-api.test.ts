import { describe, expect, it } from 'vitest'
import {
	hasBlockingIssue,
	timeCardCreateSchema,
	timeCardUpdateSchema,
	timesheetApproveSchema,
	timesheetDayQuerySchema,
	timesheetExportQuerySchema,
	timesheetPeriodQuerySchema,
	timesheetReasonSchema,
	timesheetReopenSchema,
	TIMESHEET_BATCH_MAX,
} from './timesheet-api.ts'

const base = {
	staffId: 'staff-1',
	scopeId: 'loc-1',
	reason: 'Forgot to clock in',
}

describe('timesheetReasonSchema', () => {
	it('requires something readable', () => {
		expect(timesheetReasonSchema.safeParse('Missed punch').success).toBe(true)
		for (const bad of ['', '   ', '\t\n', '​', '​​ ', '...', '--']) {
			expect(timesheetReasonSchema.safeParse(bad).success).toBe(false)
		}
		expect(timesheetReasonSchema.safeParse('x'.repeat(501)).success).toBe(false)
	})
	it('accepts Arabic and digits', () => {
		expect(timesheetReasonSchema.safeParse('نسي تسجيل الدخول').success).toBe(
			true,
		)
		expect(timesheetReasonSchema.safeParse('7').success).toBe(true)
	})
})

describe('timeCardCreateSchema', () => {
	it('accepts instants or local times, never both, never partial', () => {
		expect(
			timeCardCreateSchema.safeParse({
				...base,
				clockInAt: 1_700_000_000_000,
				clockOutAt: 1_700_000_900_000,
			}).success,
		).toBe(true)
		expect(
			timeCardCreateSchema.safeParse({
				...base,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
			}).success,
		).toBe(true)
		for (const bad of [
			{ ...base },
			{ ...base, clockInAt: 1_700_000_000_000 },
			{ ...base, date: '2026-03-02', startTime: '09:00' },
			{
				...base,
				clockInAt: 1_700_000_000_000,
				clockOutAt: 1_700_000_900_000,
				date: '2026-03-02',
			},
		]) {
			expect(timeCardCreateSchema.safeParse(bad).success).toBe(false)
		}
	})

	it('requires a reason and rejects unknown keys and bad values', () => {
		const times = {
			clockInAt: 1_700_000_000_000,
			clockOutAt: 1_700_000_900_000,
		}
		const { reason: ignoredReason, ...noReason } = base
		void ignoredReason
		expect(
			timeCardCreateSchema.safeParse({ ...noReason, ...times }).success,
		).toBe(false)
		for (const extra of [
			{ status: 'approved' },
			{ approvedBy: 'me' },
			{ rateMinor: 10_000 },
			{ cashTipsMinor: -1 },
			{ cashTipsMinor: 1.5 },
			{ cashTipsMinor: 10_000_001 },
			{ clockInAt: -5 },
			{ startTime: '24:00' },
			{ breaks: Array.from({ length: 13 }, () => ({ startAt: 1, endAt: 2 })) },
			{ breaks: [{ kind: 'nap', startAt: 1, endAt: 2 }] },
			{ breaks: [{ paid: true, startAt: 1, endAt: 2 }] },
			{
				breaks: [
					{ startAt: 1, endAt: 2, startTime: '10:00', endTime: '11:00' },
				],
			},
		]) {
			expect(
				timeCardCreateSchema.safeParse({ ...base, ...times, ...extra }).success,
			).toBe(false)
		}
	})

	it('does not echo rejected values in issues', () => {
		const result = timeCardCreateSchema.safeParse({
			...base,
			clockInAt: 1,
			clockOutAt: 2,
			breaks: [{ kind: 'secret-value-xyz', startAt: 1, endAt: 2 }],
		})
		expect(result.success).toBe(false)
	})
})

describe('timeCardUpdateSchema', () => {
	it('needs the version and a reason', () => {
		expect(
			timeCardUpdateSchema.safeParse({ reason: 'Fix' + 'x', clockOutAt: 5 })
				.success,
		).toBe(false)
		expect(
			timeCardUpdateSchema.safeParse({ expectedVersion: 1, clockOutAt: 5 })
				.success,
		).toBe(false)
		expect(
			timeCardUpdateSchema.safeParse({
				expectedVersion: 1,
				reason: 'Fixed clock-out',
				clockOutAt: 5,
			}).success,
		).toBe(true)
	})

	it('refuses mixed or partial local times', () => {
		const ok = { expectedVersion: 2, reason: 'Fix' }
		expect(
			timeCardUpdateSchema.safeParse({
				...ok,
				clockInAt: 1,
				date: '2026-03-02',
			}).success,
		).toBe(false)
		expect(
			timeCardUpdateSchema.safeParse({ ...ok, startTime: '09:00' }).success,
		).toBe(false)
		expect(
			timeCardUpdateSchema.safeParse({
				...ok,
				date: '2026-03-02',
				startTime: '09:00',
				endTime: '17:00',
			}).success,
		).toBe(true)
	})

	it('lets a note be cleared with null', () => {
		expect(
			timeCardUpdateSchema.safeParse({
				expectedVersion: 1,
				reason: 'Clear note',
				managerNote: null,
			}).success,
		).toBe(true)
	})
})

describe('batch schemas', () => {
	it('bounds and de-duplicates the batch', () => {
		expect(timesheetApproveSchema.safeParse({ entries: [] }).success).toBe(
			false,
		)
		expect(
			timesheetApproveSchema.safeParse({
				entries: [
					{ id: 'a', version: 1 },
					{ id: 'a', version: 2 },
				],
			}).success,
		).toBe(false)
		expect(
			timesheetApproveSchema.safeParse({
				entries: Array.from({ length: TIMESHEET_BATCH_MAX + 1 }, (_, i) => ({
					id: `e${i}`,
					version: 1,
				})),
			}).success,
		).toBe(false)
		expect(
			timesheetApproveSchema.safeParse({
				entries: [{ id: 'a', version: 1 }],
			}).success,
		).toBe(true)
	})

	it('makes unlock and reopen say why', () => {
		expect(
			timesheetReopenSchema.safeParse({ entries: [{ id: 'a', version: 1 }] })
				.success,
		).toBe(false)
		expect(
			timesheetReopenSchema.safeParse({
				entries: [{ id: 'a', version: 1 }],
				reason: 'Wrong tips',
			}).success,
		).toBe(true)
	})
})

describe('query schemas', () => {
	it('accepts real dates only and opaque ids only', () => {
		expect(
			timesheetDayQuerySchema.safeParse({ date: '2026-03-02' }).success,
		).toBe(true)
		for (const bad of [
			{ date: '2026-02-30' },
			{ date: '2026-03-02', scopeId: '../etc' },
			{ date: '2026-03-02', scopeId: 'a'.repeat(65) },
			{ date: '2026-03-02', status: 'paid' },
			{ date: '2026-03-02', extra: 1 },
			{},
		]) {
			expect(timesheetDayQuerySchema.safeParse(bad).success).toBe(false)
		}
	})

	it('refuses date and periodStart together', () => {
		expect(
			timesheetPeriodQuerySchema.safeParse({
				date: '2026-03-02',
				periodStart: '2026-03-02',
			}).success,
		).toBe(false)
		expect(
			timesheetExportQuerySchema.safeParse({ periodStart: '2026-03-02' }).data
				?.kind,
		).toBe('cards')
	})
})

describe('hasBlockingIssue', () => {
	it('blocks only data errors, not informational flags', () => {
		expect(hasBlockingIssue(['missing_clock_out'])).toBe(true)
		expect(hasBlockingIssue(['open_break'])).toBe(true)
		expect(hasBlockingIssue(['negative_duration'])).toBe(true)
		expect(
			hasBlockingIssue(['late', 'missed_break', 'edited', 'long_shift']),
		).toBe(false)
	})
})
