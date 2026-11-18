import { createReportDefinition } from '@repo/reports'
import { describe, expect, it } from 'vitest'
import {
	loadSoldOutHistoryRecords,
	manualSoldOutOccurrencesFromEvents,
} from './sold-out-report-records.ts'

describe('manual sold-out occurrences', () => {
	it('records two windows when an item sells out twice', () => {
		const base = new Date('2026-03-01T12:00:00Z')
		const rows = [
			{
				locationId: 'loc',
				entityType: 'dish',
				entityId: 'burger',
				event: 'unavailable' as const,
				occurredAt: new Date(base.getTime()),
			},
			{
				locationId: 'loc',
				entityType: 'dish',
				entityId: 'burger',
				event: 'available' as const,
				occurredAt: new Date(base.getTime() + 3_600_000),
			},
			{
				locationId: 'loc',
				entityType: 'dish',
				entityId: 'burger',
				event: 'unavailable' as const,
				occurredAt: new Date(base.getTime() + 7_200_000),
			},
			{
				locationId: 'loc',
				entityType: 'dish',
				entityId: 'burger',
				event: 'available' as const,
				occurredAt: new Date(base.getTime() + 10_800_000),
			},
		]
		const occurrences = manualSoldOutOccurrencesFromEvents(rows)
		expect(occurrences).toHaveLength(2)
		expect(occurrences.every((row) => row.source === 'manual')).toBe(true)
	})
})

describe('sold-out history records', () => {
	it('exports the loader', () => {
		expect(typeof loadSoldOutHistoryRecords).toBe('function')
	})

	it('builds a report definition for the timeframe', () => {
		const definition = createReportDefinition({
			subject: 'sold_out_history',
			timeframe: { field: 'startedAt', preset: 'last_30_days' },
			visualization: { chartStyle: 'table' },
			settings: { title: 'Sold out', timezone: 'organization' },
		})
		expect(definition.subject).toBe('sold_out_history')
	})
})
