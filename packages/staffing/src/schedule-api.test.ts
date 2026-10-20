import { describe, expect, it } from 'vitest'
import {
	availabilityCreateSchema,
	availabilityDecisionSchema,
	availabilityRowSchema,
	demandQuerySchema,
	publishSchema,
	recommendSchema,
	scheduleDecisionSchema,
	scheduleScopeSchema,
	scheduleSettingsUpdateSchema,
	shiftCreateSchema,
	shiftRequestCreateSchema,
	shiftUpdateSchema,
	templateApplySchema,
	templateCreateSchema,
	timeOffCreateSchema,
	timeOffListQuerySchema,
	weekCopySchema,
	weekQuerySchema,
} from './schedule-api.ts'

const ok = (result: { success: boolean }) => result.success
const base = {
	scopeId: 'loc-1',
	dates: ['2026-03-02'],
	startTime: '09:00',
	endTime: '17:00',
}

describe('shiftCreateSchema', () => {
	it('accepts a plain shift and defaults the break', () => {
		const parsed = shiftCreateSchema.parse(base)
		expect(parsed.unpaidBreakMinutes).toBe(0)
		expect(parsed.staffId).toBeUndefined()
	})
	it('accepts an overnight shift, an open shift and several days', () => {
		expect(
			ok(
				shiftCreateSchema.safeParse({
					...base,
					startTime: '22:00',
					endTime: '02:00',
				}),
			),
		).toBe(true)
		expect(ok(shiftCreateSchema.safeParse({ ...base, staffId: null }))).toBe(
			true,
		)
		expect(
			ok(
				shiftCreateSchema.safeParse({
					...base,
					dates: ['2026-03-02', '2026-03-03', '2026-03-04'],
				}),
			),
		).toBe(true)
	})
	it('refuses bad times, dates and counts', () => {
		expect(
			ok(shiftCreateSchema.safeParse({ ...base, startTime: '9:00' })),
		).toBe(false)
		expect(ok(shiftCreateSchema.safeParse({ ...base, endTime: '24:00' }))).toBe(
			false,
		)
		expect(ok(shiftCreateSchema.safeParse({ ...base, endTime: '17:60' }))).toBe(
			false,
		)
		expect(ok(shiftCreateSchema.safeParse({ ...base, dates: [] }))).toBe(false)
		expect(
			ok(shiftCreateSchema.safeParse({ ...base, dates: ['2026-02-30'] })),
		).toBe(false)
		expect(
			ok(
				shiftCreateSchema.safeParse({
					...base,
					dates: ['2026-03-02', '2026-03-02'],
				}),
			),
		).toBe(false)
		expect(
			ok(
				shiftCreateSchema.safeParse({
					...base,
					dates: Array.from(
						{ length: 32 },
						(_, i) => `2026-03-${String((i % 28) + 1).padStart(2, '0')}`,
					),
				}),
			),
		).toBe(false)
		expect(
			ok(shiftCreateSchema.safeParse({ ...base, unpaidBreakMinutes: -1 })),
		).toBe(false)
		expect(
			ok(shiftCreateSchema.safeParse({ ...base, unpaidBreakMinutes: 721 })),
		).toBe(false)
		expect(
			ok(shiftCreateSchema.safeParse({ ...base, unpaidBreakMinutes: 1.5 })),
		).toBe(false)
		expect(
			ok(shiftCreateSchema.safeParse({ ...base, notes: 'x'.repeat(501) })),
		).toBe(false)
	})
	it('refuses fields it does not know, so a client cannot smuggle status or ids', () => {
		expect(
			ok(shiftCreateSchema.safeParse({ ...base, status: 'published' })),
		).toBe(false)
		expect(
			ok(shiftCreateSchema.safeParse({ ...base, id: 'x', createdBy: 'y' })),
		).toBe(false)
	})
})

