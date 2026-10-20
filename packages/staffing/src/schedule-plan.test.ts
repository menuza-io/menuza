import { describe, expect, it } from 'vitest'
import { NEUTRAL_LABOR_RULES } from './rules.ts'
import {
	type AvailabilityWindow,
	type ConflictShift,
	type PersonConflictContext,
} from './schedule-conflicts.ts'
import {
	dateForWeekday,
	inScope,
	type PlanShift,
	planCopyWeek,
	planRecommendation,
	planTemplateApply,
	projectShift,
	shiftIdentity,
	slotsFromShifts,
} from './schedule-plan.ts'
import { type ScheduleScope } from './schedule-api.ts'
import { minuteOfDayFromHhmm, resolveShiftWindow } from './schedule-time.ts'

const CHI = 'America/Chicago'
const RIYADH = 'Asia/Riyadh'

function plan(
	id: string,
	date: string,
	start: string,
	end: string,
	overrides: Partial<PlanShift> = {},
	tz = CHI,
): PlanShift {
	const result = resolveShiftWindow({
		date,
		startMinute: minuteOfDayFromHhmm(start),
		endMinute: minuteOfDayFromHhmm(end),
		timeZone: tz,
	})
	if (!result.ok) throw new Error('bad fixture')
	return {
		id,
		staffId: 'ana',
		positionId: 'cook',
		startsAt: result.window.startsAt,
		endsAt: result.window.endsAt,
		localDate: date,
		unpaidBreakMinutes: 0,
		notes: null,
		...overrides,
	}
}

const ALL = { mode: 'all' } as const

describe('inScope', () => {
	const assigned = { staffId: 'ana', positionId: 'cook' }
	const open = { staffId: null, positionId: 'cook' }
	it('takes everything for the all scope, open shifts only when asked', () => {
		expect(inScope(assigned, ALL, true)).toBe(true)
		expect(inScope(open, ALL, true)).toBe(true)
		expect(inScope(open, ALL, false)).toBe(false)
	})
	it('filters by position and keeps open shifts of the position', () => {
		const scope: ScheduleScope = { mode: 'positions', positionIds: ['cook'] }
		expect(inScope(assigned, scope, true)).toBe(true)
		expect(inScope(open, scope, true)).toBe(true)
		expect(inScope(open, scope, false)).toBe(false)
		expect(inScope({ staffId: 'ana', positionId: 'bar' }, scope, true)).toBe(
			false,
		)
		expect(inScope({ staffId: 'ana', positionId: null }, scope, true)).toBe(
			false,
		)
	})
	it('filters by person and never takes an open shift', () => {
		const scope: ScheduleScope = { mode: 'people', staffIds: ['ana'] }
		expect(inScope(assigned, scope, true)).toBe(true)
		expect(inScope({ staffId: 'bo', positionId: 'cook' }, scope, true)).toBe(
			false,
		)
		expect(inScope(open, scope, true)).toBe(false)
	})
})

describe('projectShift', () => {
	it('keeps the weekday and the wall-clock time', () => {
		const friday = plan('f', '2026-02-27', '09:00', '17:00') // Monday week of 02-23
		const moved = projectShift({
			shift: friday,
			fromWeekStart: '2026-02-23',
			toWeekStart: '2026-03-09',
			timeZone: CHI,
		})
		expect(moved).toMatchObject({ localDate: '2026-03-13', sourceShiftId: 'f' })
		const check = projectShift({
			shift: plan('m', '2026-02-23', '09:00', '17:00'),
			fromWeekStart: '2026-02-23',
			toWeekStart: '2026-03-09',
			timeZone: CHI,
		})
		// 09:00 CDT is 14:00Z, where the source (CST) was 15:00Z.
		expect(new Date(check!.startsAt).toISOString()).toBe(
			'2026-03-09T14:00:00.000Z',
		)
	})

	it('returns null for a shift that is not in the source week', () => {
		expect(
			projectShift({
				shift: plan('x', '2026-03-10', '09:00', '17:00'),
				fromWeekStart: '2026-02-23',
				toWeekStart: '2026-03-09',
				timeZone: CHI,
			}),
		).toBeNull()
	})

	it('keeps an overnight shift overnight and puts it on the clock-change night with its real length', () => {
		const sat = plan('night', '2026-02-28', '22:00', '06:00')
		const moved = projectShift({
			shift: sat,
			fromWeekStart: '2026-02-23',
			toWeekStart: '2026-03-02',
			timeZone: CHI,
		})
		expect(moved!.localDate).toBe('2026-03-07')
		expect((moved!.endsAt - moved!.startsAt) / 60_000).toBe(420)
	})

	it('is identical wall-clock for Riyadh', () => {
		const sun = plan('s', '2026-03-01', '16:00', '23:30', {}, RIYADH)
		const moved = projectShift({
			shift: sun,
			fromWeekStart: '2026-03-01',
			toWeekStart: '2026-03-08',
			timeZone: RIYADH,
		})
		expect(moved!.startsAt - sun.startsAt).toBe(7 * 86_400_000)
		expect(moved!.endsAt - moved!.startsAt).toBe(sun.endsAt - sun.startsAt)
	})
})

