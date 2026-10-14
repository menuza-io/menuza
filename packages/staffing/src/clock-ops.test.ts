import { describe, expect, it } from 'vitest'
import {
	autoClockOutInstant,
	dedupeKeys,
	expectedEntryEnd,
	isEmailSwitchOn,
	isNoClockInDue,
	isOutboxMessageStale,
	isPreShiftReminderDue,
	MANAGER_ALERT_KINDS,
	MANAGER_ALERT_NOTIFICATION_TYPE,
	MANAGER_ALERT_PERMISSIONS,
	MANAGER_ALERT_WORKFLOW,
	managerAlertEventSchema,
	managerAlertKindFromNotificationType,
	managerAlertPath,
	managerOutboxKind,
	normalizeContactLevel,
	outboxRetryDelayMs,
	overtimeAlertFor,
	overtimeStatus,
	parseManagerOutboxKind,
	STAFFING_NOTIFICATION_WORKFLOWS,
} from './clock-ops.ts'
import { NEUTRAL_LABOR_RULES, type LaborRules } from './rules.ts'
import { type TimeEntryInput } from './time-math.ts'
import { parseDate, zonedLocalToUtc } from './tz.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const CHI = 'America/Chicago'

function at(date: string, hhmm: string, tz = CHI): number {
	const { year, month, day } = parseDate(date)
	const [h, m] = hhmm.split(':').map(Number) as [number, number]
	return zonedLocalToUtc(year, month, day, h, m, tz)
}

const rules = (patch: Partial<LaborRules> = {}): LaborRules => ({
	...NEUTRAL_LABOR_RULES,
	weekStartsOn: 1,
	weeklyOvertime: { thresholdMinutes: 40 * 60, multiplierBp: 15000 },
	...patch,
})

function entry(
	id: string,
	date: string,
	from: string,
	to: string | null,
	extra: Partial<TimeEntryInput> = {},
): TimeEntryInput {
	return {
		id,
		scopeId: 'loc-1',
		clockInAt: at(date, from),
		clockOutAt: to === null ? null : at(date, to),
		...extra,
	}
}

describe('manager alert contract', () => {
	const valid = {
		orgId: 'org_1',
		eventId: 'a'.repeat(24),
		kind: 'no_clock_in',
		scopeId: 'loc-1',
		count: 2,
	}

	it('accepts a generic event', () => {
		expect(managerAlertEventSchema.safeParse(valid).success).toBe(true)
		expect(
			managerAlertEventSchema.safeParse({ ...valid, scopeId: null }).success,
		).toBe(true)
	})

	it.each([
		['a staff id', { staffId: 'staff-1' }],
		['a name', { name: 'Jordan Rivera' }],
		['a time', { startAt: 1_700_000_000_000 }],
		['a pay figure', { rateMinor: 1800 }],
		['a list of people', { staffIds: ['a', 'b'] }],
	])('rejects an event that carries %s', (_label, extra) => {
		expect(
			managerAlertEventSchema.safeParse({ ...valid, ...extra }).success,
		).toBe(false)
	})

	it.each([
		['an unknown kind', { kind: 'shift_swapped' }],
		['a zero count', { count: 0 }],
		['a fractional count', { count: 1.5 }],
		['a huge count', { count: 10_001 }],
		['a malformed event id', { eventId: 'not hex!' }],
		['an unsafe org id', { orgId: '../etc' }],
		['an unsafe scope id', { scopeId: 'loc 1; drop' }],
	])('rejects %s', (_label, patch) => {
		expect(
			managerAlertEventSchema.safeParse({ ...valid, ...patch }).success,
		).toBe(false)
	})

	it('maps every kind to a workflow, a notification type and a permission', () => {
		for (const kind of MANAGER_ALERT_KINDS) {
			expect(STAFFING_NOTIFICATION_WORKFLOWS).toContain(
				MANAGER_ALERT_WORKFLOW[kind],
			)
			expect(
				MANAGER_ALERT_NOTIFICATION_TYPE[kind].startsWith('staffing-'),
			).toBe(true)
			expect(MANAGER_ALERT_PERMISSIONS[kind].length).toBeGreaterThan(0)
			expect(
				managerAlertKindFromNotificationType(
					MANAGER_ALERT_NOTIFICATION_TYPE[kind],
				),
			).toBe(kind)
		}
		expect(managerAlertKindFromNotificationType('mention')).toBeNull()
		expect(managerAlertKindFromNotificationType(undefined)).toBeNull()
	})

	it('opens the screen that can act on the alert', () => {
		expect(managerAlertPath('no_clock_in', 'loc-1')).toBe('/staff/timeclock')
		expect(managerAlertPath('missed_clock_out', 'loc-1')).toBe(
			'/staff/timeclock/timesheets?scope=loc-1',
		)
		expect(managerAlertPath('overtime_reached', null)).toBe(
			'/staff/timeclock/timesheets',
		)
	})
})

