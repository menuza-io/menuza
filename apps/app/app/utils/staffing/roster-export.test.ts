import { describe, expect, it } from 'vitest'
import { buildRosterCsv, type RosterCsvLabels } from './roster-export.ts'
import { type StaffListRow } from './staff-types.ts'

const labels: RosterCsvLabels = {
	name: 'Name',
	status: 'Status',
	email: 'Email',
	phone: 'Phone',
	employeeNumber: 'Employee number',
	scopes: 'Workplaces',
	positions: 'Positions',
	hired: 'Hired',
	payType: 'Pay type',
	rate: 'Hourly rate',
	salary: 'Annual salary',
	currency: 'Currency',
	statuses: { active: 'Active' },
	payTypes: { hourly: 'Hourly' },
}

function person(overrides: Partial<StaffListRow> = {}): StaffListRow {
	return {
		id: 's1',
		status: 'active',
		workerType: 'employee',
		firstName: 'Dana',
		lastName: 'Lee',
		firstNameAr: null,
		lastNameAr: null,
		email: 'dana@example.com',
		phone: '+14155550123',
		userId: null,
		employeeNumber: null,
		locale: 'en',
		hiredDate: '2026-01-05',
		terminatedAt: null,
		terminationReason: null,
		eligibleForRehire: true,
		primaryScopeId: 'loc1',
		createdAt: 1,
		updatedAt: 1,
		assignments: [
			{
				id: 'a1',
				staffId: 's1',
				scopeId: 'loc1',
				isPrimary: true,
				showInSchedule: true,
				eligibleOpenShifts: true,
				includeInClockErrors: true,
				canWaiveBreaks: false,
				active: true,
				hasPin: true,
				pinSetAt: 1,
			},
		],
		positionIds: ['p1'],
		...overrides,
	}
}

const base = {
	positions: new Map([['p1', { name: 'Server' }]]),
	scopes: new Map([['loc1', { name: 'Downtown' }]]),
	labels,
}

describe('buildRosterCsv', () => {
	it('exports the roster without pay columns when the token has no pay grant', () => {
		const csv = buildRosterCsv({
			...base,
			staff: [
				person({
					currentRate: {
						payType: 'hourly',
						rateMinor: 1650,
						annualSalaryMinor: null,
						currency: 'USD',
					},
				}),
			],
			includePay: false,
		})
		const [header, row] = csv.replace('﻿', '').split('\r\n')
		expect(header).toBe(
			'Name,Status,Email,Phone,Employee number,Workplaces,Positions,Hired',
		)
		expect(row).toBe(
			"Dana Lee,Active,dana@example.com,'+14155550123,,Downtown,Server,2026-01-05",
		)
		expect(csv).not.toContain('16.5')
		expect(csv).not.toContain('Hourly')
	})

	it('adds pay columns with plain numbers when allowed', () => {
		const csv = buildRosterCsv({
			...base,
			staff: [
				person({
					currentRate: {
						payType: 'hourly',
						rateMinor: 1650,
						annualSalaryMinor: null,
						currency: 'USD',
					},
				}),
			],
			includePay: true,
		})
		const lines = csv.split('\r\n')
		expect(lines[0]).toContain('Pay type,Hourly rate,Annual salary,Currency')
		expect(lines[1]).toMatch(/,Hourly,16\.5,,USD$/)
	})

	it('starts with a byte order mark so Excel reads Arabic names', () => {
		const csv = buildRosterCsv({
			...base,
			staff: [person({ firstName: 'منى', lastName: 'الحربي' })],
			includePay: false,
		})
		expect(csv.startsWith('﻿')).toBe(true)
		expect(csv).toContain('منى الحربي')
	})

	it('neutralizes spreadsheet formulas in every text cell', () => {
		const csv = buildRosterCsv({
			...base,
			staff: [
				person({
					firstName: '=HYPERLINK("http://evil.test","x")',
					lastName: 'Cook',
					email: '@SUM(A1)',
					phone: '+14155550123',
					employeeNumber: '-1+1',
				}),
			],
			positions: new Map([['p1', { name: '=cmd|calc' }]]),
			includePay: false,
		})
		const row = csv.split('\r\n')[1]!
		expect(row.startsWith(`"'=HYPERLINK`)).toBe(true)
		expect(row).toContain(`'@SUM(A1)`)
		expect(row).toContain(`'-1+1`)
		expect(row).toContain(`'=cmd|calc`)
		// A phone number is text that starts with +, which is neutralized too.
		expect(row).toContain(`'+14155550123`)
	})

	it('quotes commas, quotes and line breaks in a name', () => {
		const csv = buildRosterCsv({
			...base,
			staff: [person({ firstName: 'Lee, "Jo"', lastName: 'Ann\nMarie' })],
			includePay: false,
		})
		expect(csv).toContain('"Lee, ""Jo"" Ann\nMarie"')
	})

	it('lists only active workplaces', () => {
		const csv = buildRosterCsv({
			...base,
			scopes: new Map([
				['loc1', { name: 'Downtown' }],
				['loc2', { name: 'Airport' }],
			]),
			staff: [
				person({
					assignments: [
						...person().assignments,
						{
							...person().assignments[0]!,
							id: 'a2',
							scopeId: 'loc2',
							active: false,
						},
					],
				}),
			],
			includePay: false,
		})
		expect(csv).toContain('Downtown')
		expect(csv).not.toContain('Airport')
	})
})
