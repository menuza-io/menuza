// @vitest-environment jsdom

import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { type StaffListRow } from '#app/utils/staffing/staff-types.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { StaffRoster } from './staff-roster.tsx'

function row(overrides: Partial<StaffListRow> = {}): StaffListRow {
	return {
		id: 's1',
		status: 'active',
		workerType: 'employee',
		firstName: 'Dana',
		lastName: 'Lee',
		firstNameAr: null,
		lastNameAr: null,
		email: 'dana@example.com',
		phone: null,
		userId: null,
		employeeNumber: null,
		locale: 'en',
		hiredDate: null,
		terminatedAt: null,
		terminationReason: null,
		eligibleForRehire: null,
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
				hasPin: false,
				pinSetAt: null,
			},
		],
		positionIds: ['p1'],
		currentRate: {
			payType: 'hourly',
			rateMinor: 1650,
			annualSalaryMinor: null,
			currency: 'USD',
		},
		...overrides,
	}
}

const positions = new Map([
	[
		'p1',
		{
			id: 'p1',
			name: 'Server',
			nameAr: null,
			area: null,
			colorKey: 'blue' as const,
			tipEligible: true,
			archivedAt: null,
		},
	],
])
const scopes = new Map([['loc1', { id: 'loc1', name: 'Downtown' }]])

describe('StaffRoster', () => {
	it('links each name to its profile and shows position, workplace and status', () => {
		renderStaff(
			<StaffRoster
				rows={[row()]}
				positions={positions}
				scopes={scopes}
				showPay={false}
				basePath="/acme/staff/team"
			/>,
		)
		const links = screen.getAllByRole('link', { name: /Dana Lee/ })
		expect(links.length).toBeGreaterThan(0)
		for (const link of links) {
			expect(link.getAttribute('href')).toBe('/acme/staff/team/s1')
		}
		expect(screen.getAllByText('Server').length).toBeGreaterThan(0)
		expect(screen.getAllByText('Downtown').length).toBeGreaterThan(0)
		expect(screen.getByText('Active')).toBeTruthy()
	})

	it('has no pay column and no amounts unless the token carries the pay grant', () => {
		const { container } = renderStaff(
			<StaffRoster
				rows={[row()]}
				positions={positions}
				scopes={scopes}
				showPay={false}
				basePath="/acme/staff/team"
			/>,
		)
		expect(screen.queryByRole('columnheader', { name: 'Pay' })).toBeNull()
		expect(container.textContent).not.toContain('16.50')
	})

	it('adds a tabular-aligned pay column when allowed', () => {
		renderStaff(
			<StaffRoster
				rows={[row()]}
				positions={positions}
				scopes={scopes}
				showPay
				basePath="/acme/staff/team"
			/>,
		)
		const header = screen.getByRole('columnheader', { name: 'Pay' })
		expect(header.className).toContain('text-end')
		const cells = screen.getAllByText('$16.50/h')
		expect(cells.length).toBeGreaterThan(0)
		expect(cells[0]!.className).toContain('tabular-nums')
	})

	it('shows an en dash for someone without a rate and summarizes extra workplaces', () => {
		renderStaff(
			<StaffRoster
				rows={[
					row({
						currentRate: null,
						assignments: [
							row().assignments[0]!,
							{
								...row().assignments[0]!,
								id: 'a2',
								scopeId: 'loc2',
								isPrimary: false,
							},
						],
					}),
				]}
				positions={positions}
				scopes={
					new Map([
						['loc1', { id: 'loc1', name: 'Downtown' }],
						['loc2', { id: 'loc2', name: 'Airport' }],
					])
				}
				showPay
				basePath="/acme/staff/team"
			/>,
		)
		expect(screen.getAllByText(/Downtown \+1 more/).length).toBeGreaterThan(0)
		const table = screen.getByRole('table')
		expect(within(table).getAllByText('–').length).toBeGreaterThan(0)
	})

	describe('onboarding progress', () => {
		const props = {
			positions,
			scopes,
			showPay: false,
			basePath: '/acme/staff/team',
			today: '2026-10-14',
		}
		const summary = (
			over: Partial<{
				total: number
				complete: number
				nextDueDate: string | null
			}> = {},
		) =>
			new Map([
				[
					's1',
					{
						staffId: 's1',
						total: 5,
						complete: 2,
						nextDueDate: '2026-10-20' as string | null,
						...over,
					},
				],
			])

		it('shows progress for a person with tasks left, on the table and the list', () => {
			renderStaff(
				<StaffRoster {...props} rows={[row()]} onboarding={summary()} />,
			)
			// Once in the table (md and up), once in the phone list.
			expect(screen.getAllByText('Onboarding 2/5')).toHaveLength(2)
		})

		it('says late in words when the earliest open task is past due', () => {
			renderStaff(
				<StaffRoster
					{...props}
					rows={[row()]}
					onboarding={summary({ nextDueDate: '2026-10-01' })}
				/>,
			)
			expect(screen.getAllByText('Onboarding 2/5, late')).toHaveLength(2)
		})

		it('adds nothing for a finished checklist or without the feature', () => {
			const { unmount } = renderStaff(
				<StaffRoster
					{...props}
					rows={[row()]}
					onboarding={summary({ complete: 5 })}
				/>,
			)
			expect(screen.queryByText(/Onboarding/)).toBeNull()
			unmount()
			renderStaff(<StaffRoster {...props} rows={[row()]} />)
			expect(screen.queryByText(/Onboarding/)).toBeNull()
		})
	})
})