describe('planCopyWeek', () => {
	const sources = [
		plan('1', '2026-03-02', '09:00', '17:00'),
		plan('2', '2026-03-02', '17:00', '23:00', {
			staffId: 'bo',
			positionId: 'bar',
		}),
		plan('3', '2026-03-03', '09:00', '17:00', { staffId: null }),
		plan('4', '2026-03-03', '11:00', '14:00', { staffId: 'ana' }), // split day
	]
	const base = {
		sources,
		existing: [],
		fromWeekStart: '2026-03-02',
		toWeekStart: '2026-03-09',
		timeZone: CHI,
		includeOpenShifts: true,
	}

	it('copies everything, including open shifts and split days', () => {
		const result = planCopyWeek({ ...base, scope: ALL })
		expect(result.create).toHaveLength(4)
		expect(result.create.filter((s) => s.staffId === null)).toHaveLength(1)
		expect(result.skippedDuplicates).toBe(0)
		expect(result.create.map((s) => s.localDate)).toEqual([
			'2026-03-09',
			'2026-03-09',
			'2026-03-10',
			'2026-03-10',
		])
	})

	it('can leave open shifts behind', () => {
		const result = planCopyWeek({
			...base,
			scope: ALL,
			includeOpenShifts: false,
		})
		expect(result.create.some((s) => s.staffId === null)).toBe(false)
		expect(result.create).toHaveLength(3)
	})

	it('copies only the chosen positions', () => {
		const result = planCopyWeek({
			...base,
			scope: { mode: 'positions', positionIds: ['bar'] },
		})
		expect(result.create).toHaveLength(1)
		expect(result.create[0]).toMatchObject({ staffId: 'bo', positionId: 'bar' })
	})

	it('copies only the chosen people', () => {
		const result = planCopyWeek({
			...base,
			scope: { mode: 'people', staffIds: ['ana'] },
		})
		expect(result.create.map((s) => s.sourceShiftId)).toEqual(['1', '4'])
	})

	it('skips a shift already in the target week, so a copy can be repeated safely', () => {
		const first = planCopyWeek({ ...base, scope: ALL })
		const second = planCopyWeek({ ...base, scope: ALL, existing: first.create })
		expect(second.create).toEqual([])
		expect(second.skippedDuplicates).toBe(4)
	})

	it('does not create the same shift twice from identical sources', () => {
		const twin = plan('1b', '2026-03-02', '09:00', '17:00')
		const result = planCopyWeek({
			...base,
			sources: [sources[0]!, twin],
			scope: ALL,
		})
		expect(result.create).toHaveLength(1)
		expect(result.skippedDuplicates).toBe(1)
	})

	it('counts shifts outside the source week instead of guessing', () => {
		const stray = plan('stray', '2026-03-12', '09:00', '17:00')
		const result = planCopyWeek({ ...base, sources: [stray], scope: ALL })
		expect(result.create).toEqual([])
		expect(result.skippedUnplaceable).toBe(1)
	})

	it('is deterministic whatever order the sources arrive in', () => {
		const forward = planCopyWeek({ ...base, scope: ALL })
		const backward = planCopyWeek({
			...base,
			sources: [...sources].reverse(),
			scope: ALL,
		})
		expect(backward).toEqual(forward)
	})

	it('copies a Sunday-start week as faithfully as a Monday one', () => {
		const sun = plan('sun', '2026-03-01', '10:00', '18:00')
		const result = planCopyWeek({
			sources: [sun],
			existing: [],
			fromWeekStart: '2026-03-01',
			toWeekStart: '2026-03-08',
			timeZone: CHI,
			scope: ALL,
			includeOpenShifts: true,
		})
		expect(result.create[0]!.localDate).toBe('2026-03-08')
	})
})

