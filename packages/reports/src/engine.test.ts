import { describe, expect, it } from 'vitest'
import { type ReportCatalog, organizationCatalog } from './catalog.ts'
import {
	type ReportDefinition,
	createReportDefinition,
	emptyFilterGroup,
	countFilterConditions,
	flattenFilterConditions,
	reportDefinitionSchema,
} from './dsl.ts'
import {
	isReportRunError,
	runReport,
	validateReportDefinition,
} from './engine.ts'

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

function measuredDefinition(
	subject: string,
	visualization: Partial<ReportDefinition['visualization']>,
	partial: Partial<ReportDefinition> = {},
) {
	return createReportDefinition({
		subject,
		timeframe: { field: 'createdAt', preset: 'all_time' },
		visualization: {
			chartStyle: 'bar',
			measure: 'sum',
			sortBy: 'none',
			hideCounts: false,
			...visualization,
		},
		settings: { title: 'Measured', notes: '', timezone: 'UTC' },
		...partial,
	})
}

/** A plain number field, which the built-in catalogs don't have. */
const ratingCatalog: ReportCatalog = {
	scope: 'organization',
	subjects: [
		{
			id: 'ratings',
			label: 'Ratings',
			description: 'Star ratings from customers.',
			scope: 'organization',
			source: 'tenant-api',
			fields: [
				{
					id: 'createdAt',
					label: 'Rated at',
					type: 'datetime',
					timeframe: true,
					groupable: true,
				},
				{
					id: 'channel',
					label: 'Channel',
					type: 'enum',
					filterable: true,
					groupable: true,
					options: [
						{ value: 'web', label: 'Website' },
						{ value: 'app', label: 'App' },
					],
				},
				{
					id: 'stars',
					label: 'Stars',
					type: 'number',
					sumLabel: false,
					averageLabel: 'Average rating',
				},
			],
		},
	],
}

