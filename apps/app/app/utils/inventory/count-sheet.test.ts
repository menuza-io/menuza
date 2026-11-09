import { type CountSheet } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import { type QueuedEntry } from './count-queue.ts'
import {
	areaTabKey,
	countProgress,
	initialRowAmounts,
	initialSheetAmounts,
	isRowCounted,
	NO_AREA_TAB,
	othersQuantity,
	rowKey,
	rowSaveState,
	rowUnitChoices,
	sheetTabs,
	tabProgress,
} from './count-sheet.ts'

const COUNT = {
	id: 'cnt_1',
	locationId: 'main',
	listId: null,
	listName: null,
	status: 'counting' as const,
	businessDate: '2026-11-08',
	startedBy: { kind: 'operator' as const, id: 'u1' },
	itemTotal: 3,
	itemsCounted: 0,
	counters: [],
	sentForReviewAt: null,
	approvedAt: null,
	approvedBy: null,
	cancelledAt: null,
	createdAt: 1,
	version: 1,
}

function sheetItem(
	itemId: string,
	overrides: Partial<CountSheet['areas'][number]['items'][number]> = {},
) {
	return {
		itemId,
		name: `Item ${itemId}`,
		baseUnit: 'g' as const,
		countUnit: 'kg' as const,
		units: [],
		quantity: null,
		mine: null,
		...overrides,
	}
}

const SHEET: CountSheet = {
	count: COUNT,
	areas: [
		{
			areaId: 'a1',
			name: 'Walk-in',
			items: [sheetItem('i1'), sheetItem('i2')],
		},
		{ areaId: 'a2', name: 'Dry store', items: [sheetItem('i2')] },
		{ areaId: 'a3', name: 'Empty shelf', items: [] },
		{ areaId: null, name: null, items: [sheetItem('i3')] },
	],
}

describe('sheetTabs', () => {
	it('keeps the walking order, leaves out empty areas and puts the rest last', () => {
		const tabs = sheetTabs(SHEET)
		expect(tabs.map((tab) => tab.key)).toEqual(['a1', 'a2', NO_AREA_TAB])
		expect(tabs[0]!.rows.map((row) => row.key)).toEqual(['i1|a1', 'i2|a1'])
		expect(areaTabKey(null)).toBe(NO_AREA_TAB)
		expect(rowKey('i3', null)).toBe('i3|')
	})
})

describe('blank fields', () => {
	it('starts blank: nothing typed, even where the region has no entry', () => {
		const tabs = sheetTabs(SHEET)
		expect(initialSheetAmounts(tabs, [])).toEqual({})
	})

	it('shows back only what this person typed here, never anyone else total', () => {
		const sheet: CountSheet = {
			...SHEET,
			areas: [
				{
					areaId: 'a1',
					name: 'Walk-in',
					items: [
						sheetItem('i1', {
							quantity: 5_000,
							mine: { amount: 2.5, unit: 'kg' },
						}),
						sheetItem('i2', { quantity: 4_000, mine: null }),
					],
				},
			],
		}
		const amounts = initialSheetAmounts(sheetTabs(sheet), [])
		expect(amounts).toEqual({ 'i1|a1': { kg: 2.5 } })
	})

	it('puts a queued entry over what the region last had', () => {
		const queued: QueuedEntry[] = [
			{
				clientId: 'q1',
				itemId: 'i1',
				areaId: 'a1',
				amount: 7,
				unit: 'kg',
				queuedAt: 5,
			},
			{
				clientId: 'q2',
				itemId: 'i1',
				areaId: 'a2',
				amount: 9,
				unit: 'kg',
				queuedAt: 6,
			},
		]
		expect(
			initialRowAmounts(
				{ itemId: 'i1', areaId: 'a1', mine: { amount: 1, unit: 'kg' } },
				queued,
			),
		).toEqual({ kg: 7 })
	})

	it('restores a second unit from the queue (2 boxes and 3 kg)', () => {
		const queued: QueuedEntry[] = [
			{
				clientId: 'q1',
				itemId: 'i1',
				areaId: 'a1',
				amount: 3,
				unit: 'kg',
				queuedAt: 5,
			},
		]
		expect(
			initialRowAmounts(
				{
					itemId: 'i1',
					areaId: 'a1',
					mine: { amount: 2, unit: 'unit:box' },
				},
				queued,
			),
		).toEqual({ 'unit:box': 2, kg: 3 })
	})
})

