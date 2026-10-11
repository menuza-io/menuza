import { describe, expect, it } from 'vitest'
import { csvCell, toCsv } from './csv.ts'
import { resolveStaffingFlags, isFlagOn } from './flags.ts'
import { splitWeeklyThreshold } from './hours.ts'
import { pinProblem } from './pin.ts'
import {
	normalizeAssignments,
	parseRosterPaste,
	ROSTER_IMPORT_MAX_ROWS,
	staffMemberInputSchema,
} from './roster.ts'
import {
	copyShiftToWeek,
	findOverlappingShiftIds,
	paidMinutes,
	shiftInputSchema,
	summarizeSchedule,
} from './schedule.ts'
import {
	staffingTokenAllows,
	staffingTokenAllowsLocation,
	staffingTokenClaimsSchema,
	staffingTokenLocationZone,
} from './token.ts'

const at = (iso: string) => new Date(iso)

describe('flags', () => {
	it('defaults every staffing flag to off', () => {
		expect(resolveStaffingFlags({})).toEqual({
			enabled: false,
			scheduling: false,
			timeclock: false,
			pay: false,
			hiring: false,
			onboarding: false,
		})
	})

	it('ignores area flags while the master switch is off', () => {
		expect(
			resolveStaffingFlags({ scheduling: true, timeclock: 'on' }).scheduling,
		).toBe(false)
		const on = resolveStaffingFlags({ enabled: true, timeclock: 'true' })
		expect(on.enabled).toBe(true)
		expect(on.timeclock).toBe(true)
		expect(on.scheduling).toBe(false)
	})

	it('accepts only explicit truthy values', () => {
		expect(isFlagOn(false)).toBe(false)
		expect(isFlagOn('false')).toBe(false)
		expect(isFlagOn(null)).toBe(false)
		expect(isFlagOn({})).toBe(false)
		expect(isFlagOn(' ON ')).toBe(true)
	})
})

describe('token claims', () => {
	const claims = staffingTokenClaimsSchema.parse({
		scope: 'staffing',
		areas: { staff: 'read', schedule: 'write' },
		locationIds: null,
		locations: [
			{ id: 'loc-a', tz: 'America/New_York' },
			{ id: 'loc-b', tz: 'Asia/Riyadh' },
		],
	})

	it('separates read and write per area', () => {
		expect(staffingTokenAllows(claims, 'staff', 'read')).toBe(true)
		expect(staffingTokenAllows(claims, 'staff', 'write')).toBe(false)
		expect(staffingTokenAllows(claims, 'schedule', 'write')).toBe(true)
		expect(staffingTokenAllows(claims, 'timeclock', 'read')).toBe(false)
	})

	it('treats null locations as all and an empty list as none', () => {
		expect(staffingTokenAllowsLocation(claims, 'loc-a')).toBe(true)
		expect(
			staffingTokenAllowsLocation({ ...claims, locationIds: [] }, 'loc-a'),
		).toBe(false)
		expect(
			staffingTokenAllowsLocation(
				{ ...claims, locationIds: ['loc-b'] },
				'loc-a',
			),
		).toBe(false)
	})
	it('never allows a location the signed list does not contain', () => {
		expect(staffingTokenAllowsLocation(claims, 'loc-z')).toBe(false)
		expect(
			staffingTokenAllowsLocation(
				{ ...claims, locationIds: ['loc-z'] },
				'loc-z',
			),
		).toBe(false)
		expect(staffingTokenLocationZone(claims, 'loc-b')).toBe('Asia/Riyadh')
	})
	it('rejects invalid location time zones', () => {
		expect(
			staffingTokenClaimsSchema.safeParse({
				...claims,
				locations: [{ id: 'loc-a', tz: 'Mars/Base' }],
			}).success,
		).toBe(false)
	})

	it('rejects unknown areas and other scopes', () => {
		expect(
			staffingTokenClaimsSchema.safeParse({
				scope: 'staffing',
				areas: { payroll: 'write' },
				locationIds: null,
				locations: [],
			}).success,
		).toBe(false)
		expect(
			staffingTokenClaimsSchema.safeParse({
				scope: 'mailbox',
				areas: {},
				locationIds: null,
				locations: [],
			}).success,
		).toBe(false)
	})
})