describe('templates', () => {
	const shifts = [
		plan('a', '2026-03-02', '09:00', '17:00', { notes: 'Opening' }),
		plan('b', '2026-03-06', '22:00', '03:00', {
			staffId: 'bo',
			unpaidBreakMinutes: 30,
		}),
		plan('c', '2026-03-03', '12:00', '16:00', {
			staffId: null,
			positionId: 'bar',
		}),
	]

	it('turns a week into weekday slots, optionally dropping the people', () => {
		const kept = slotsFromShifts({
			shifts,
			timeZone: CHI,
			scope: ALL,
			keepAssignments: true,
		})
		expect(kept).toHaveLength(3)
		expect(kept.find((s) => s.notes === 'Opening')).toMatchObject({
			weekday: 1,
			startMinute: 540,
			endDayOffset: 0,
			endMinute: 1020,
			staffId: 'ana',
		})
		expect(kept.find((s) => s.staffId === 'bo')).toMatchObject({
			weekday: 5,
			endDayOffset: 1,
			endMinute: 180,
			unpaidBreakMinutes: 30,
		})
		const open = slotsFromShifts({
			shifts,
			timeZone: CHI,
			scope: ALL,
			keepAssignments: false,
		})
		expect(open.every((s) => s.staffId === null)).toBe(true)
	})

	it('honors scope when building a template', () => {
		const slots = slotsFromShifts({
			shifts,
			timeZone: CHI,
			scope: { mode: 'positions', positionIds: ['bar'] },
			keepAssignments: true,
		})
		expect(slots).toHaveLength(1)
		expect(slots[0]!.positionId).toBe('bar')
	})

	it('finds the date of a weekday in a Monday or Sunday week', () => {
		expect(dateForWeekday('2026-03-02', 1)).toBe('2026-03-02')
		expect(dateForWeekday('2026-03-02', 0)).toBe('2026-03-08')
		expect(dateForWeekday('2026-03-01', 0)).toBe('2026-03-01')
		expect(dateForWeekday('2026-03-01', 6)).toBe('2026-03-07')
	})

	it('applies slots to any week, with or without the people, keeping wall-clock times', () => {
		const slots = slotsFromShifts({
			shifts,
			timeZone: CHI,
			scope: ALL,
			keepAssignments: true,
		})
		const keep = planTemplateApply({
			slots,
			weekStart: '2026-03-09',
			timeZone: CHI,
			assignments: 'keep',
			existing: [],
		})
		expect(keep.create).toHaveLength(3)
		const opening = keep.create.find((s) => s.notes === 'Opening')!
		expect(opening.localDate).toBe('2026-03-09')
		expect(new Date(opening.startsAt).toISOString()).toBe(
			'2026-03-09T14:00:00.000Z',
		) // 09:00 CDT
		const open = planTemplateApply({
			slots,
			weekStart: '2026-03-09',
			timeZone: CHI,
			assignments: 'open',
			existing: [],
		})
		expect(open.create.every((s) => s.staffId === null)).toBe(true)
	})

	it('applies a Monday-made template to a Sunday-start week', () => {
		const slots = slotsFromShifts({
			shifts: [shifts[0]!],
			timeZone: CHI,
			scope: ALL,
			keepAssignments: true,
		})
		const result = planTemplateApply({
			slots,
			weekStart: '2026-03-08',
			timeZone: CHI,
			assignments: 'keep',
			existing: [],
		})
		expect(result.create[0]!.localDate).toBe('2026-03-09')
	})

	it('does not apply a template twice over the same week', () => {
		const slots = slotsFromShifts({
			shifts,
			timeZone: CHI,
			scope: ALL,
			keepAssignments: true,
		})
		const first = planTemplateApply({
			slots,
			weekStart: '2026-03-09',
			timeZone: CHI,
			assignments: 'keep',
			existing: [],
		})
		const again = planTemplateApply({
			slots,
			weekStart: '2026-03-09',
			timeZone: CHI,
			assignments: 'keep',
			existing: first.create,
		})
		expect(again.create).toEqual([])
		expect(again.skippedDuplicates).toBe(3)
	})

	it('puts an overnight slot on the clock-change night with its real length', () => {
		const slots = slotsFromShifts({
			shifts: [plan('n', '2026-02-28', '22:00', '06:00')],
			timeZone: CHI,
			scope: ALL,
			keepAssignments: true,
		})
		const result = planTemplateApply({
			slots,
			weekStart: '2026-03-02',
			timeZone: CHI,
			assignments: 'keep',
			existing: [],
		})
		expect(
			(result.create[0]!.endsAt - result.create[0]!.startsAt) / 60_000,
		).toBe(420)
	})
})

