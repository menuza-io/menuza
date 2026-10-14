import { describe, expect, it } from 'vitest'
import {
	staffAssignmentUpdateSchema,
	staffBulkEnvelopeSchema,
	staffCreateSchema,
	staffImportRowSchema,
	staffJobCreateSchema,
	staffListQuerySchema,
	staffPositionCreateSchema,
	staffRateChangeSchema,
	staffTerminateSchema,
	staffUpdateSchema,
	staffingSettingsUpdateSchema,
} from './staff-api.ts'

const member = { firstName: 'Rana', lastName: 'Khalid' }

describe('staff API schemas', () => {
	it('create: defaults, trimming, email lower-casing', () => {
		const parsed = staffCreateSchema.parse({
			...member,
			firstName: '  Rana ',
			email: 'Rana@Example.COM',
		})
		expect(parsed).toMatchObject({
			firstName: 'Rana',
			email: 'rana@example.com',
			workerType: 'employee',
			locale: 'en',
			assignments: [],
		})
	})

	it('create: rejects unknown and protected keys', () => {
		for (const extra of [
			{ status: 'terminated' },
			{ userId: 'u1' },
			{ id: 'x' },
			{ pinLookup: 'x' },
			{ createdBy: 'x' },
			{ hiredAt: '2026-01-01' },
		]) {
			expect(staffCreateSchema.safeParse({ ...member, ...extra }).success).toBe(
				false,
			)
		}
	})

	it('import rows accept a user id; plain create does not', () => {
		expect(
			staffImportRowSchema.safeParse({ ...member, userId: 'u1' }).success,
		).toBe(true)
		expect(
			staffCreateSchema.safeParse({ ...member, userId: 'u1' }).success,
		).toBe(false)
	})

	it('update: partial, nullable contact fields, no protected keys', () => {
		expect(
			staffUpdateSchema.safeParse({ phone: null, email: null }).success,
		).toBe(true)
		expect(staffUpdateSchema.safeParse({}).success).toBe(false)
		expect(staffUpdateSchema.safeParse({ status: 'terminated' }).success).toBe(
			false,
		)
		expect(staffUpdateSchema.safeParse({ status: 'on_leave' }).success).toBe(
			true,
		)
		expect(staffUpdateSchema.safeParse({ userId: 'u1' }).success).toBe(false)
		expect(staffUpdateSchema.safeParse({ phone: '0123' }).success).toBe(false)
	})

	it('bulk envelope caps rows but defers row validation', () => {
		expect(
			staffBulkEnvelopeSchema.safeParse({ members: [1, 'x', {}] }).success,
		).toBe(true)
		expect(staffBulkEnvelopeSchema.safeParse({ members: [] }).success).toBe(
			false,
		)
		expect(
			staffBulkEnvelopeSchema.safeParse({
				members: Array.from({ length: 201 }, () => ({})),
			}).success,
		).toBe(false)
	})

	it('jobs: integer minor units, known currency, salary needs a salary', () => {
		const job = {
			scopeId: 'l1',
			positionId: 'p1',
			currency: 'USD',
			effectiveFrom: '2026-01-01',
		}
		expect(staffJobCreateSchema.safeParse(job).success).toBe(true)
		expect(
			staffJobCreateSchema.safeParse({ ...job, rateMinor: 15.5 }).success,
		).toBe(false)
		expect(
			staffJobCreateSchema.safeParse({ ...job, rateMinor: -1 }).success,
		).toBe(false)
		expect(
			staffJobCreateSchema.safeParse({ ...job, currency: 'EUR' }).success,
		).toBe(false)
		expect(
			staffJobCreateSchema.safeParse({ ...job, payType: 'salary' }).success,
		).toBe(false)
		expect(
			staffJobCreateSchema.safeParse({
				...job,
				payType: 'salary',
				annualSalaryMinor: 6_000_000,
			}).success,
		).toBe(true)
		expect(
			staffJobCreateSchema.safeParse({ ...job, effectiveFrom: '2026-02-30' })
				.success,
		).toBe(false)
	})

	it('rate change requires an effective date and a non-blank reason', () => {
		const change = {
			effectiveFrom: '2026-03-01',
			rateMinor: 1800,
			reason: 'Review',
		}
		expect(staffRateChangeSchema.safeParse(change).success).toBe(true)
		expect(
			staffRateChangeSchema.safeParse({ ...change, reason: '  ' }).success,
		).toBe(false)
		expect(
			staffRateChangeSchema.safeParse({ ...change, effectiveFrom: undefined })
				.success,
		).toBe(false)
		expect(
			staffRateChangeSchema.safeParse({ ...change, scopeId: 'x' }).success,
		).toBe(false)
	})

	it('terminate requires a reason', () => {
		expect(staffTerminateSchema.safeParse({}).success).toBe(false)
		expect(staffTerminateSchema.safeParse({ reason: ' ' }).success).toBe(false)
		expect(
			staffTerminateSchema.parse({ reason: 'Left' }).eligibleForRehire,
		).toBe(true)
	})

	it('positions: a default rate needs a currency, colors are token keys', () => {
		expect(
			staffPositionCreateSchema.safeParse({
				name: 'Cook',
				defaultRateMinor: 1500,
			}).success,
		).toBe(false)
		expect(
			staffPositionCreateSchema.safeParse({
				name: 'Cook',
				defaultRateMinor: 1500,
				currency: 'SAR',
			}).success,
		).toBe(true)
		expect(
			staffPositionCreateSchema.safeParse({ name: 'Cook', colorKey: '#ff0000' })
				.success,
		).toBe(false)
	})

	it('assignment updates must change something', () => {
		expect(staffAssignmentUpdateSchema.safeParse({}).success).toBe(false)
		expect(
			staffAssignmentUpdateSchema.safeParse({ pinLookup: 'x' }).success,
		).toBe(false)
		expect(
			staffAssignmentUpdateSchema.safeParse({ active: false }).success,
		).toBe(true)
	})

	it('settings: PIN length stays within 4 to 6', () => {
		for (const pinLength of [3, 7, 4.5, '4']) {
			expect(
				staffingSettingsUpdateSchema.safeParse({ pinLength }).success,
			).toBe(false)
		}
		expect(
			staffingSettingsUpdateSchema.safeParse({ pinLength: 6 }).success,
		).toBe(true)
	})

	it('list query: coerces and bounds paging, refuses control characters', () => {
		expect(staffListQuerySchema.parse({}).limit).toBe(50)
		expect(
			staffListQuerySchema.parse({ limit: '10', offset: '5' }),
		).toMatchObject({
			limit: 10,
			offset: 5,
		})
		expect(staffListQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
		expect(staffListQuerySchema.safeParse({ limit: '201' }).success).toBe(false)
		expect(staffListQuerySchema.safeParse({ q: 'a\u0000b' }).success).toBe(
			false,
		)
		expect(staffListQuerySchema.safeParse({ q: 'omar' }).success).toBe(true)
	})
})
