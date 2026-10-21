import { describe, expect, it } from 'vitest'
import { templatesForGrants } from './access.ts'
import { getCatalog, getField, getSubject } from './catalog.ts'
import { RESERVATIONS_REPORT_SUBJECTS } from './catalog-reservations.ts'
import { flattenFilterConditions } from './dsl.ts'
import { validateReportDefinition } from './engine.ts'
import {
	definitionForNewReport,
	organizationTemplates,
	platformTemplates,
} from './templates.ts'

describe('report templates', () => {
	const templates = [...organizationTemplates(), ...platformTemplates()]

	it('all run against their catalog', () => {
		for (const template of templates) {
			expect(
				validateReportDefinition(
					getCatalog(template.scope),
					template.definition,
				),
				template.id,
			).toBeNull()
		}
	})

	it('have unique ids', () => {
		const ids = templates.map((template) => template.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it('only filter and group on fields the subject offers that way', () => {
		for (const template of templates) {
			const subject = getSubject(
				getCatalog(template.scope),
				template.definition.subject,
			)!
			for (const condition of flattenFilterConditions(
				template.definition.filters,
			)) {
				expect(
					getField(subject, condition.field)?.filterable,
					`${template.id}: ${condition.field}`,
				).toBe(true)
			}
		}
	})

	it('count only orders that count toward sales in money reports', () => {
		const money = organizationTemplates().filter(
			(template) =>
				template.definition.subject === 'orders' &&
				template.definition.visualization.valueField !== undefined,
		)
		expect(money.length).toBeGreaterThan(5)
		for (const template of money) {
			expect(
				flattenFilterConditions(template.definition.filters),
				template.id,
			).toContainEqual({
				field: 'countsTowardSales',
				operator: 'eq',
				value: 'true',
			})
		}
	})

	it('measure sales, order value, items, and ratings', () => {
		const byId = new Map(
			organizationTemplates().map((template) => [template.id, template]),
		)
		expect(byId.get('sales-total')?.definition.visualization).toMatchObject({
			chartStyle: 'single_number',
			measure: 'sum',
			valueField: 'total',
		})
		expect(
			byId.get('average-order-value')?.definition.visualization,
		).toMatchObject({ measure: 'average', valueField: 'total' })
		expect(byId.get('items-top-sellers')?.definition).toMatchObject({
			subject: 'order_items',
			groupBy: ['itemName'],
			visualization: { measure: 'sum', valueField: 'quantity' },
		})
		expect(
			byId.get('reviews-average-rating')?.definition.visualization,
		).toMatchObject({ measure: 'average', valueField: 'stars' })
	})
})

describe('definitionForNewReport', () => {
	it('uses the matching template when an id is provided', () => {
		const definition = definitionForNewReport('platform', 'audit-severity')
		expect(definition.subject).toBe('audit_logs')
		expect(definition.groupBy).toEqual(['severity'])
		expect(definition.settings.title).toBe('Audit log severity')
	})

	it('falls back to the blank definition for an unknown template', () => {
		const definition = definitionForNewReport('platform', 'does-not-exist')
		expect(definition.subject).toBe('organizations')
		expect(definition.groupBy).toEqual(['dataRegion'])
		expect(definition.settings.title).toBe('New Report')
	})

	it('switches between templates without retaining the previous subject', () => {
		const first = definitionForNewReport('platform', 'orgs-by-region')
		const second = definitionForNewReport('platform', 'audit-severity')
		expect(first.subject).toBe('organizations')
		expect(second.subject).toBe('audit_logs')
		expect(second.groupBy).toEqual(['severity'])
	})

	it('creates weekly and list customer templates', () => {
		const weekly = definitionForNewReport('organization', 'customers-by-week')
		expect(weekly.groupBy).toEqual(['createdAt'])
		expect(weekly.timeBucket).toBe('week')
		expect(weekly.visualization.chartStyle).toBe('bar')

		const list = definitionForNewReport('organization', 'customer-list')
		expect(list.visualization.chartStyle).toBe('table')
		expect(list.groupBy).toEqual([])
		expect(list.columns).toEqual(['name', 'email', 'phone', 'createdAt'])
	})

	it('creates shop order templates', () => {
		const byStatus = definitionForNewReport(
			'organization',
			'shop-orders-by-status',
		)
		expect(byStatus.subject).toBe('shop_orders')
		expect(byStatus.groupBy).toEqual(['status'])

		const list = definitionForNewReport('organization', 'shop-order-list')
		expect(list.visualization.chartStyle).toBe('table')
		expect(list.columns).toEqual([
			'customerName',
			'customerPhone',
			'productName',
			'amount',
			'status',
			'createdAt',
		])
	})
})

describe('Reservations templates', () => {
	const rsv = organizationTemplates().filter(
		(template) => template.category === 'Reservations',
	)
	const catalog = getCatalog('organization')

	it('offer presets for bookings, the waitlist and pacing, none over all time', () => {
		expect(rsv.length).toBeGreaterThanOrEqual(8)
		const subjects = new Set(rsv.map((item) => item.definition.subject))
		expect([...subjects].sort()).toEqual(
			[...RESERVATIONS_REPORT_SUBJECTS].sort(),
		)
		for (const template of rsv) {
			expect(template.definition.timeframe.preset, template.id).not.toBe(
				'all_time',
			)
		}
	})

	it('are offered only to people whose token lists the reservation subjects', () => {
		const orgTemplates = organizationTemplates()
		const without = templatesForGrants(catalog, orgTemplates, [])
		expect(without.filter((item) => item.category === 'Reservations')).toEqual(
			[],
		)
		const bookingsOnly = templatesForGrants(catalog, orgTemplates, ['bookings'])
		const offered = bookingsOnly
			.filter((item) => item.category === 'Reservations')
			.map((item) => item.definition.subject)
		expect(new Set(offered)).toEqual(new Set(['bookings']))
		const all = templatesForGrants(catalog, orgTemplates, [
			...RESERVATIONS_REPORT_SUBJECTS,
		])
		expect(all.filter((item) => item.category === 'Reservations')).toHaveLength(
			rsv.length,
		)
	})

	it('include the single-number presets the dashboard offers as report blocks', () => {
		const single = rsv
			.filter(
				(item) => item.definition.visualization.chartStyle === 'single_number',
			)
			.map((item) => item.id)
		expect(single).toEqual(
			expect.arrayContaining([
				'rsv-covers-today',
				'rsv-no-show-rate-30d',
				'rsv-late-cancels-30d',
				'rsv-waitlist-avg-wait-7d',
			]),
		)
	})
})