describe('schedule math', () => {
	it('flags only overlapping shifts for the same person', () => {
		const ids = findOverlappingShiftIds([
			{
				id: 'a',
				staffId: 's1',
				startAt: at('2026-10-12T13:00:00Z'),
				endAt: at('2026-10-12T21:00:00Z'),
			},
			{
				id: 'b',
				staffId: 's1',
				startAt: at('2026-10-12T20:00:00Z'),
				endAt: at('2026-10-12T23:00:00Z'),
			},
			{
				id: 'c',
				staffId: 's1',
				startAt: at('2026-10-12T23:00:00Z'),
				endAt: at('2026-10-13T01:00:00Z'),
			},
			{
				id: 'd',
				staffId: 's2',
				startAt: at('2026-10-12T13:00:00Z'),
				endAt: at('2026-10-12T21:00:00Z'),
			},
			{
				id: 'open',
				staffId: null,
				startAt: at('2026-10-12T13:00:00Z'),
				endAt: at('2026-10-12T21:00:00Z'),
			},
		])
		expect([...ids].sort()).toEqual(['a', 'b'])
	})

	it('detects a short shift nested inside a long one', () => {
		const ids = findOverlappingShiftIds([
			{
				id: 'long',
				staffId: 's1',
				startAt: at('2026-10-12T08:00:00Z'),
				endAt: at('2026-10-12T20:00:00Z'),
			},
			{
				id: 'short',
				staffId: 's1',
				startAt: at('2026-10-12T09:00:00Z'),
				endAt: at('2026-10-12T10:00:00Z'),
			},
			{
				id: 'later',
				staffId: 's1',
				startAt: at('2026-10-12T11:00:00Z'),
				endAt: at('2026-10-12T12:00:00Z'),
			},
		])
		expect([...ids].sort()).toEqual(['later', 'long', 'short'])
	})

	it('subtracts unpaid breaks and summarizes by person and day', () => {
		const shifts = [
			{
				staffId: 's1',
				localDate: '2026-10-12',
				startAt: at('2026-10-12T13:00:00Z'),
				endAt: at('2026-10-12T21:00:00Z'),
				unpaidBreakMinutes: 30,
			},
			{
				staffId: null,
				localDate: '2026-10-12',
				startAt: at('2026-10-12T13:00:00Z'),
				endAt: at('2026-10-12T17:00:00Z'),
				unpaidBreakMinutes: 0,
			},
		]
		expect(paidMinutes(shifts[0]!)).toBe(450)
		const summary = summarizeSchedule(shifts)
		expect(summary.staffTotals.get('s1')).toBe(450)
		expect(summary.days.get('2026-10-12')).toEqual({
			minutes: 690,
			headcount: 1,
		})
	})

	it('copies wall-clock times to the next week across DST', () => {
		const copy = copyShiftToWeek(
			{
				localDate: '2026-10-26',
				startTime: '09:00',
				endTime: '17:00',
				timeZone: 'America/New_York',
			},
			7,
		)
		expect(copy.localDate).toBe('2026-11-02')
		expect(copy.startAt.toISOString()).toBe('2026-11-02T14:00:00.000Z')
	})

	it('rejects zero-length shifts', () => {
		expect(
			shiftInputSchema.safeParse({
				locationId: 'loc',
				staffId: null,
				positionId: null,
				localDate: '2026-10-12',
				startTime: '09:00',
				endTime: '09:00',
			}).success,
		).toBe(false)
	})
})

describe('weekly threshold', () => {
	it('splits regular and over-threshold minutes', () => {
		expect(splitWeeklyThreshold(45 * 60, 40)).toEqual({
			regularMinutes: 2400,
			overThresholdMinutes: 300,
		})
		expect(splitWeeklyThreshold(100, null)).toEqual({
			regularMinutes: 100,
			overThresholdMinutes: 0,
		})
	})
})