describe('shiftUpdateSchema', () => {
	it('needs at least one change and both times together', () => {
		expect(ok(shiftUpdateSchema.safeParse({}))).toBe(false)
		expect(ok(shiftUpdateSchema.safeParse({ expectedVersion: 2 }))).toBe(false)
		expect(ok(shiftUpdateSchema.safeParse({ startTime: '09:00' }))).toBe(false)
		expect(
			ok(shiftUpdateSchema.safeParse({ startTime: '09:00', endTime: '17:00' })),
		).toBe(true)
		expect(ok(shiftUpdateSchema.safeParse({ staffId: null }))).toBe(true)
		expect(ok(shiftUpdateSchema.safeParse({ notes: null }))).toBe(true)
		expect(ok(shiftUpdateSchema.safeParse({ date: '2026-03-03' }))).toBe(true)
		expect(
			ok(shiftUpdateSchema.safeParse({ staffId: 'a', status: 'cancelled' })),
		).toBe(false)
	})
})

describe('week, copy, template, recommend, publish', () => {
	it('parses a week query and a demand query', () => {
		expect(
			ok(weekQuerySchema.safeParse({ scopeId: 'l', date: '2026-03-02' })),
		).toBe(true)
		expect(ok(weekQuerySchema.safeParse({ scopeId: 'l' }))).toBe(false)
		expect(
			ok(demandQuerySchema.safeParse({ scopeId: 'l', date: 'today' })),
		).toBe(false)
	})
	it('defaults the scope to everything and keeps open shifts', () => {
		const parsed = weekCopySchema.parse({
			scopeId: 'l',
			fromWeekStart: '2026-03-02',
			toWeekStart: '2026-03-09',
		})
		expect(parsed.scope).toEqual({ mode: 'all' })
		expect(parsed.includeOpenShifts).toBe(true)
	})
	it('needs ids for position and people scopes', () => {
		expect(
			ok(scheduleScopeSchema.safeParse({ mode: 'positions', positionIds: [] })),
		).toBe(false)
		expect(ok(scheduleScopeSchema.safeParse({ mode: 'people' }))).toBe(false)
		expect(
			ok(scheduleScopeSchema.safeParse({ mode: 'people', staffIds: ['a'] })),
		).toBe(true)
		expect(ok(scheduleScopeSchema.safeParse({ mode: 'everyone' }))).toBe(false)
	})
	it('validates template inputs', () => {
		expect(
			ok(
				templateCreateSchema.safeParse({
					scopeId: 'l',
					name: '  ',
					fromWeekStart: '2026-03-02',
				}),
			),
		).toBe(false)
		const created = templateCreateSchema.parse({
			scopeId: 'l',
			name: ' Slow week ',
			fromWeekStart: '2026-03-02',
		})
		expect(created.name).toBe('Slow week')
		expect(created.keepAssignments).toBe(true)
		expect(
			templateApplySchema.parse({ weekStart: '2026-03-09' }).assignments,
		).toBe('keep')
		expect(
			ok(
				templateApplySchema.safeParse({
					weekStart: '2026-03-09',
					assignments: 'random',
				}),
			),
		).toBe(false)
	})
	it('previews a recommendation unless told to apply it', () => {
		expect(
			recommendSchema.parse({
				scopeId: 'l',
				baseWeekStart: '2026-03-02',
				targetWeekStart: '2026-03-09',
			}).apply,
		).toBe(false)
	})
	it('defaults publishing to notifying only the changed', () => {
		const parsed = publishSchema.parse({
			scopeId: 'l',
			weekStart: '2026-03-02',
		})
		expect(parsed.notifyMode).toBe('changed')
		expect(
			ok(
				publishSchema.safeParse({
					scopeId: 'l',
					weekStart: '2026-03-02',
					notifyMode: 'all',
				}),
			),
		).toBe(false)
	})
	it('bounds the settings', () => {
		expect(ok(scheduleSettingsUpdateSchema.safeParse({}))).toBe(false)
		expect(
			ok(scheduleSettingsUpdateSchema.safeParse({ minRestMinutes: 0 })),
		).toBe(true)
		expect(
			ok(scheduleSettingsUpdateSchema.safeParse({ minRestMinutes: 1441 })),
		).toBe(false)
		expect(
			ok(scheduleSettingsUpdateSchema.safeParse({ timeOffMinNoticeDays: -1 })),
		).toBe(false)
	})
})