describe('planRecommendation', () => {
	const LOC = 'loc-1'
	const person = (
		overrides: Partial<PersonConflictContext> = {},
	): PersonConflictContext => ({
		status: 'active',
		assignedScopeIds: new Set([LOC]),
		jobs: [
			{
				scopeId: LOC,
				positionId: 'cook',
				effectiveFrom: '2020-01-01',
				effectiveTo: null,
			},
			{
				scopeId: LOC,
				positionId: 'bar',
				effectiveFrom: '2020-01-01',
				effectiveTo: null,
			},
		],
		timeOff: [],
		availability: [],
		...overrides,
	})
	const sources = [
		plan('1', '2026-03-02', '09:00', '17:00', { staffId: 'ana' }),
		plan('2', '2026-03-03', '09:00', '17:00', { staffId: 'ana' }),
		plan('3', '2026-03-04', '09:00', '17:00', { staffId: 'bo' }),
		plan('4', '2026-03-05', '09:00', '17:00', { staffId: null }),
	]
	const base = {
		sources,
		existingByStaff: new Map<string, readonly ConflictShift[]>(),
		existingTarget: [],
		fromWeekStart: '2026-03-02',
		toWeekStart: '2026-03-09',
		timeZone: CHI,
		scopeId: LOC,
		scope: ALL,
		includeOpenShifts: true,
		rules: NEUTRAL_LABOR_RULES,
	} as const

	it('keeps everyone where nothing conflicts', () => {
		const result = planRecommendation({
			...base,
			people: new Map([
				['ana', person()],
				['bo', person()],
			]),
		})
		expect(result.opened).toBe(0)
		expect(result.shifts.map((s) => s.staffId)).toEqual([
			'ana',
			'ana',
			'bo',
			null,
		])
		expect(result.shifts.every((s) => s.openReason === undefined)).toBe(true)
	})

	it('adds nothing the second time: an existing identical shift is a duplicate, not a double booking', () => {
		const people = new Map([
			['ana', person()],
			['bo', person()],
		])
		const first = planRecommendation({ ...base, people })
		const existing = first.shifts.map((s) => ({
			staffId: s.staffId,
			positionId: s.positionId,
			startsAt: s.startsAt,
			endsAt: s.endsAt,
		}))
		const existingByStaff = new Map<string, ConflictShift[]>()
		for (const [index, s] of first.shifts.entries()) {
			if (!s.staffId) continue
			const list = existingByStaff.get(s.staffId) ?? []
			list.push({
				id: `e${index}`,
				scopeId: LOC,
				positionId: s.positionId,
				startsAt: s.startsAt,
				endsAt: s.endsAt,
				localDate: s.localDate,
				timeZone: CHI,
				unpaidBreakMinutes: 0,
			})
			existingByStaff.set(s.staffId, list)
		}
		const second = planRecommendation({
			...base,
			people,
			existingTarget: existing,
			existingByStaff,
		})
		expect(second.shifts).toEqual([])
		expect(second.skippedDuplicates).toBe(4)
		expect(second.opened).toBe(0)
	})

	it('opens a shift on a day of approved time off and says why', () => {
		const ana = person({
			timeOff: [
				{
					id: 'off',
					startDate: '2026-03-10',
					endDate: '2026-03-10',
					allDay: true,
					startMinute: null,
					endMinute: null,
				},
			],
		})
		const result = planRecommendation({
			...base,
			people: new Map([
				['ana', ana],
				['bo', person()],
			]),
		})
		expect(result.opened).toBe(1)
		expect(result.shifts[1]).toMatchObject({
			staffId: null,
			openReason: 'time_off',
			previousStaffId: 'ana',
			localDate: '2026-03-10',
		})
		expect(result.shifts[0]).toMatchObject({ staffId: 'ana' })
	})

	it('opens a shift outside approved availability', () => {
		const bo: AvailabilityWindow = {
			id: 'av',
			kind: 'weekly',
			weekday: 3,
			date: null,
			availability: 'unavailable',
			allDay: true,
			startMinute: null,
			endMinute: null,
			effectiveFrom: null,
			effectiveTo: null,
		}
		const result = planRecommendation({
			...base,
			people: new Map([
				['ana', person()],
				['bo', person({ availability: [bo] })],
			]),
		})
		expect(result.shifts[2]).toMatchObject({
			staffId: null,
			openReason: 'unavailable',
			previousStaffId: 'bo',
		})
	})

	it('opens a shift for someone who is gone, never assigned here, or no longer holds the position', () => {
		const people = new Map([
			['ana', person({ status: 'terminated' })],
			['bo', person({ assignedScopeIds: new Set(['loc-9']) })],
		])
		const result = planRecommendation({ ...base, people })
		expect(result.shifts.map((s) => s.openReason)).toEqual([
			'inactive',
			'inactive',
			'not_at_scope',
			undefined,
		])
		const missing = planRecommendation({
			...base,
			people: new Map([['bo', person()]]),
		})
		expect(missing.shifts[0]!.openReason).toBe('inactive')
		const noPosition = planRecommendation({
			...base,
			people: new Map([
				['ana', person({ jobs: [] })],
				['bo', person()],
			]),
		})
		expect(noPosition.shifts[0]!.openReason).toBe('position_mismatch')
	})

	it('opens the later shift when two shifts for one person would overlap', () => {
		const sources = [
			plan('1', '2026-03-02', '09:00', '17:00', { staffId: 'ana' }),
			plan('2', '2026-03-02', '16:00', '22:00', { staffId: 'ana' }),
		]
		const result = planRecommendation({
			...base,
			sources,
			people: new Map([['ana', person()]]),
		})
		expect(result.shifts.map((s) => [s.staffId, s.openReason])).toEqual([
			['ana', undefined],
			[null, 'overlap'],
		])
	})

	it('opens a shift that overlaps one the person already has elsewhere', () => {
		const existing: ConflictShift = {
			id: 'e',
			scopeId: 'loc-2',
			positionId: 'cook',
			startsAt: Date.UTC(2026, 2, 9, 14, 0),
			endsAt: Date.UTC(2026, 2, 9, 22, 0),
			localDate: '2026-03-09',
			timeZone: CHI,
			unpaidBreakMinutes: 0,
		}
		const result = planRecommendation({
			...base,
			existingByStaff: new Map([['ana', [existing]]]),
			people: new Map([
				['ana', person()],
				['bo', person()],
			]),
		})
		expect(result.shifts[0]).toMatchObject({
			staffId: null,
			openReason: 'overlap',
		})
	})

	it('leaves overtime and short rest as warnings instead of taking the shift away', () => {
		const rules = {
			...NEUTRAL_LABOR_RULES,
			weeklyOvertime: { thresholdMinutes: 60, multiplierBp: 15000 },
		}
		const result = planRecommendation({
			...base,
			rules,
			people: new Map([
				['ana', person()],
				['bo', person()],
			]),
		})
		expect(result.opened).toBe(0)
	})

	it('only considers the chosen scope and skips what already exists', () => {
		const people = new Map([
			['ana', person()],
			['bo', person()],
		])
		const scoped = planRecommendation({
			...base,
			scope: { mode: 'people', staffIds: ['bo'] },
			people,
		})
		expect(scoped.shifts).toHaveLength(1)
		const first = planRecommendation({ ...base, people })
		const again = planRecommendation({
			...base,
			people,
			existingTarget: first.shifts,
		})
		expect(again.shifts).toEqual([])
		expect(again.skippedDuplicates).toBe(4)
	})

	it('gives the same answer every time', () => {
		const people = new Map([
			['ana', person()],
			['bo', person()],
		])
		expect(planRecommendation({ ...base, people })).toEqual(
			planRecommendation({ ...base, sources: [...sources].reverse(), people }),
		)
	})
})

describe('shiftIdentity', () => {
	it('separates open from assigned and one position from another', () => {
		const a = { staffId: 'x', positionId: 'p', startsAt: 1, endsAt: 2 }
		expect(shiftIdentity(a)).toBe(shiftIdentity({ ...a }))
		expect(shiftIdentity(a)).not.toBe(shiftIdentity({ ...a, staffId: null }))
		expect(shiftIdentity(a)).not.toBe(shiftIdentity({ ...a, positionId: null }))
	})
})