describe('PIN rules', () => {
	it('rejects formats, repeats, and runs', () => {
		expect(pinProblem('12a4')).toBe('format')
		expect(pinProblem('123')).toBe('format')
		expect(pinProblem('1234567')).toBe('format')
		expect(pinProblem('0000')).toBe('repeated')
		expect(pinProblem('1234')).toBe('sequence')
		expect(pinProblem('9876')).toBe('sequence')
		expect(pinProblem('4827')).toBeNull()
		expect(pinProblem('204913')).toBeNull()
	})
})

describe('CSV export', () => {
	it('neutralizes formulas and quotes separators', () => {
		expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
		expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`)
		expect(csvCell('-2+3')).toBe(`'-2+3`)
		expect(csvCell(-2)).toBe('-2')
		expect(csvCell('a,b')).toBe('"a,b"')
		expect(csvCell(null)).toBe('')
		expect(
			toCsv([
				['Name', 'Hours'],
				['Ana', 8],
			]),
		).toBe('Name,Hours\r\nAna,8\r\n')
	})
})

describe('roster input', () => {
	it('normalizes optional contact fields', () => {
		const parsed = staffMemberInputSchema.parse({
			firstName: ' Ana ',
			email: ' ANA@Example.com ',
			phone: '',
		})
		expect(parsed).toMatchObject({
			firstName: 'Ana',
			lastName: '',
			email: 'ana@example.com',
			phone: null,
			hiredOn: null,
			assignments: [],
		})
	})

	it('keeps one primary position per location', () => {
		expect(
			normalizeAssignments([
				{ locationId: 'l1', positionId: 'cook', isPrimary: false },
				{ locationId: 'l1', positionId: 'server', isPrimary: false },
				{ locationId: 'l1', positionId: 'cook', isPrimary: true },
				{ locationId: 'l2', positionId: 'cook', isPrimary: true },
				{ locationId: 'l2', positionId: 'host', isPrimary: true },
			]),
		).toEqual([
			{ locationId: 'l1', positionId: 'cook', isPrimary: true },
			{ locationId: 'l1', positionId: 'server', isPrimary: false },
			{ locationId: 'l2', positionId: 'cook', isPrimary: true },
			{ locationId: 'l2', positionId: 'host', isPrimary: false },
		])
	})

	it('parses pasted rows and reports line-numbered errors', () => {
		const result = parseRosterPaste(
			[
				'Name, Email, Phone, Position',
				'Ana María Lopez, ana@example.com, +1 555 010 1000, Cook',
				'',
				'Ben\tben@example.com\t\tServer',
				'Cara, not-an-email',
				', missing@example.com',
				'Dan, ANA@example.com',
				'Eve',
			].join('\n'),
		)
		expect(result.rows).toEqual([
			{
				line: 2,
				firstName: 'Ana',
				lastName: 'María Lopez',
				email: 'ana@example.com',
				phone: '+1 555 010 1000',
				positionName: 'Cook',
			},
			{
				line: 4,
				firstName: 'Ben',
				lastName: '',
				email: 'ben@example.com',
				phone: null,
				positionName: 'Server',
			},
			{
				line: 8,
				firstName: 'Eve',
				lastName: '',
				email: null,
				phone: null,
				positionName: null,
			},
		])
		expect(result.errors).toEqual([
			{ line: 5, code: 'invalid_email' },
			{ line: 6, code: 'name_required' },
			{ line: 7, code: 'duplicate_email' },
		])
	})

	it('caps the number of imported rows', () => {
		const text = Array.from(
			{ length: ROSTER_IMPORT_MAX_ROWS + 2 },
			(ignoredValue, index) => `Person${index}`,
		).join('\n')
		const result = parseRosterPaste(text)
		expect(result.rows).toHaveLength(ROSTER_IMPORT_MAX_ROWS)
		expect(result.errors).toEqual([
			{ line: ROSTER_IMPORT_MAX_ROWS + 1, code: 'too_many_rows' },
		])
	})
})