describe('timeOffCreateSchema', () => {
	const off = { staffId: 's', startDate: '2026-03-02', endDate: '2026-03-04' }
	it('defaults to a whole-day request entered by a manager', () => {
		const parsed = timeOffCreateSchema.parse(off)
		expect(parsed).toMatchObject({
			allDay: true,
			category: 'unpaid',
			submission: 'manager_entered',
		})
	})
	it('refuses an end before the start', () => {
		expect(
			ok(timeOffCreateSchema.safeParse({ ...off, endDate: '2026-03-01' })),
		).toBe(false)
	})
	it('needs times for a part day, on one date, ending after they start', () => {
		const part = {
			staffId: 's',
			startDate: '2026-03-02',
			endDate: '2026-03-02',
			allDay: false,
			startTime: '13:00',
			endTime: '15:00',
		}
		expect(ok(timeOffCreateSchema.safeParse(part))).toBe(true)
		expect(
			ok(timeOffCreateSchema.safeParse({ ...part, endTime: '24:00' })),
		).toBe(true)
		expect(
			ok(timeOffCreateSchema.safeParse({ ...part, endTime: '13:00' })),
		).toBe(false)
		expect(
			ok(timeOffCreateSchema.safeParse({ ...part, endTime: undefined })),
		).toBe(false)
		expect(
			ok(timeOffCreateSchema.safeParse({ ...part, endDate: '2026-03-03' })),
		).toBe(false)
		expect(
			ok(timeOffCreateSchema.safeParse({ ...off, startTime: '09:00' })),
		).toBe(false)
	})
	it('refuses an unknown category, submission or field', () => {
		expect(
			ok(timeOffCreateSchema.safeParse({ ...off, category: 'holiday' })),
		).toBe(false)
		expect(
			ok(timeOffCreateSchema.safeParse({ ...off, submission: 'auto' })),
		).toBe(false)
		expect(
			ok(timeOffCreateSchema.safeParse({ ...off, status: 'approved' })),
		).toBe(false)
	})
	it('coerces list limits from a query string', () => {
		expect(timeOffListQuerySchema.parse({ limit: '25' }).limit).toBe(25)
		expect(timeOffListQuerySchema.parse({}).limit).toBe(200)
		expect(ok(timeOffListQuerySchema.safeParse({ limit: '0' }))).toBe(false)
		expect(ok(timeOffListQuerySchema.safeParse({ limit: '501' }))).toBe(false)
		expect(ok(timeOffListQuerySchema.safeParse({ status: 'maybe' }))).toBe(
			false,
		)
	})
})

