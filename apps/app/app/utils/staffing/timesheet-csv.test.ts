import { describe, expect, it } from 'vitest'
import { type Timesheet } from './client.ts'
import { type TimesheetCsvLabels, timesheetCsv } from './timesheet-csv.ts'

const labels: TimesheetCsvLabels = {
	person: 'Person',
	date: 'Date',
	position: 'Position',
	clockIn: 'Clock in',
	clockOut: 'Clock out',
	unpaidBreak: 'Unpaid break (min)',
	paidHours: 'Paid hours',
	status: 'Status',
	issues: 'Issues',
	source: 'Source',
	note: 'Note',
	weeklyTotals: 'Weekly totals',
	weekStarting: 'Week starting',
	regularHours: 'Regular hours',
	overThresholdHours: 'Over threshold hours',
	statusLabel: (status) => status,
	issueLabel: (issue) => issue,
	sourceLabel: (source) => source,
}

const base = {
	locationId: 'loc',
	positionId: 'pos',
	shiftId: null,
	timeZone: 'America/New_York',
	deviceId: null,
	approvedBy: null,
	scheduled: null,
	edited: false,
}

const sheet: Timesheet = {
	locationId: 'loc',
	timeZone: 'America/New_York',
	from: '2026-10-12',
	to: '2026-10-18',
	settings: {
		weekStart: 'monday',
		weeklyHoursThreshold: 40,
		lateGraceMinutes: 5,
	},
	positions: [{ id: 'pos', name: 'Cook', colorKey: 'orange', archived: false }],
	staff: [],
	entries: [
		{
			...base,
			id: 'e2',
			staffId: 'b',
			localDate: '2026-10-12',
			clockInAt: '2026-10-13T02:00:00.000Z',
			clockOutAt: '2026-10-13T06:00:00.000Z',
			source: 'kiosk',
			unpaidBreakMinutes: 0,
			note: '=HYPERLINK("x")',
			approvedAt: '2026-10-14T00:00:00.000Z',
			paidMinutes: 240,
			issues: [],
		},
		{
			...base,
			id: 'e1',
			staffId: 'a',
			localDate: '2026-10-12',
			clockInAt: '2026-10-12T13:20:00.000Z',
			clockOutAt: null,
			source: 'manager',
			unpaidBreakMinutes: 0,
			note: '',
			approvedAt: null,
			paidMinutes: 0,
			issues: ['missing_clock_out', 'late'],
		},
	],
	weeks: [
		{
			staffId: 'a',
			weekStart: '2026-10-12',
			paidMinutes: 2730,
			regularMinutes: 2400,
			overThresholdMinutes: 330,
		},
	],
	devices: {},
}

describe('timesheet CSV', () => {
	it('exports wall-clock times, statuses, and weekly splits safely', () => {
		const names: Record<string, string> = { a: 'Ana Lopez', b: 'Ben Ortiz' }
		const csv = timesheetCsv(sheet, labels, (id) => names[id] ?? '')
		expect(csv.split('\r\n')).toEqual([
			'Person,Date,Position,Clock in,Clock out,Unpaid break (min),Paid hours,Status,Issues,Source,Note',
			'Ana Lopez,2026-10-12,Cook,2026-10-12 09:20,,0,0,open,missing_clock_out; late,manager,',
			// Overnight shows the next day; formulas are neutralized.
			`Ben Ortiz,2026-10-12,Cook,2026-10-12 22:00,2026-10-13 02:00,0,4,approved,,kiosk,"'=HYPERLINK(""x"")"`,
			'',
			'Weekly totals',
			'Person,Week starting,Paid hours,Regular hours,Over threshold hours',
			'Ana Lopez,2026-10-12,45.5,40,5.5',
			'',
		])
	})
})
