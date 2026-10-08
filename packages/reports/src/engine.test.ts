import { describe, expect, it } from 'vitest'
import { organizationCatalog } from './catalog.ts'
import {
	createReportDefinition,
	emptyFilterGroup,
	countFilterConditions,
	flattenFilterConditions,
	reportDefinitionSchema,
} from './dsl.ts'
import { isReportRunError, runReport } from './engine.ts'

const now = new Date('2026-08-24T18:00:00.000Z')

function notesDefinition() {
	return createReportDefinition({
		subject: 'notes',
		timeframe: { field: 'createdAt', preset: 'last_3_months' },
		groupBy: ['status'],
		visualization: {
			chartStyle: 'pie',
			measure: 'count',
			sortBy: 'value_desc',
			hideCounts: false,
		},
		settings: { title: 'Notes by status', notes: '', timezone: 'user' },
	})
}

describe('report DSL', () => {
	it('parses a valid definition', () => {
		const parsed = reportDefinitionSchema.parse(notesDefinition())
		expect(parsed.version).toBe(1)
		expect(parsed.groupBy).toEqual(['status'])
		expect(parsed.timeBucket).toBe('month')
		expect(parsed.columns).toEqual([])
	})

	it('defaults timeBucket and columns on saved reports', () => {
		const parsed = reportDefinitionSchema.parse({
			version: 1,
			subject: 'notes',
			timeframe: { field: 'createdAt', preset: 'all_time' },
			groupBy: ['status'],
			visualization: { chartStyle: 'pie' },
			settings: { title: 'Notes' },
		})
		expect(parsed.timeBucket).toBe('month')
		expect(parsed.columns).toEqual([])
	})
})

