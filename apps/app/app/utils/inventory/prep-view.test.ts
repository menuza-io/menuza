import { type PrepLevelItem, type PrepTask } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	buildPutLevels,
	demandIsNotable,
	demandPercent,
	doneBody,
	levelDraftProblems,
	levelDraftsChanged,
	levelDraftsFromItem,
	openTaskCount,
	prepColumns,
} from './prep-view.ts'

const task = (over: Partial<PrepTask> = {}): PrepTask => ({
	id: 't1',
	itemId: 'i1',
	itemName: 'Garlic sauce',
	baseUnit: 'ml',
	countUnit: 'l',
	units: [],
	stationId: null,
	businessDate: '2026-11-09',
	plannedQuantity: 8_000_000,
	batchSize: 4_000_000,
	batches: 2,
	explain: {
		fillUpTo: 6_000_000,
		target: 6_000_000,
		onHand: 0,
		demandBp: 10_000,
	},
	status: 'todo',
	startedAt: null,
	doneAt: null,
	madeQuantity: null,
	version: 1,
	...over,
})

const item = (over: Partial<PrepLevelItem> = {}): PrepLevelItem => ({
	itemId: 'i1',
	name: 'Garlic sauce',
	baseUnit: 'ml',
	countUnit: 'l',
	units: [],
	stationId: null,
	weekdays: [null, null, null, null, null, null, null],
	usual: null,
	batchSize: 4_000_000,
	version: 0,
	...over,
})

describe('the board', () => {
	it('groups tasks by where they are and counts what is left', () => {
		const tasks = [
			task({ id: 'a' }),
			task({ id: 'b', status: 'in_progress' }),
			task({ id: 'c', status: 'done' }),
			task({ id: 'd', status: 'skipped' }),
			task({ id: 'e' }),
		]
		const columns = prepColumns(tasks)
		expect(columns.todo.map((entry) => entry.id)).toEqual(['a', 'e'])
		expect(columns.inProgress.map((entry) => entry.id)).toEqual(['b'])
		expect(columns.done.map((entry) => entry.id)).toEqual(['c'])
		expect(columns.skipped.map((entry) => entry.id)).toEqual(['d'])
		expect(openTaskCount(tasks)).toBe(3)
	})
})

describe('how busy the day is', () => {
	it('reads the weekday factor as a whole percent and only mentions a real difference', () => {
		expect(demandPercent(12_000)).toBe(20)
		expect(demandPercent(8_500)).toBe(-15)
		expect(demandPercent(10_000)).toBe(0)
		expect(demandIsNotable(10_300)).toBe(false)
		expect(demandIsNotable(10_500)).toBe(true)
		expect(demandIsNotable(9_000)).toBe(true)
	})
})

describe('weekday levels', () => {
	it('types each weekday in the count unit and sends base thousandths', () => {
		const drafts = levelDraftsFromItem(
			item({ weekdays: [6_000_000, null, 3_500_000, null, null, null, null] }),
		)
		expect(drafts.weekdays).toEqual(['6', '', '3.5', '', '', '', ''])
		const body = buildPutLevels(
			item({ version: 3 }),
			{
				...drafts,
				weekdays: ['6', '', '3.5', '', '', '', '8'],
				stationId: 'grill',
			},
			'main',
		)
		expect(body).toEqual({
			locationId: 'main',
			itemId: 'i1',
			stationId: 'grill',
			weekdays: [6_000_000, null, 3_500_000, null, null, null, 8_000_000],
			expectedVersion: 3,
		})
	})

	it('sends nothing while a weekday is not a number, and says which', () => {
		const base = item()
		const drafts = {
			...levelDraftsFromItem(base),
			weekdays: ['6', 'lots', '', '', '', '', ''],
		}
		expect(levelDraftProblems(base, drafts)).toEqual([1])
		expect(buildPutLevels(base, drafts, 'main')).toBeNull()
	})

	it('tells a change from a no-op', () => {
		const base = item({
			weekdays: [6_000_000, null, null, null, null, null, null],
		})
		const same = levelDraftsFromItem(base)
		expect(levelDraftsChanged(base, same)).toBe(false)
		expect(levelDraftsChanged(base, { ...same, stationId: 'grill' })).toBe(true)
		expect(
			levelDraftsChanged(base, {
				...same,
				weekdays: ['7', '', '', '', '', '', ''],
			}),
		).toBe(true)
	})
})

describe('closing a task', () => {
	it('carries the version the screen read and leaves an empty note out', () => {
		expect(
			doneBody(task({ version: 4 }), {
				clientId: 'client-id-0001',
				made: { kind: 'batches', count: 2 },
				note: '',
			}),
		).toEqual({
			expectedVersion: 4,
			clientId: 'client-id-0001',
			made: { kind: 'batches', count: 2 },
		})
	})
})