describe('onboarding and certificate alerts', () => {
	it('open the team, tell hiring readers, and use the hiring preference', () => {
		for (const kind of ['onboarding_due', 'certificate_expiring'] as const) {
			expect(managerAlertPath(kind, 'loc-1')).toBe('/staff/team?scope=loc-1')
			expect(managerAlertPath(kind, null)).toBe('/staff/team')
			expect(MANAGER_ALERT_PERMISSIONS[kind]).toEqual(['read:hiring:any'])
			expect(MANAGER_ALERT_WORKFLOW[kind]).toBe('staffing-hiring-workflow')
			expect(
				MANAGER_ALERT_NOTIFICATION_TYPE[kind].startsWith('staffing-'),
			).toBe(true)
		}
	})

	it('count tasks and certificates: one row per item, stage and date', () => {
		const keys = [
			dedupeKeys.onboardingDue('t1', 1, '2026-10-14'),
			dedupeKeys.onboardingDue('t1', 2, '2026-10-14'),
			dedupeKeys.onboardingDue('t1', 1, '2026-10-20'),
			dedupeKeys.onboardingDue('t2', 1, '2026-10-14'),
			dedupeKeys.certificateExpiring('c1', 1, '2026-11-01'),
			dedupeKeys.certificateExpiring('c1', 2, '2026-11-01'),
			dedupeKeys.certificateExpiring('c1', 1, '2027-11-01'),
		]
		expect(new Set(keys).size).toBe(keys.length)
		expect(dedupeKeys.onboardingDue('t1', 1, '2026-10-14')).toBe(
			'manager.onboarding_due:t1:1:2026-10-14',
		)
	})
})

