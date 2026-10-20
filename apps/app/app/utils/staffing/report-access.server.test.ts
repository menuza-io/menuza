import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@repo/auth', () => ({
	getUserOrganizationPermissions: vi.fn(),
	isImpersonating: vi.fn(),
}))
vi.mock('#app/utils/staffing/access.server.ts', () => ({
	getStaffingFeatureState: vi.fn(),
}))
vi.mock('#app/utils/staffing/scope-claim.server.ts', () => ({
	resolveStaffingScopeIds: vi.fn(),
}))

import { staffReportAccess } from './report-access.server.ts'

const ALL_ON = {
	enabled: true,
	timeclock: true,
	scheduling: true,
	labor: true,
	hiring: true,
}
const ALL_PERMISSIONS = new Set<string>([
	P.READ_STAFF,
	P.READ_TIMESHEET,
	P.READ_SCHEDULE,
	P.READ_LABOR,
	P.READ_HIRING,
	P.READ_STAFF_PAY,
])

function access(
	overrides: Partial<Parameters<typeof staffReportAccess>[0]> = {},
) {
	return staffReportAccess({
		features: ALL_ON,
		held: ALL_PERMISSIONS,
		scopeIds: null,
		impersonated: false,
		...overrides,
	})
}

describe('staffReportAccess', () => {
	it('grants every staff subject and the pay permission to a fully permitted manager', () => {
		expect(access()).toEqual({
			subjects: [
				'time_entries',
				'shifts',
				'labor_daily',
				'applications',
				'staff_pay',
			],
			scopeIds: null,
		})
	})

	it('grants nothing while the master flag is off, whatever the child flags say', () => {
		expect(access({ features: { ...ALL_ON, enabled: false } })).toEqual({
			subjects: [],
			scopeIds: [],
		})
	})

	it('needs each subject’s own feature flag', () => {
		for (const [flag, subject] of [
			['timeclock', 'time_entries'],
			['scheduling', 'shifts'],
			['labor', 'labor_daily'],
			['hiring', 'applications'],
		] as const) {
			const result = access({ features: { ...ALL_ON, [flag]: false } })
			expect(result.subjects, `flag ${flag}`).not.toContain(subject)
			expect(result.subjects.length, `flag ${flag}`).toBeGreaterThan(0)
		}
	})

	it('needs each subject’s own permission', () => {
		const without = (permission: string) =>
			new Set([...ALL_PERMISSIONS].filter((held) => held !== permission))
		expect(access({ held: without(P.READ_TIMESHEET) }).subjects).not.toContain(
			'time_entries',
		)
		expect(access({ held: without(P.READ_SCHEDULE) }).subjects).not.toContain(
			'shifts',
		)
		expect(access({ held: without(P.READ_LABOR) }).subjects).not.toContain(
			'labor_daily',
		)
		expect(access({ held: without(P.READ_HIRING) }).subjects).not.toContain(
			'applications',
		)
	})

	it('shows names only with the roster grant', () => {
		const result = access({
			held: new Set([P.READ_TIMESHEET, P.READ_SCHEDULE, P.READ_LABOR]),
		})
		expect(result.subjects).toEqual(['labor_daily'])
	})

	it('accepts a stronger grant for a read requirement', () => {
		const result = access({
			held: new Set([P.UPDATE_STAFF, P.UPDATE_TIMESHEET]),
		})
		expect(result.subjects).toEqual(['time_entries'])
	})

	it('keeps one person’s wages behind the pay grant, the labor flag and a subject that shows them', () => {
		const noPay = new Set(
			[...ALL_PERMISSIONS].filter((held) => held !== P.READ_STAFF_PAY),
		)
		expect(access({ held: noPay }).subjects).not.toContain('staff_pay')
		expect(
			access({ features: { ...ALL_ON, labor: false } }).subjects,
		).not.toContain('staff_pay')
		// Pay without time card access has nothing to show it on.
		expect(
			access({ held: new Set([P.READ_LABOR, P.READ_STAFF_PAY]) }).subjects,
		).toEqual(['labor_daily'])
	})

	it('never widens the workplace workplace', () => {
		expect(access({ scopeIds: ['a', 'b'] }).scopeIds).toEqual(['a', 'b'])
		expect(access({ scopeIds: [] })).toEqual({
			subjects: [],
			scopeIds: [],
		})
	})

	it('gives an impersonated session nothing', () => {
		expect(access({ impersonated: true })).toEqual({
			subjects: [],
			scopeIds: [],
		})
	})

	it('gives someone with no staffing permission nothing', () => {
		expect(access({ held: new Set(['read:analytics:any']) })).toEqual({
			subjects: [],
			scopeIds: [],
		})
	})
})
