import { describe, expect, it } from 'vitest'
import {
	exclusiveModifierCleanup,
	isUnusedRecord,
	itemNotInAnyCategory,
	tidyRecords,
	unusedRecordsCsv,
	type MenuUsageGraph,
} from './unused-records.ts'

function graph(overrides: Partial<MenuUsageGraph> = {}): MenuUsageGraph {
	return {
		itemIds: ['loose', 'placed', 'dropped'],
		groupIds: ['only-loose', 'shared', 'nested'],
		optionIds: ['only-opt', 'shared-opt'],
		categoryItemIds: new Set(['placed']),
		itemGroupIds: new Map([
			['loose', ['only-loose']],
			['placed', ['shared']],
		]),
		groupItemIds: new Map([
			['only-loose', ['loose']],
			['shared', ['loose', 'placed']],
		]),
		groupOptionIds: new Map([
			['only-loose', ['only-opt']],
			['shared', ['shared-opt', 'only-opt']],
		]),
		optionGroupIds: new Map([
			['only-opt', ['only-loose', 'shared']],
			['shared-opt', ['shared']],
		]),
		nestedGroupIds: new Set(['nested']),
		dropIds: new Set(['dropped']),
		overrideIds: new Set(),
		posLinkedIds: new Set(),
		...overrides,
	}
}

describe('unused menu records', () => {
	it('lists a dish in no category and keeps one a drop or override uses', () => {
		const usage = graph()
		expect(itemNotInAnyCategory(usage, 'loose')).toBe(true)
		expect(isUnusedRecord(usage, 'item', 'loose')).toBe(true)
		expect(isUnusedRecord(usage, 'item', 'placed')).toBe(false)
		expect(isUnusedRecord(usage, 'item', 'dropped')).toBe(false)
		const overridden = graph({
			overrideIds: new Set(['loose']),
			categoryItemIds: new Set(['placed']),
		})
		expect(isUnusedRecord(overridden, 'item', 'loose')).toBe(false)
		const rows = tidyRecords(usage, [
			{
				entityType: 'item',
				id: 'loose',
				name: 'Loose',
				updatedAt: '2026-01-01',
			},
			{
				entityType: 'item',
				id: 'dropped',
				name: 'Dropped',
				updatedAt: '2026-01-02',
			},
		])
		expect(rows.map((row) => row.id)).toEqual(['loose'])
	})

	it('lists a POS-linked unused record and refuses to delete it', () => {
		const usage = graph({ posLinkedIds: new Set(['loose']) })
		const [row] = tidyRecords(usage, [
			{
				entityType: 'item',
				id: 'loose',
				name: '=HYPERLINK("http://x")',
				updatedAt: '2026-01-01',
			},
		])
		expect(row).toMatchObject({ posLinked: true, deletable: false })
		const csv = unusedRecordsCsv([row!])
		expect(csv).toContain(`'=HYPERLINK(""http://x"")`)
		expect(csv.startsWith('type,name,')).toBe(true)
	})

	it('deleting a dish removes only groups and options nothing else uses', () => {
		const cleanup = exclusiveModifierCleanup(graph(), ['loose'])
		expect(cleanup).toEqual({ groupIds: ['only-loose'], optionIds: [] })
		const only = graph({
			groupItemIds: new Map([
				['only-loose', ['loose']],
				['shared', ['placed']],
			]),
			optionGroupIds: new Map([
				['only-opt', ['only-loose']],
				['shared-opt', ['shared']],
			]),
		})
		expect(exclusiveModifierCleanup(only, ['loose'])).toEqual({
			groupIds: ['only-loose'],
			optionIds: ['only-opt'],
		})
		const linked = graph({
			groupItemIds: new Map([['only-loose', ['loose']]]),
			optionGroupIds: new Map([['only-opt', ['only-loose']]]),
			posLinkedIds: new Set(['only-loose']),
		})
		expect(exclusiveModifierCleanup(linked, ['loose']).groupIds).toEqual([])
	})
})