describe('isRowCounted and progress', () => {
	const tabs = sheetTabs({
		...SHEET,
		areas: [
			{
				areaId: 'a1',
				name: 'Walk-in',
				items: [
					sheetItem('i1'),
					sheetItem('i2', { quantity: 3_000 }),
					sheetItem('i4'),
				],
			},
			{ areaId: 'a2', name: 'Dry store', items: [sheetItem('i1')] },
		],
	})
	const [walkIn] = tabs

	it('counts a row somebody else counted, until you type there', () => {
		const i2 = walkIn!.rows[1]!
		expect(isRowCounted(i2, {})).toBe(true)
		expect(isRowCounted(i2, { [i2.key]: { kg: 1 } })).toBe(true)
		// You cleared your own entry: nothing of yours is left.
		expect(isRowCounted(i2, { [i2.key]: { kg: null } })).toBe(false)
	})

	it('an emptied field is not counted, a typed zero is', () => {
		const i1 = walkIn!.rows[0]!
		expect(isRowCounted(i1, {})).toBe(false)
		expect(isRowCounted(i1, { [i1.key]: { kg: null } })).toBe(false)
		expect(isRowCounted(i1, { [i1.key]: { kg: 0 } })).toBe(true)
	})

	it('counts an item once even when it is on two shelves', () => {
		expect(countProgress(tabs, {})).toEqual({ counted: 1, total: 3 })
		expect(
			countProgress(tabs, {
				'i1|a1': { kg: 2 },
				'i1|a2': { kg: 1 },
			}),
		).toEqual({ counted: 2, total: 3 })
	})

	it('counts per area for the tab badge', () => {
		expect(tabProgress(walkIn!, { 'i1|a1': { kg: 2 } })).toEqual({
			counted: 2,
			total: 3,
		})
	})
})

describe('othersQuantity', () => {
	const row = (
		quantity: number | null,
		mine: { amount: number; unit: string } | null,
	) => ({
		...sheetTabs({
			...SHEET,
			areas: [
				{
					areaId: 'a1',
					name: 'Walk-in',
					items: [
						sheetItem('i1', {
							quantity,
							mine: mine as never,
							units: [
								{
									id: 'box',
									name: 'Box',
									baseQuantity: 10_000_000,
									used: true,
									archived: false,
								},
							],
						}),
					],
				},
			],
		})[0]!.rows[0]!,
	})

	it('is what others added on top of this person', () => {
		expect(othersQuantity(row(5_000_000, { amount: 2, unit: 'kg' }))).toBe(
			3_000_000,
		)
		expect(
			othersQuantity(row(25_000_000, { amount: 2, unit: 'unit:box' })),
		).toBe(5_000_000)
	})

	it('is nothing when only this person counted, or this person has no entry', () => {
		expect(othersQuantity(row(2_000_000, { amount: 2, unit: 'kg' }))).toBeNull()
		expect(othersQuantity(row(2_000, null))).toBeNull()
		expect(othersQuantity(row(null, null))).toBeNull()
	})
})

describe('rowUnitChoices', () => {
	it('lists the count unit first', () => {
		expect(
			rowUnitChoices({ countUnit: 'unit:box' }, ['g', 'kg', 'unit:box']),
		).toEqual(['unit:box', 'g', 'kg'])
	})
})

describe('rowSaveState', () => {
	const row = { key: 'i1|a1', itemId: 'i1', areaId: 'a1', quantity: null }
	const entry = (clientId: string): QueuedEntry => ({
		clientId,
		itemId: 'i1',
		areaId: 'a1',
		amount: 2,
		unit: 'kg',
		queuedAt: 1,
	})
	const quiet = {
		pending: [] as QueuedEntry[],
		sending: new Set<string>(),
		failed: new Set<string>(),
	}

	it('is idle until something is typed', () => {
		expect(
			rowSaveState({ row, amounts: {}, snapshot: quiet, dirty: false }),
		).toBe('idle')
	})

	it('is unsaved between typing and the queue', () => {
		expect(
			rowSaveState({
				row,
				amounts: { 'i1|a1': { kg: 2 } },
				snapshot: quiet,
				dirty: true,
			}),
		).toBe('unsaved')
	})

	it('is saved once the region has it and nothing of the row is queued', () => {
		expect(
			rowSaveState({
				row,
				amounts: { 'i1|a1': { kg: 2 } },
				snapshot: quiet,
				dirty: false,
			}),
		).toBe('saved')
	})

	it('never looks saved while an entry is queued, sending or failed', () => {
		const amounts = { 'i1|a1': { kg: 2 } }
		const pending = [entry('a')]
		expect(
			rowSaveState({
				row,
				amounts,
				snapshot: { ...quiet, pending },
				dirty: false,
			}),
		).toBe('waiting')
		expect(
			rowSaveState({
				row,
				amounts,
				snapshot: { ...quiet, pending, sending: new Set(['a']) },
				dirty: false,
			}),
		).toBe('saving')
		expect(
			rowSaveState({
				row,
				amounts,
				snapshot: { ...quiet, pending, failed: new Set(['a']) },
				dirty: false,
			}),
		).toBe('failed')
	})

	it('returns refused when a row entry was refused by the region', () => {
		expect(
			rowSaveState({
				row,
				amounts: { 'i1|a1': { kg: 2 } },
				snapshot: {
					...quiet,
					refused: [
						{
							entry: entry('a'),
							code: 'unit_mismatch',
						},
					],
				},
				dirty: false,
			}),
		).toBe('refused')
	})

	it('ignores entries of other rows', () => {
		expect(
			rowSaveState({
				row,
				amounts: {},
				snapshot: {
					...quiet,
					pending: [{ ...entry('a'), itemId: 'i2' }],
					failed: new Set(['a']),
				},
				dirty: false,
			}),
		).toBe('idle')
	})
})