describe('outbox kinds and keys', () => {
	it('round-trips manager kinds and ignores everything else', () => {
		for (const kind of MANAGER_ALERT_KINDS) {
			expect(parseManagerOutboxKind(managerOutboxKind(kind))).toBe(kind)
		}
		expect(parseManagerOutboxKind('time_card_edited')).toBeNull()
		expect(parseManagerOutboxKind('manager.unknown')).toBeNull()
		expect(parseManagerOutboxKind(undefined)).toBeNull()
	})

	it('builds distinct, stable dedupe keys', () => {
		const keys = [
			dedupeKeys.shiftReminder('s1', 'p1'),
			dedupeKeys.shiftReminder('s1', 'p2'),
			dedupeKeys.missedClockOutReminder('e1'),
			dedupeKeys.autoClockOutNotice('e1'),
			dedupeKeys.noClockIn('s1', 'p1'),
			dedupeKeys.missedClockOut('e1'),
			dedupeKeys.autoClockOut('e1'),
			dedupeKeys.overtime('overtime_approaching', 'p1', 'week', '2026-03-02'),
			dedupeKeys.overtime('overtime_reached', 'p1', 'week', '2026-03-02'),
			dedupeKeys.overtime('overtime_reached', 'p1', 'day', '2026-03-02'),
		]
		expect(new Set(keys).size).toBe(keys.length)
		expect(dedupeKeys.shiftReminder('s1', 'p1')).toBe('shift_reminder:s1:p1')
		expect(dedupeKeys.noClockIn('s1', 'p1')).toBe('manager.no_clock_in:s1:p1')
	})

	it('backs off 5 minutes, doubling, to a 6 hour ceiling', () => {
		expect(outboxRetryDelayMs(1)).toBe(5 * MIN)
		expect(outboxRetryDelayMs(2)).toBe(10 * MIN)
		expect(outboxRetryDelayMs(3)).toBe(20 * MIN)
		expect(outboxRetryDelayMs(30)).toBe(6 * HOUR)
		expect(outboxRetryDelayMs(0)).toBe(5 * MIN)
	})

	it('drops messages that waited too long to matter', () => {
		const createdAt = 1_000_000_000_000
		expect(
			isOutboxMessageStale({
				kind: 'manager.no_clock_in',
				createdAt,
				nowMs: createdAt + 23 * HOUR,
			}),
		).toBe(false)
		expect(
			isOutboxMessageStale({
				kind: 'manager.no_clock_in',
				createdAt,
				nowMs: createdAt + 25 * HOUR,
			}),
		).toBe(true)
		// A reminder for a shift that already began is noise.
		expect(
			isOutboxMessageStale({
				kind: 'shift_reminder',
				createdAt,
				nowMs: createdAt + 5 * MIN,
				startAt: createdAt + 4 * MIN,
			}),
		).toBe(true)
		expect(
			isOutboxMessageStale({
				kind: 'shift_reminder',
				createdAt,
				nowMs: createdAt + 5 * MIN,
				startAt: createdAt + 2 * HOUR,
			}),
		).toBe(false)
		expect(
			isOutboxMessageStale({
				kind: 'time_card_edited',
				createdAt,
				nowMs: createdAt + 6 * 24 * HOUR,
			}),
		).toBe(false)
	})
})