describe('availability', () => {
	it('accepts a weekly all-day block and a timed one-off window', () => {
		expect(
			ok(
				availabilityRowSchema.safeParse({
					kind: 'weekly',
					weekday: 1,
					availability: 'unavailable',
				}),
			),
		).toBe(true)
		expect(
			ok(
				availabilityRowSchema.safeParse({
					kind: 'one_off',
					date: '2026-03-02',
					availability: 'available',
					allDay: false,
					startTime: '09:00',
					endTime: '24:00',
				}),
			),
		).toBe(true)
	})
	it('keeps weekly and one-off fields apart', () => {
		expect(
			ok(
				availabilityRowSchema.safeParse({
					kind: 'weekly',
					availability: 'unavailable',
				}),
			),
		).toBe(false)
		expect(
			ok(
				availabilityRowSchema.safeParse({
					kind: 'weekly',
					weekday: 7,
					availability: 'unavailable',
				}),
			),
		).toBe(false)
		expect(
			ok(
				availabilityRowSchema.safeParse({
					kind: 'weekly',
					weekday: 1,
					date: '2026-03-02',
					availability: 'unavailable',
				}),
			),
		).toBe(false)
		expect(
			ok(
				availabilityRowSchema.safeParse({
					kind: 'one_off',
					availability: 'unavailable',
				}),
			),
		).toBe(false)
		expect(
			ok(
				availabilityRowSchema.safeParse({
					kind: 'one_off',
					weekday: 1,
					date: '2026-03-02',
					availability: 'unavailable',
				}),
			),
		).toBe(false)
		expect(
			ok(
				availabilityRowSchema.safeParse({
					kind: 'one_off',
					date: '2026-03-02',
					availability: 'unavailable',
					effectiveFrom: '2026-03-01',
				}),
			),
		).toBe(false)
	})
	it('needs sensible times and effective dates', () => {
		const timed = {
			kind: 'weekly',
			weekday: 1,
			availability: 'available',
			allDay: false,
		} as const
		expect(
			ok(
				availabilityRowSchema.safeParse({
					...timed,
					startTime: '09:00',
					endTime: '17:00',
				}),
			),
		).toBe(true)
		expect(
			ok(
				availabilityRowSchema.safeParse({
					...timed,
					startTime: '17:00',
					endTime: '09:00',
				}),
			),
		).toBe(false)
		expect(
			ok(availabilityRowSchema.safeParse({ ...timed, startTime: '09:00' })),
		).toBe(false)
		expect(
			ok(
				availabilityRowSchema.safeParse({
					kind: 'weekly',
					weekday: 1,
					availability: 'available',
					startTime: '09:00',
					endTime: '17:00',
				}),
			),
		).toBe(false)
		expect(
			ok(
				availabilityRowSchema.safeParse({
					kind: 'weekly',
					weekday: 1,
					availability: 'unavailable',
					effectiveFrom: '2026-03-09',
					effectiveTo: '2026-03-01',
				}),
			),
		).toBe(false)
	})
	it('bounds a batch and its decision', () => {
		const row = { kind: 'weekly', weekday: 1, availability: 'unavailable' }
		expect(
			ok(availabilityCreateSchema.safeParse({ staffId: 's', rows: [] })),
		).toBe(false)
		expect(
			ok(
				availabilityCreateSchema.safeParse({
					staffId: 's',
					rows: Array.from({ length: 51 }, () => row),
				}),
			),
		).toBe(false)
		expect(
			availabilityCreateSchema.parse({ staffId: 's', rows: [row] }),
		).toMatchObject({ submission: 'manager_entered', replaceWeekly: false })
		expect(
			ok(
				availabilityDecisionSchema.safeParse({ ids: [], decision: 'approve' }),
			),
		).toBe(false)
		expect(
			ok(
				availabilityDecisionSchema.safeParse({ ids: ['a'], decision: 'maybe' }),
			),
		).toBe(false)
		expect(
			ok(
				scheduleDecisionSchema.safeParse({
					decision: 'reject',
					note: 'Short staffed',
				}),
			),
		).toBe(true)
	})
})

describe('shiftRequestCreateSchema', () => {
	const req = { shiftId: 'x', requesterStaffId: 'a' }
	it('needs the other person and shift for a swap', () => {
		expect(
			ok(shiftRequestCreateSchema.safeParse({ ...req, kind: 'swap' })),
		).toBe(false)
		expect(
			ok(
				shiftRequestCreateSchema.safeParse({
					...req,
					kind: 'swap',
					targetStaffId: 'b',
				}),
			),
		).toBe(false)
		expect(
			ok(
				shiftRequestCreateSchema.safeParse({
					...req,
					kind: 'swap',
					targetStaffId: 'b',
					targetShiftId: 'y',
				}),
			),
		).toBe(true)
	})
	it('needs the person taking a cover, and no second shift', () => {
		expect(
			ok(shiftRequestCreateSchema.safeParse({ ...req, kind: 'cover' })),
		).toBe(false)
		expect(
			ok(
				shiftRequestCreateSchema.safeParse({
					...req,
					kind: 'cover',
					targetStaffId: 'b',
				}),
			),
		).toBe(true)
		expect(
			ok(
				shiftRequestCreateSchema.safeParse({
					...req,
					kind: 'cover',
					targetStaffId: 'b',
					targetShiftId: 'y',
				}),
			),
		).toBe(false)
	})
	it('lets a drop name nobody', () => {
		expect(
			ok(shiftRequestCreateSchema.safeParse({ ...req, kind: 'drop' })),
		).toBe(true)
		expect(
			ok(
				shiftRequestCreateSchema.safeParse({
					...req,
					kind: 'drop',
					targetStaffId: 'b',
				}),
			),
		).toBe(false)
		expect(
			shiftRequestCreateSchema.parse({ ...req, kind: 'drop' }).submission,
		).toBe('staff_request')
	})
})
