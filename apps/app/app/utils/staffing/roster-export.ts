import { toCsv, type CsvCell } from '@repo/staffing'
import { type StaffListRow, type StaffPositionRow } from './staff-types.ts'

export type RosterCsvLabels = {
	name: string
	status: string
	email: string
	phone: string
	employeeNumber: string
	scopes: string
	positions: string
	hired: string
	payType: string
	rate: string
	salary: string
	currency: string
	statuses: Record<string, string>
	payTypes: Record<string, string>
}

export type RosterCsvInput = {
	staff: readonly StaffListRow[]
	positions: ReadonlyMap<string, Pick<StaffPositionRow, 'name'>>
	scopes: ReadonlyMap<string, { name: string }>
	/** Pay columns are added only when the token carried the pay grant. */
	includePay: boolean
	labels: RosterCsvLabels
}

/**
 * Builds the roster export in the browser. Names, emails and position names are
 * user-controlled text, so every cell goes through `toCsv`, which neutralizes a
 * leading `=`, `+`, `-`, `@`, tab or carriage return so a crafted name cannot
 * run as a spreadsheet formula. Money is exported in major units as plain
 * numbers (`15.5`), never as formatted strings.
 */
export function buildRosterCsv(input: RosterCsvInput): string {
	const { labels } = input
	const headers = [
		labels.name,
		labels.status,
		labels.email,
		labels.phone,
		labels.employeeNumber,
		labels.scopes,
		labels.positions,
		labels.hired,
		...(input.includePay
			? [labels.payType, labels.rate, labels.salary, labels.currency]
			: []),
	]
	const rows: CsvCell[][] = input.staff.map((person) => {
		const scopeNames = person.assignments
			.filter((assignment) => assignment.active)
			.map((assignment) => input.scopes.get(assignment.scopeId)?.name)
			.filter((name): name is string => Boolean(name))
		const positionNames = person.positionIds
			.map((id) => input.positions.get(id)?.name)
			.filter((name): name is string => Boolean(name))
		const row: CsvCell[] = [
			`${person.firstName} ${person.lastName}`.trim(),
			labels.statuses[person.status] ?? person.status,
			person.email,
			person.phone,
			person.employeeNumber,
			scopeNames.join('; '),
			positionNames.join('; '),
			person.hiredDate,
		]
		if (input.includePay) {
			const rate = person.currentRate
			row.push(
				rate ? (labels.payTypes[rate.payType] ?? rate.payType) : null,
				rate?.rateMinor !== null && rate?.rateMinor !== undefined
					? rate.rateMinor / 100
					: null,
				rate?.annualSalaryMinor !== null &&
					rate?.annualSalaryMinor !== undefined
					? rate.annualSalaryMinor / 100
					: null,
				rate?.currency ?? null,
			)
		}
		return row
	})
	return toCsv(headers, rows, { bom: true })
}

/** Starts a browser download of `csv`. Not used on the server. */
export function downloadCsv(filename: string, csv: string): void {
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = filename
	document.body.appendChild(link)
	link.click()
	link.remove()
	// Revoke after the click has been handled.
	setTimeout(() => URL.revokeObjectURL(url), 0)
}
