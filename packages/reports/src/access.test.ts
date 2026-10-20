import { describe, expect, it } from 'vitest'
import {
	catalogForGrants,
	definitionAllowed,
	templatesForGrants,
} from './access.ts'
import { getCatalog } from './catalog.ts'
import { createReportDefinition } from './dsl.ts'
import { organizationTemplates } from './templates.ts'

const catalog = getCatalog('organization')

function definitionOn(subject: string) {
	return createReportDefinition({
		subject,
		timeframe: { field: 'createdAt', preset: 'all_time' },
		visualization: {
			chartStyle: 'bar',
			measure: 'count',
			sortBy: 'none',
			hideCounts: false,
		},
		settings: { title: 'T', notes: '', timezone: 'UTC' },
	})
}

describe('org-wide subjects', () => {
	it('are hidden from a person whose grants do not list them', () => {
		const ids = catalogForGrants(catalog, ['shifts']).subjects.map((s) => s.id)
		expect(ids).not.toContain('customers')
		expect(ids).not.toContain('shop_orders')
		expect(
			definitionAllowed(catalog, definitionOn('customers'), ['shifts']),
		).toBe(false)
		expect(definitionAllowed(catalog, definitionOn('shop_orders'), [])).toBe(
			false,
		)
	})

	it('are offered when granted, and control-plane subjects always are', () => {
		const granted = ['customers', 'shop_orders']
		const ids = catalogForGrants(catalog, granted).subjects.map((s) => s.id)
		expect(ids).toEqual(expect.arrayContaining(granted))
		expect(definitionAllowed(catalog, definitionOn('customers'), granted)).toBe(
			true,
		)
		expect(definitionAllowed(catalog, definitionOn('notes'), [])).toBe(true)
	})

	it('drop templates on a subject the grants do not cover', () => {
		const templates = organizationTemplates()
		const subjectsOf = (granted: string[]) =>
			new Set(
				templatesForGrants(catalog, templates, granted).map(
					(template) => template.definition.subject,
				),
			)
		expect(subjectsOf([]).has('customers')).toBe(false)
		expect(subjectsOf([]).has('shop_orders')).toBe(false)
		expect(subjectsOf(['customers', 'shop_orders']).has('customers')).toBe(true)
	})
})
