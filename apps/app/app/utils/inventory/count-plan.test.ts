import { describe, expect, it } from 'vitest'
import {
	assigneeValue,
	buildCreateSchedule,
	buildUpdateSchedule,
	emptyScheduleForm,
	formFromSchedule,
	NO_ASSIGNEE,
	parseAssignee,
	scheduleFormProblem,
	SLOT_DEFAULT_TIME,
	weekdayName,
	weekdaysText,
} from './count-plan.ts'

const schedule = {
	id: 's1',
	locationId: 'main',
	kind: 'full' as const,
	listId: 'list_1',
	listName: 'Proteins',
	slot: 'opening' as const,
	timeLocal: '08:00',
	weekdays: [1, 3, 5],
	assignee: { kind: 'staff' as const, id: 'staff_1' },
	effectiveFrom: '2026-11-24',
	version: 4,
}

describe('the weekly count plan form', () => {
	it('starts as a quick count of the key items at close, every day, with nobody responsible', () => {
		expect(emptyScheduleForm()).toEqual({
			kind: 'quick',
			listId: '',
			slot: 'close',
			timeLocal: SLOT_DEFAULT_TIME.close,
			weekdays: [0, 1, 2, 3, 4, 5, 6],
			assignee: NO_ASSIGNEE,
		})
	})

	it('builds the create request: a count list is a full count of that list, the key items a quick count', () => {
		const base = { locationId: 'main', clientId: 'client-12345678' }
		expect(
			buildCreateSchedule(
				{ ...emptyScheduleForm(), weekdays: [5, 1, 3], assignee: 'member:u1' },
				base,
			),
		).toEqual({
			...base,
			kind: 'quick',
			listId: null,
			slot: 'close',
			timeLocal: '22:00',
			weekdays: [1, 3, 5],
			assignee: { kind: 'member', id: 'u1' },
		})
		expect(
			buildCreateSchedule(
				{ ...emptyScheduleForm(), kind: 'list', listId: 'list_1' },
				base,
			),
		).toMatchObject({ kind: 'full', listId: 'list_1', assignee: null })
	})

	it('reads an existing schedule back into the form, and sends only what can change, with the version it saw', () => {
		const form = formFromSchedule(schedule)
		expect(form).toMatchObject({
			kind: 'list',
			listId: 'list_1',
			assignee: 'staff:staff_1',
		})
		expect(
			buildUpdateSchedule({ ...form, timeLocal: '09:30' }, schedule),
		).toEqual({
			expectedVersion: 4,
			listId: 'list_1',
			slot: 'opening',
			timeLocal: '09:30',
			weekdays: [1, 3, 5],
			assignee: { kind: 'staff', id: 'staff_1' },
		})
	})

	it('round-trips an assignee and treats anything else as nobody', () => {
		expect(parseAssignee(assigneeValue({ kind: 'member', id: 'a:b' }))).toEqual(
			{
				kind: 'member',
				id: 'a:b',
			},
		)
		expect(parseAssignee(NO_ASSIGNEE)).toBeNull()
		expect(parseAssignee('robot:1')).toBeNull()
	})

	it('says what is wrong before it is sent', () => {
		const ok = emptyScheduleForm()
		expect(scheduleFormProblem(ok)).toBeNull()
		expect(scheduleFormProblem({ ...ok, timeLocal: '25:00' })).toBe('time')
		expect(scheduleFormProblem({ ...ok, timeLocal: '9:00' })).toBe('time')
		expect(scheduleFormProblem({ ...ok, weekdays: [] })).toBe('weekdays')
		expect(scheduleFormProblem({ ...ok, kind: 'list', listId: '' })).toBe(
			'list',
		)
	})

	it('names the days in the viewer language and says "every day" in words', () => {
		expect(weekdayName(0, 'en')).toBe('Sun')
		expect(weekdayName(6, 'en', 'long')).toBe('Saturday')
		expect(weekdaysText([0, 1, 2, 3, 4, 5, 6], 'en')).toBeNull()
		expect(weekdaysText([1, 3], 'en')).toBe('Mon & Wed')
		expect(weekdayName(1, 'ar')).not.toBe('Mon')
	})
})