describe('runReport', () => {
	it('groups and percents matching records', () => {
		const result = runReport(
			organizationCatalog,
			notesDefinition(),
			[
				{
					createdAt: '2026-08-01T00:00:00.000Z',
					status: 'Todo',
					priority: 'low',
					isPublic: true,
				},
				{
					createdAt: '2026-08-02T00:00:00.000Z',
					status: 'Todo',
					priority: 'high',
					isPublic: true,
				},
				{
					createdAt: '2026-08-03T00:00:00.000Z',
					status: 'Done',
					priority: 'low',
					isPublic: false,
				},
				{
					createdAt: '2025-01-01T00:00:00.000Z',
					status: 'Done',
					priority: 'low',
					isPublic: true,
				},
			],
			now,
		)

		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.total).toBe(3)
		expect(result.segments[0]).toMatchObject({
			label: 'Todo',
			count: 2,
			percent: expect.closeTo(66.66, 1),
		})
		expect(result.segments[1]).toMatchObject({ label: 'Done', count: 1 })
	})

	it('requires groupBy for pie charts', () => {
		const result = runReport(
			organizationCatalog,
			{
				...notesDefinition(),
				groupBy: [],
			},
			[],
			now,
		)
		expect(isReportRunError(result)).toBe(true)
		if (!isReportRunError(result)) return
		expect(result.error).toBe('missing_group_by')
	})

	it('applies AND filters', () => {
		const result = runReport(
			organizationCatalog,
			{
				...notesDefinition(),
				filters: {
					combinator: 'and',
					conditions: [{ field: 'priority', operator: 'eq', value: 'high' }],
				},
			},
			[
				{
					createdAt: '2026-08-01T00:00:00.000Z',
					status: 'Todo',
					priority: 'high',
				},
				{
					createdAt: '2026-08-01T00:00:00.000Z',
					status: 'Todo',
					priority: 'low',
				},
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.total).toBe(1)
	})

	it('returns a single number without grouping', () => {
		const result = runReport(
			organizationCatalog,
			{
				...notesDefinition(),
				groupBy: [],
				visualization: {
					chartStyle: 'single_number',
					measure: 'count',
					sortBy: 'none',
					hideCounts: false,
				},
			},
			[
				{ createdAt: '2026-08-01T00:00:00.000Z', status: 'Todo' },
				{ createdAt: '2026-08-02T00:00:00.000Z', status: 'Done' },
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.total).toBe(2)
		expect(result.segments).toHaveLength(1)
	})

	it('supports nested OR groups', () => {
		const result = runReport(
			organizationCatalog,
			{
				...notesDefinition(),
				filters: {
					combinator: 'or',
					conditions: [
						{ field: 'priority', operator: 'eq', value: 'high' },
						{
							combinator: 'and',
							conditions: [{ field: 'status', operator: 'eq', value: 'Done' }],
						},
					],
				},
			},
			[
				{
					createdAt: '2026-08-01T00:00:00.000Z',
					status: 'Todo',
					priority: 'high',
				},
				{
					createdAt: '2026-08-01T00:00:00.000Z',
					status: 'Done',
					priority: 'low',
				},
				{
					createdAt: '2026-08-01T00:00:00.000Z',
					status: 'Todo',
					priority: 'low',
				},
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.total).toBe(2)
	})

	it('flattens nested filter groups into leaf conditions', () => {
		const flat = flattenFilterConditions({
			combinator: 'and',
			conditions: [
				{ field: 'region', operator: 'eq', value: 'us' },
				{
					combinator: 'or',
					conditions: [
						{ field: 'status', operator: 'eq', value: 'active' },
						{ field: 'status', operator: 'eq', value: 'trial' },
					],
				},
			],
		})
		expect(flat.map((item) => item.field)).toEqual([
			'region',
			'status',
			'status',
		])
		expect(countFilterConditions({ combinator: 'and', conditions: flat })).toBe(
			3,
		)
	})

	it('counts conditions inside nested groups', () => {
		expect(
			countFilterConditions({
				combinator: 'and',
				conditions: [
					{ field: 'a', operator: 'eq', value: '1' },
					{
						combinator: 'or',
						conditions: [
							{ field: 'b', operator: 'eq', value: '2' },
							{
								combinator: 'and',
								conditions: [{ field: 'c', operator: 'eq', value: '3' }],
							},
						],
					},
				],
			}),
		).toBe(3)
	})

	it('does not use unused emptyFilterGroup in a way that fails types', () => {
		expect(emptyFilterGroup().conditions).toEqual([])
	})

	it('buckets datetime groups by ISO week starting Monday UTC', () => {
		const result = runReport(
			organizationCatalog,
			createReportDefinition({
				subject: 'customers',
				timeframe: { field: 'createdAt', preset: 'last_3_months' },
				groupBy: ['createdAt'],
				timeBucket: 'week',
				visualization: {
					chartStyle: 'bar',
					measure: 'count',
					sortBy: 'none',
					hideCounts: false,
				},
				settings: { title: 'Customers by week', notes: '', timezone: 'UTC' },
			}),
			[
				{ createdAt: '2026-08-03T12:00:00.000Z' },
				{ createdAt: '2026-08-04T15:00:00.000Z' },
				{ createdAt: '2026-08-10T09:00:00.000Z' },
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		const counted = result.segments.filter((segment) => segment.count > 0)
		expect(counted).toHaveLength(2)
		expect(counted[0]).toMatchObject({ key: '2026-08-03', count: 2 })
		expect(counted[1]).toMatchObject({ key: '2026-08-10', count: 1 })
		expect(counted[0]?.label).toMatch(/Aug 3/)
	})

	it('fills empty months with zero counts on a time axis', () => {
		const result = runReport(
			organizationCatalog,
			createReportDefinition({
				subject: 'customers',
				timeframe: { field: 'createdAt', preset: 'last_3_months' },
				groupBy: ['createdAt'],
				timeBucket: 'month',
				visualization: {
					chartStyle: 'bar',
					measure: 'count',
					sortBy: 'none',
					hideCounts: false,
				},
				settings: { title: 'Customers by month', notes: '', timezone: 'UTC' },
			}),
			[{ createdAt: '2026-08-01T00:00:00.000Z' }],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.total).toBe(1)
		expect(result.segments.length).toBeGreaterThan(1)
		const august = result.segments.find((segment) => segment.key === '2026-08')
		expect(august).toMatchObject({ count: 1, label: 'Aug 2026' })
		expect(result.segments.some((segment) => segment.count === 0)).toBe(true)
		expect(result.segments.map((segment) => segment.key)).toEqual(
			[...result.segments].map((segment) => segment.key).sort(),
		)
	})

	it('returns list rows for a table without groupBy', () => {
		const result = runReport(
			organizationCatalog,
			createReportDefinition({
				subject: 'customers',
				timeframe: { field: 'createdAt', preset: 'all_time' },
				groupBy: [],
				columns: ['name', 'email', 'phone'],
				visualization: {
					chartStyle: 'table',
					measure: 'count',
					sortBy: 'none',
					hideCounts: false,
				},
				settings: { title: 'Customer list', notes: '', timezone: 'UTC' },
			}),
			[
				{
					createdAt: '2026-08-02T00:00:00.000Z',
					name: 'Ada',
					email: 'ada@example.com',
					phone: '+15551212',
				},
				{
					createdAt: '2026-08-10T00:00:00.000Z',
					name: 'Grace',
					email: 'grace@example.com',
					phone: '',
				},
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.total).toBe(2)
		expect(result.columns).toEqual([
			{ id: 'name', label: 'Name' },
			{ id: 'email', label: 'Email' },
			{ id: 'phone', label: 'Phone' },
		])
		expect(result.rows).toEqual([
			{ name: 'Grace', email: 'grace@example.com', phone: '—' },
			{ name: 'Ada', email: 'ada@example.com', phone: '+15551212' },
		])
	})

	it('labels enum values the catalog does not list', () => {
		const result = runReport(
			organizationCatalog,
			createReportDefinition({
				subject: 'phone_calls',
				timeframe: { field: 'startedAt', preset: 'all_time' },
				groupBy: ['purpose'],
				visualization: {
					chartStyle: 'pie',
					measure: 'count',
					sortBy: 'value_desc',
					hideCounts: false,
				},
				settings: { title: 'Why people call', notes: '', timezone: 'user' },
			}),
			[
				{ startedAt: '2026-08-01T00:00:00.000Z', purpose: 'billing_question' },
				{ startedAt: '2026-08-02T00:00:00.000Z', purpose: 'billing_question' },
				{
					startedAt: '2026-08-03T00:00:00.000Z',
					purpose: 'business_information',
				},
			],
			now,
		)

		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.segments.map((segment) => segment.label)).toEqual([
			'Billing question',
			'Business info',
		])
	})
})
