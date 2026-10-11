import { localDateOf, localTimeOf, minutesToHours, toCsv } from '@repo/staffing'
import { type Timesheet } from './client.ts'

export type TimesheetCsvLabels = {
	person: string
	date: string
	position: string
	clockIn: string
	clockOut: string
	unpaidBreak: string
	paidHours: string
	status: string
	issues: string
	source: string
	note: string
	weeklyTotals: string
	weekStarting: string
	regularHours: string
	overThresholdHours: string
	statusLabel: (status: 'approved' | 'pending' | 'open') => string
	issueLabel: (issue: Timesheet['entries'][number]['issues'][number]) => string
	sourceLabel: (source: 'kiosk' | 'manager') => string
}

function stamp(iso: string, timeZone: string) {
	const instant = new Date(iso)
	return `${localDateOf(instant, timeZone)} ${localTimeOf(instant, timeZone)}`
}

/**
 * Built in the browser from rows fetched from the regional API, so a payroll
 * export never passes through App. Times are the location's wall clock.
 */
export function timesheetCsv(
	sheet: Timesheet,
	labels: TimesheetCsvLabels,
	staffName: (staffId: string) => string,
) {
	const positionName = new Map(sheet.positions.map((p) => [p.id, p.name]))
	const entries = [...sheet.entries].sort(
		(a, b) =>
			staffName(a.staffId).localeCompare(staffName(b.staffId)) ||
			a.clockInAt.localeCompare(b.clockInAt),
	)
	const rows: (string | number | null)[][] = [
		[
			labels.person,
			labels.date,
			labels.position,
			labels.clockIn,
			labels.clockOut,
			labels.unpaidBreak,
			labels.paidHours,
			labels.status,
			labels.issues,
			labels.source,
			labels.note,
		],
		...entries.map((entry) => [
			staffName(entry.staffId),
			entry.localDate,
			entry.positionId ? (positionName.get(entry.positionId) ?? '') : '',
			stamp(entry.clockInAt, entry.timeZone),
			entry.clockOutAt ? stamp(entry.clockOutAt, entry.timeZone) : '',
			entry.unpaidBreakMinutes,
			minutesToHours(entry.paidMinutes),
			labels.statusLabel(
				!entry.clockOutAt ? 'open' : entry.approvedAt ? 'approved' : 'pending',
			),
			entry.issues.map(labels.issueLabel).join('; '),
			labels.sourceLabel(entry.source),
			entry.note,
		]),
	]
	if (sheet.weeks.length) {
		rows.push(
			[],
			[labels.weeklyTotals],
			[
				labels.person,
				labels.weekStarting,
				labels.paidHours,
				labels.regularHours,
				labels.overThresholdHours,
			],
			...[...sheet.weeks]
				.sort(
					(a, b) =>
						staffName(a.staffId).localeCompare(staffName(b.staffId)) ||
						a.weekStart.localeCompare(b.weekStart),
				)
				.map((week) => [
					staffName(week.staffId),
					week.weekStart,
					minutesToHours(week.paidMinutes),
					minutesToHours(week.regularMinutes),
					minutesToHours(week.overThresholdMinutes),
				]),
		)
	}
	return toCsv(rows)
}
