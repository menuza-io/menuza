import { describe, expect, it } from 'vitest'
import {
	internalEraseUserRequestSchema,
	internalLinkUserRequestSchema,
	internalSummaryRequestSchema,
	opaqueIdSchema,
	STAFFING_OUTBOX_KINDS,
	STAFFING_OUTBOX_PATHS,
	STAFFING_OUTBOX_PAYLOAD_SCHEMAS,
	staffSummarySchema,
	summaryHasStaffData,
	type StaffSummary,
} from './internal-api.ts'

const emptySummary: StaffSummary = {
	staff: 0,
	byStatus: { invited: 0, active: 0, on_leave: 0, terminated: 0 },
	linkedLogins: 0,
	scopeAssignments: 0,
	positions: 0,
	payRecords: 0,
	notes: 0,
	auditEntries: 0,
}

describe('internal staff contracts', () => {
	it('accepts cuid, uuid and slug-like ids and rejects everything else', () => {
		for (const id of [
			'clw9x0a12000008l00staffa',
			'1f0d6d1e-2d1a-4a45-9d63-2c2f3a8e5f7b',
			'org_role_admin',
		]) {
			expect(opaqueIdSchema.safeParse(id).success).toBe(true)
		}
		for (const id of [
			'',
			' ',
			'a b',
			'rana@example.com',
			'+14155550123',
			'../etc',
			'x'.repeat(65),
		]) {
			expect(opaqueIdSchema.safeParse(id).success).toBe(false)
		}
	})

	it('every outbox kind has a payload schema and a path', () => {
		for (const kind of STAFFING_OUTBOX_KINDS) {
			expect(STAFFING_OUTBOX_PAYLOAD_SCHEMAS[kind]).toBeDefined()
			expect(STAFFING_OUTBOX_PATHS[kind]).toMatch(/^[a-z-]+$/)
		}
	})

	it('payloads are ids only: extra fields are rejected', () => {
		expect(
			STAFFING_OUTBOX_PAYLOAD_SCHEMAS.link_user.safeParse({
				staffMemberId: 's1',
				userId: 'u1',
				email: 'rana@example.com',
			}).success,
		).toBe(false)
		expect(
			STAFFING_OUTBOX_PAYLOAD_SCHEMAS.erase_user.safeParse({
				userId: 'u1',
				name: 'Rana',
			}).success,
		).toBe(false)
		expect(
			STAFFING_OUTBOX_PAYLOAD_SCHEMAS.unlink_user.safeParse({}).success,
		).toBe(false)
	})

	it('requests require an org id and reject extra keys', () => {
		expect(internalSummaryRequestSchema.safeParse({}).success).toBe(false)
		expect(
			internalSummaryRequestSchema.safeParse({ orgId: 'o1' }).success,
		).toBe(true)
		expect(
			internalSummaryRequestSchema.safeParse({ orgId: 'o1', x: 1 }).success,
		).toBe(false)
		expect(
			internalLinkUserRequestSchema.safeParse({
				orgId: 'o1',
				staffMemberId: 's1',
				userId: 'u1',
			}).success,
		).toBe(true)
		expect(
			internalEraseUserRequestSchema.safeParse({ orgId: 'o1' }).success,
		).toBe(false)
	})

	it('the summary is numbers only', () => {
		expect(staffSummarySchema.safeParse(emptySummary).success).toBe(true)
		expect(
			staffSummarySchema.safeParse({ ...emptySummary, names: ['Rana'] })
				.success,
		).toBe(false)
		expect(
			staffSummarySchema.safeParse({ ...emptySummary, staff: -1 }).success,
		).toBe(false)
		expect(
			staffSummarySchema.safeParse({ ...emptySummary, staff: 'many' }).success,
		).toBe(false)
	})

	it('summaryHasStaffData counts time cards and shifts on their own', () => {
		expect(summaryHasStaffData({ ...emptySummary, timeCards: 1 })).toBe(true)
		expect(summaryHasStaffData({ ...emptySummary, shifts: 1 })).toBe(true)
		// An older node does not report them: absent means none.
		expect(summaryHasStaffData({ ...emptySummary })).toBe(false)
	})

	it('summaryHasStaffData is false only for an empty region', () => {
		expect(summaryHasStaffData(emptySummary)).toBe(false)
		expect(summaryHasStaffData({ ...emptySummary, staff: 1 })).toBe(true)
		expect(summaryHasStaffData({ ...emptySummary, positions: 1 })).toBe(true)
		expect(summaryHasStaffData({ ...emptySummary, notes: 1 })).toBe(true)
	})
})
