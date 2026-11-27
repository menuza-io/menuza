import { describe, expect, it } from 'vitest'
import { organizationCatalog } from './catalog.ts'
import { createReportDefinition } from './dsl.ts'
import {
	isPersonalReportField,
	PERSONAL_REPORT_FIELDS,
	personalFieldsUsed,
} from './personal-fields.ts'

/** Fields whose name looks personal but hold none (an item, a place, a flag). */
const NOT_PERSONAL = new Set([
	'order_items.itemName',
	'order_options.groupName',
	'order_options.optionName',
	'order_options.itemName',
	'cancelled_orders.dishName',
	'item_pairs.itemAName',
	'item_pairs.itemBName',
	'modifier_sales.parentItemName',
	'modifier_sales.optionName',
	'sold_out_history.location',
	'customers.phoneVerified',
	'customers.hasEmail',
	'phone_calls.resolvedByAssistant',
	'phone_calls.repeatCaller',
	'phone_calls.rating',
	'shop_orders.productName',
	'inventory_deliveries.supplierName',
])

describe('personal report fields (#121)', () => {
	it('lists every catalog field that looks like a name, phone or email', () => {
		const looksPersonal =
			/name|phone|email|reviewer|caller|employee|guest|staff|member|cashier|contact|user/i
		const missed: string[] = []
		for (const subject of organizationCatalog.subjects) {
			for (const field of subject.fields) {
				const id = `${subject.id}.${field.id}`
				if (!looksPersonal.test(`${field.id} ${field.label}`)) continue
				if (isPersonalReportField(subject.id, field.id)) continue
				if (NOT_PERSONAL.has(id)) continue
				missed.push(id)
			}
		}
		expect(missed).toEqual([])
	})

	it('names only fields that exist', () => {
		for (const [subjectId, fields] of Object.entries(PERSONAL_REPORT_FIELDS)) {
			const subject = organizationCatalog.subjects.find((s) => s.id === subjectId)
			expect(subject, subjectId).toBeDefined()
			for (const field of fields) {
				expect(
					subject!.fields.some((f) => f.id === field),
					`${subjectId}.${field}`,
				).toBe(true)
			}
		}
	})

	it('flags a report with a customer phone column, group-by or filter', () => {
		const list = createReportDefinition({
			subject: 'customers',
			timeframe: { field: 'createdAt', preset: 'all_time' },
			columns: ['name', 'phone'],
			visualization: { chartStyle: 'table' },
			settings: { title: 'Customers' },
		})
		expect(personalFieldsUsed(organizationCatalog, list)).toEqual([
			'customers.name',
			'customers.phone',
		])
		const filtered = createReportDefinition({
			subject: 'orders',
			timeframe: { field: 'createdAt', preset: 'last_7_days' },
			groupBy: [],
			filters: {
				combinator: 'and',
				conditions: [
					{ field: 'customerPhone', operator: 'contains', value: '555' },
				],
			},
			visualization: { chartStyle: 'single_number' },
			settings: { title: 'Orders from a number' },
		})
		expect(personalFieldsUsed(organizationCatalog, filtered)).toEqual([
			'orders.customerPhone',
		])
	})

	it('lets an aggregate report through', () => {
		const total = createReportDefinition({
			subject: 'sales',
			timeframe: { field: 'occurredAt', preset: 'yesterday' },
			visualization: {
				chartStyle: 'single_number',
				measure: 'sum',
				valueField: 'netSales',
			},
			settings: { title: 'Net sales' },
		})
		expect(personalFieldsUsed(organizationCatalog, total)).toEqual([])
	})
})
