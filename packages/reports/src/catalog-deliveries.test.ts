import { describe, expect, it } from 'vitest'
import { catalogForGrants, definitionAllowed, templatesForGrants } from './access.ts'
import { getSubject, organizationCatalog } from './catalog.ts'
import {
	anonymousDriverLabel,
	DELIVERY_REPORT_SUBJECTS,
	deliveryReportSubjects,
	isDeliveryReportSubject,
} from './catalog-deliveries.ts'
import { validateReportDefinition } from './engine.ts'
import { ORG_WIDE_REPORT_SUBJECTS } from './org-wide-subjects.ts'
import { RESTRICTED_REPORT_SUBJECTS } from './operator-token.ts'
import { organizationTemplates } from './templates.ts'

/**
 * Own-driver delivery reports (#324): gated by a grant, a zone and never an
 * address, and the driver's name only for members who may see staff names.
 */

describe('delivery report subjects', () => {
	it('are restricted subjects, so a token lists them only when the App grants them', () => {
		for (const subject of DELIVERY_REPORT_SUBJECTS) {
			expect(isDeliveryReportSubject(subject)).toBe(true)
			expect(RESTRICTED_REPORT_SUBJECTS).toContain(subject)
			// Not part of what analytics access alone grants.
			expect(ORG_WIDE_REPORT_SUBJECTS).not.toContain(subject as never)
		}
		expect(isDeliveryReportSubject('orders')).toBe(false)
	})

	it('do not exist for someone whose token does not list them', () => {
		const without = catalogForGrants(organizationCatalog, [...ORG_WIDE_REPORT_SUBJECTS])
		for (const subject of DELIVERY_REPORT_SUBJECTS) {
			expect(getSubject(without, subject)).toBeFalsy()
		}
		const withGrant = catalogForGrants(organizationCatalog, [...DELIVERY_REPORT_SUBJECTS])
		for (const subject of DELIVERY_REPORT_SUBJECTS) {
			expect(getSubject(withGrant, subject)).toBeTruthy()
		}
		const offered = templatesForGrants(organizationCatalog, organizationTemplates(), [...ORG_WIDE_REPORT_SUBJECTS])
		expect(offered.filter((t) => t.category === 'Deliveries')).toEqual([])
	})

	it('carry no field that could hold a guest name, phone or address', () => {
		const fieldIds = deliveryReportSubjects.flatMap((subject) =>
			subject.fields.map((field) => `${field.id} ${field.label}`.toLowerCase()),
		)
		for (const text of fieldIds) {
			expect(text).not.toMatch(/address|street|phone|guest|customer|contact|email/)
		}
		const zone = deliveryReportSubjects[0]!.fields.find((f) => f.id === 'zone')!
		expect(zone.description).toMatch(/never an address/i)
	})

	it('keep the driver field for everyone and redact its values in the region, not by hiding the totals', () => {
		for (const subject of deliveryReportSubjects) {
			const driver = subject.fields.find((field) => field.id === 'driver')!
			// No staff permission removes the field: a member without the grant still
			// groups by driver and sees "Driver 1", "Driver 2" with the totals.
			expect(driver.requiresSubject).toBeUndefined()
			expect(driver.groupable).toBe(true)
		}
		expect(anonymousDriverLabel(2)).toBe('Driver 2')
	})

	it('give the driver report one row per driver that opens that driver’s deliveries', () => {
		const subject = deliveryReportSubjects.find((item) => item.id === 'driver_deliveries')!
		expect(subject.rowRefField).toBe('driverKey')
		for (const column of subject.defaultColumns ?? []) {
			expect(subject.fields.some((field) => field.id === column)).toBe(true)
		}
		const template = organizationTemplates().find((t) => t.id === 'deliveries-by-driver')!
		expect(template.definition.subject).toBe('driver_deliveries')
		expect(template.definition.groupBy).toEqual([])
		expect(template.definition.timeframe.field).toBe('periodEnd')
	})

	it('offer the Deliveries by driver and Delivery times templates, all valid', () => {
		const templates = organizationTemplates().filter((t) => t.category === 'Deliveries')
		const ids = templates.map((t) => t.id)
		expect(ids).toEqual(
			expect.arrayContaining([
				'deliveries-by-driver',
				'driver-deliveries-list',
				'delivery-time-by-hour',
				'delivery-promised-by-hour',
				'delivery-time-by-zone',
				'delivery-promised-by-zone',
				'delivery-late-by-zone',
			]),
		)
		for (const template of templates) {
			expect(validateReportDefinition(organizationCatalog, template.definition), template.id).toBeNull()
			expect(
				definitionAllowed(organizationCatalog, template.definition, [...DELIVERY_REPORT_SUBJECTS]),
				template.id,
			).toBe(true)
			expect(
				definitionAllowed(organizationCatalog, template.definition, [...ORG_WIDE_REPORT_SUBJECTS]),
				template.id,
			).toBe(false)
		}
		// By hour and by zone, promised against actual.
		const byHour = templates.find((t) => t.id === 'delivery-time-by-hour')!
		expect(byHour.definition.timeBucket).toBe('hour_of_day')
		expect(byHour.definition.visualization.valueField).toBe('minutesActual')
		expect(templates.find((t) => t.id === 'delivery-promised-by-hour')!.definition.visualization.valueField).toBe('minutesPromised')
	})
})