describe('timing rules', () => {
	const clockIn = at('2026-03-02', '09:00')

	it('measures an unscheduled entry from the long-shift mark, not from clock-in', () => {
		expect(
			expectedEntryEnd({
				clockInAt: clockIn,
				shiftEndAt: null,
				longShiftMinutes: 720,
			}),
		).toBe(clockIn + 12 * HOUR)
		const shiftEnd = at('2026-03-02', '17:00')
		expect(
			expectedEntryEnd({
				clockInAt: clockIn,
				shiftEndAt: shiftEnd,
				longShiftMinutes: 720,
			}),
		).toBe(shiftEnd)
		// A shift that ended before the person clocked in cannot bound the entry.
		expect(
			expectedEntryEnd({
				clockInAt: clockIn,
				shiftEndAt: clockIn - HOUR,
				longShiftMinutes: 720,
			}),
		).toBe(clockIn + 12 * HOUR)
	})

	it('records an automatic clock-out at the shift end, else the due time', () => {
		const shiftEnd = at('2026-03-02', '17:00')
		const now = at('2026-03-02', '20:00')
		expect(
			autoClockOutInstant({
				clockInAt: clockIn,
				shiftEndAt: shiftEnd,
				dueAt: shiftEnd + HOUR,
				openBreakStartAt: null,
				nowMs: now,
			}),
		).toBe(shiftEnd)
		expect(
			autoClockOutInstant({
				clockInAt: clockIn,
				shiftEndAt: null,
				dueAt: clockIn + 13 * HOUR,
				openBreakStartAt: null,
				nowMs: clockIn + 14 * HOUR,
			}),
		).toBe(clockIn + 13 * HOUR)
	})

	it('never closes before an open break began, before clock-in, or in the future', () => {
		const shiftEnd = at('2026-03-02', '17:00')
		expect(
			autoClockOutInstant({
				clockInAt: clockIn,
				shiftEndAt: shiftEnd,
				dueAt: shiftEnd + HOUR,
				openBreakStartAt: shiftEnd + 20 * MIN,
				nowMs: shiftEnd + 2 * HOUR,
			}),
		).toBe(shiftEnd + 20 * MIN)
		expect(
			autoClockOutInstant({
				clockInAt: clockIn,
				shiftEndAt: clockIn - HOUR,
				dueAt: clockIn - 2 * HOUR,
				openBreakStartAt: null,
				nowMs: clockIn + HOUR,
			}),
		).toBe(clockIn)
		expect(
			autoClockOutInstant({
				clockInAt: clockIn,
				shiftEndAt: null,
				dueAt: clockIn + 99 * HOUR,
				openBreakStartAt: null,
				nowMs: clockIn + HOUR,
			}),
		).toBe(clockIn + HOUR)
	})

	it('flags a no-show only inside the window after the grace and before the end', () => {
		const start = at('2026-03-02', '17:00')
		const end = at('2026-03-02', '21:00')
		const due = (nowMs: number, alertMinutes: number | null = 15) =>
			isNoClockInDue({
				shiftStartAt: start,
				shiftEndAt: end,
				alertMinutes,
				nowMs,
			})
		expect(due(start + 14 * MIN)).toBe(false)
		expect(due(start + 15 * MIN)).toBe(true)
		expect(due(end - 1)).toBe(true)
		expect(due(end)).toBe(false)
		expect(due(start + 30 * MIN, null)).toBe(false)
	})

	it('reminds only between the lead time and the start', () => {
		const start = at('2026-03-02', '17:00')
		const due = (nowMs: number, reminderMinutes: number | null = 240) =>
			isPreShiftReminderDue({ shiftStartAt: start, reminderMinutes, nowMs })
		expect(due(start - 241 * MIN)).toBe(false)
		expect(due(start - 240 * MIN)).toBe(true)
		expect(due(start - 1)).toBe(true)
		expect(due(start)).toBe(false)
		expect(due(start - HOUR, null)).toBe(false)
	})
})