describe('value measures', () => {
	it('adds money up in cents per segment and sorts by the amount', () => {
		const result = runReport(
			organizationCatalog,
			measuredDefinition(
				'shop_orders',
				{ valueField: 'amount', sortBy: 'value_desc' },
				{ groupBy: ['productName'] },
			),
			[
				{
					createdAt: '2026-08-01',
					productName: 'Mug',
					amount: 0.1,
					currency: 'USD',
				},
				{
					createdAt: '2026-08-01',
					productName: 'Mug',
					amount: 0.2,
					currency: 'USD',
				},
				{
					createdAt: '2026-08-02',
					productName: 'Hoodie',
					amount: 10,
					currency: 'usd',
				},
				{
					createdAt: '2026-08-03',
					productName: 'Hoodie',
					amount: null,
					currency: 'USD',
				},
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.total).toBe(4)
		expect(result.value).toBe(10.3)
		expect(result.valueInfo).toEqual({
			measure: 'sum',
			field: 'amount',
			label: 'Shop sales',
			type: 'currency',
			currency: 'USD',
		})
		expect(result.segments).toEqual([
			{ key: 'Hoodie', label: 'Hoodie', count: 2, percent: 50, value: 10 },
			{ key: 'Mug', label: 'Mug', count: 2, percent: 50, value: 0.3 },
		])
	})

	it('averages only the records that have an amount', () => {
		const result = runReport(
			ratingCatalog,
			measuredDefinition(
				'ratings',
				{ chartStyle: 'table', measure: 'average', valueField: 'stars' },
				{ groupBy: ['channel'] },
			),
			[
				{ createdAt: '2026-08-01', channel: 'web', stars: 5 },
				{ createdAt: '2026-08-02', channel: 'web', stars: 3 },
				{ createdAt: '2026-08-03', channel: 'web', stars: null },
				{ createdAt: '2026-08-04', channel: 'app', stars: 4 },
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.value).toBe(4)
		expect(result.valueInfo).toEqual({
			measure: 'average',
			field: 'stars',
			label: 'Average rating',
			type: 'number',
		})
		expect(
			result.segments.map((segment) => [
				segment.label,
				segment.count,
				segment.value,
			]),
		).toEqual([
			['Website', 3, 4],
			['App', 1, 4],
		])
	})

	it('leaves months without orders without an average', () => {
		const result = runReport(
			organizationCatalog,
			measuredDefinition(
				'shop_orders',
				{ measure: 'average', valueField: 'amount' },
				{
					groupBy: ['createdAt'],
					timeframe: { field: 'createdAt', preset: 'last_3_months' },
				},
			),
			[{ createdAt: '2026-08-01T00:00:00.000Z', amount: 20, currency: 'USD' }],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		const august = result.segments.find((segment) => segment.key === '2026-08')
		expect(august).toMatchObject({ count: 1, value: 20 })
		const empty = result.segments.filter((segment) => segment.count === 0)
		expect(empty.length).toBeGreaterThan(0)
		expect(empty.every((segment) => segment.value === undefined)).toBe(true)
	})

	it("doesn't add up amounts in more than one currency", () => {
		const result = runReport(
			organizationCatalog,
			measuredDefinition('shop_orders', {
				chartStyle: 'single_number',
				valueField: 'amount',
			}),
			[
				{ createdAt: '2026-08-01', amount: 10, currency: 'USD' },
				{ createdAt: '2026-08-02', amount: 20, currency: 'SAR' },
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.total).toBe(2)
		expect(result).not.toHaveProperty('value')
		expect(result.segments).toEqual([
			{ key: 'total', label: 'Shop orders', count: 2, percent: 100 },
		])
		expect(result.valueInfo?.mixedCurrencies).toBe(true)
		expect(result.valueInfo?.currency).toBeUndefined()
	})

	it('sorts by count when grouped amounts are in more than one currency', () => {
		const result = runReport(
			organizationCatalog,
			measuredDefinition(
				'shop_orders',
				{ valueField: 'amount', sortBy: 'value_desc' },
				{ groupBy: ['productName'] },
			),
			[
				{
					createdAt: '2026-08-01',
					productName: 'Hoodie',
					amount: 500,
					currency: 'SAR',
				},
				{
					createdAt: '2026-08-02',
					productName: 'Mug',
					amount: 5,
					currency: 'USD',
				},
				{
					createdAt: '2026-08-03',
					productName: 'Mug',
					amount: 5,
					currency: 'USD',
				},
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result).not.toHaveProperty('value')
		expect(result.valueInfo?.mixedCurrencies).toBe(true)
		expect(result.segments).toEqual([
			{ key: 'Mug', label: 'Mug', count: 2, percent: (2 / 3) * 100 },
			{ key: 'Hoodie', label: 'Hoodie', count: 1, percent: (1 / 3) * 100 },
		])
	})

	it('rejects sums and averages without a number that fits', () => {
		const shopOrder = (
			visualization: Partial<ReportDefinition['visualization']>,
		) =>
			validateReportDefinition(
				organizationCatalog,
				measuredDefinition('shop_orders', visualization, {
					groupBy: ['productName'],
				}),
			)
		expect(shopOrder({})).toMatchObject({
			error: 'invalid_definition',
			message: 'Choose a number to add up.',
		})
		expect(
			shopOrder({ measure: 'average', valueField: 'status' }),
		).toMatchObject({
			message: 'Choose a number to average.',
		})
		expect(
			shopOrder({
				measure: 'average',
				valueField: 'amount',
				chartStyle: 'pie',
			}),
		).toMatchObject({ error: 'invalid_definition' })
		expect(shopOrder({ valueField: 'amount', chartStyle: 'pie' })).toBeNull()

		const rating = (
			visualization: Partial<ReportDefinition['visualization']>,
		) =>
			validateReportDefinition(
				ratingCatalog,
				measuredDefinition('ratings', visualization, { groupBy: ['channel'] }),
			)
		// A sum of star ratings means nothing.
		expect(rating({ valueField: 'stars' })).toMatchObject({
			error: 'invalid_definition',
		})
		expect(rating({ measure: 'average', valueField: 'stars' })).toBeNull()
	})

	it('ignores the measure on list tables', () => {
		const definition = measuredDefinition('shop_orders', {
			chartStyle: 'table',
		})
		expect(validateReportDefinition(organizationCatalog, definition)).toBeNull()
	})

	it('formats money in list rows with each record’s currency', () => {
		const result = runReport(
			organizationCatalog,
			measuredDefinition(
				'shop_orders',
				{ chartStyle: 'table' },
				{ columns: ['productName', 'amount'] },
			),
			[
				{
					createdAt: '2026-08-02',
					productName: 'Hoodie',
					amount: 1234.5,
					currency: 'SAR',
				},
				{
					createdAt: '2026-08-01',
					productName: 'Mug',
					amount: 12.5,
					currency: 'usd',
				},
				{ createdAt: '2026-07-01', productName: 'Sticker', amount: null },
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.rows?.map((row) => row.amount)).toEqual([
			expect.stringMatching(/^SAR\s1,234\.50$/u),
			'$12.50',
			'—',
		])
	})

	it('formats plain numbers in list rows', () => {
		const result = runReport(
			ratingCatalog,
			measuredDefinition(
				'ratings',
				{ chartStyle: 'table' },
				{ columns: ['channel', 'stars'] },
			),
			[
				{ createdAt: '2026-08-02', channel: 'web', stars: 4.5 },
				{ createdAt: '2026-08-01', channel: 'app', stars: 0 },
				{ createdAt: '2026-07-01', channel: 'app', stars: null },
			],
			now,
		)
		expect(isReportRunError(result)).toBe(false)
		if (isReportRunError(result)) return
		expect(result.rows?.map((row) => row.stars)).toEqual(['4.5', '0', '—'])
	})
})