describe('overtime proximity', () => {
	// Monday 2026-03-02 ... Friday 2026-03-06. Four 9h cards = 36h, then a Friday shift.
	const week = [
		entry('a', '2026-03-02', '09:00', '18:00'),
		entry('b', '2026-03-03', '09:00', '18:00'),
		entry('c', '2026-03-04', '09:00', '18:00'),
		entry('d', '2026-03-05', '09:00', '18:00'),
	]
	const base = {
		scopeId: 'loc-1',
		rules: rules(),
		timeZone: CHI,
		alertMinutes: 60,
		exempt: false,
	}

	it('does nothing without an overtime rule', () => {
		const status = overtimeStatus({
			...base,
			rules: rules({ weeklyOvertime: null, dailyOvertime: null }),
			entries: week,
			nowMs: at('2026-03-06', '09:00'),
		})
		expect(status.weekly).toBe('none')
		expect(status.daily).toBe('none')
		expect(overtimeAlertFor(status)).toEqual([])
	})

	it('is quiet while far from the threshold', () => {
		const status = overtimeStatus({
			...base,
			entries: [...week, entry('e', '2026-03-06', '09:00', null)],
			nowMs: at('2026-03-06', '09:30'),
		})
		// 36h + 30m is 3.5 hours short.
		expect(status.weekly).toBe('none')
		expect(status.weeklyMinutes).toBe(36 * 60 + 30)
	})

	it('warns inside the window and counts the open entry up to now', () => {
		const status = overtimeStatus({
			...base,
			entries: [...week, entry('e', '2026-03-06', '09:00', null)],
			nowMs: at('2026-03-06', '12:30'),
		})
		// 36h + 3.5h = 39.5h: within an hour of 40.
		expect(status.weekly).toBe('approaching')
		expect(overtimeAlertFor(status)).toEqual([
			{ kind: 'overtime_approaching', scope: 'week', periodKey: '2026-03-02' },
		])
	})

	it('reports reached once the threshold passes, and not approaching as well', () => {
		const status = overtimeStatus({
			...base,
			entries: [...week, entry('e', '2026-03-06', '09:00', null)],
			nowMs: at('2026-03-06', '13:30'),
		})
		expect(status.weekly).toBe('reached')
		expect(overtimeAlertFor(status)).toEqual([
			{ kind: 'overtime_reached', scope: 'week', periodKey: '2026-03-02' },
		])
	})

	it('measures the day against a daily threshold', () => {
		const status = overtimeStatus({
			...base,
			rules: rules({
				weeklyOvertime: null,
				dailyOvertime: { thresholdMinutes: 8 * 60, multiplierBp: 15000 },
			}),
			entries: [entry('x', '2026-03-03', '07:00', null)],
			nowMs: at('2026-03-03', '14:30'),
		})
		expect(status.daily).toBe('approaching')
		expect(status.weekly).toBe('none')
		expect(overtimeAlertFor(status)).toEqual([
			{ kind: 'overtime_approaching', scope: 'day', periodKey: '2026-03-03' },
		])
	})

	it('never alerts for exempt staff', () => {
		const status = overtimeStatus({
			...base,
			exempt: true,
			entries: [...week, entry('e', '2026-03-06', '09:00', null)],
			nowMs: at('2026-03-06', '15:00'),
		})
		expect(status.weekly).toBe('none')
		expect(overtimeAlertFor(status)).toEqual([])
	})

	it('counts only this scope unless overtime is aggregated', () => {
		const elsewhere = [
			entry('w1', '2026-03-02', '08:00', '20:00', { scopeId: 'loc-2' }),
			entry('w2', '2026-03-03', '08:00', '20:00', { scopeId: 'loc-2' }),
			entry('w3', '2026-03-04', '08:00', '20:00', { scopeId: 'loc-2' }),
		]
		const mine = [entry('m', '2026-03-05', '09:00', null)]
		const separate = overtimeStatus({
			...base,
			entries: [...elsewhere, ...mine],
			nowMs: at('2026-03-05', '12:00'),
		})
		expect(separate.weekly).toBe('none')
		const aggregated = overtimeStatus({
			...base,
			rules: rules({ aggregateOvertimeAcrossScopes: true }),
			entries: [...elsewhere, ...mine],
			nowMs: at('2026-03-05', '12:00'),
		})
		// 36h elsewhere + 3h here.
		expect(aggregated.weekly).toBe('approaching')
	})

	it('keeps the week boundary in the scope time zone', () => {
		// 23:30 Sunday in Chicago is already Monday in UTC; the week still starts Monday 2026-03-02.
		const status = overtimeStatus({
			...base,
			entries: [],
			nowMs: at('2026-03-08', '23:30'),
		})
		expect(status.weekStartDate).toBe('2026-03-02')
		expect(status.localDate).toBe('2026-03-08')
	})
})

describe('content level and email switch', () => {
	it('falls to the level that says less', () => {
		expect(normalizeContactLevel('full')).toBe('full')
		expect(normalizeContactLevel('minimal')).toBe('minimal')
		expect(normalizeContactLevel('anything')).toBe('minimal')
		expect(normalizeContactLevel(null)).toBe('minimal')
	})

	it('treats unset and empty as on, and the usual spellings of off as off', () => {
		expect(isEmailSwitchOn(undefined)).toBe(true)
		expect(isEmailSwitchOn('')).toBe(true)
		expect(isEmailSwitchOn('true')).toBe(true)
		for (const off of [
			'false',
			'FALSE',
			'0',
			'off',
			'No',
			'disabled',
			' false ',
		]) {
			expect(isEmailSwitchOn(off)).toBe(false)
		}
	})
})
