import { describe, expect, it } from 'vitest'
import {
	catalogForGrants,
	definitionAllowed,
	templatesForGrants,
} from './access.ts'
import { getField, getSubject, organizationCatalog } from './catalog.ts'
import { staffingSubjects, withScopeWording } from './catalog-staffing.ts'
import { referencedFieldIds, validateReportDefinition } from './engine.ts'
import {
	isStaffingReportSubject,
	operatorTokenAllowsSubject,
	RESTRICTED_REPORT_SUBJECTS,
	STAFF_PAY_REPORT_PERMISSION,
	STAFFING_REPORT_SUBJECTS,
} from './operator-token.ts'
import { organizationTemplates } from './templates.ts'

const STAFF_TEMPLATE_CATEGORIES = new Set(['Labor', 'Hiring'])

describe('staff report subjects', () => {
	it('are exactly the restricted staff subjects the token can grant', () => {
		expect(staffingSubjects.map((subject) => subject.id).sort()).toEqual(
			[...STAFFING_REPORT_SUBJECTS].sort(),
		)
		for (const id of STAFFING_REPORT_SUBJECTS) {
			expect(RESTRICTED_REPORT_SUBJECTS).toContain(id)
			expect(isStaffingReportSubject(id)).toBe(true)
		}
		expect(isStaffingReportSubject('orders')).toBe(false)
	})

	it('read the regional database and carry their scope’s time zone', () => {
		for (const subject of staffingSubjects) {
			expect(subject.source, subject.id).toBe('tenant-api')
			expect(subject.timeZoneField, subject.id).toBe('timeZone')
			expect(getField(subject, 'timeZone'), subject.id).toBeTruthy()
			expect(getSubject(organizationCatalog, subject.id)).toBe(subject)
		}
	})

	it('keep every field that names a permission pointing at a restricted subject', () => {
		for (const subject of organizationCatalog.subjects) {
			for (const field of subject.fields) {
				if (!field.requiresSubject) continue
				expect(
					RESTRICTED_REPORT_SUBJECTS,
					`${subject.id}.${field.id}`,
				).toContain(field.requiresSubject)
			}
		}
	})

	it('hide one person’s wages behind the pay permission', () => {
		const entries = getSubject(organizationCatalog, 'time_entries')!
		expect(getField(entries, 'cost')?.requiresSubject).toBe(
			STAFF_PAY_REPORT_PERMISSION,
		)
		// Daily labor is a scope total, so it needs only the labor grant.
		const daily = getSubject(organizationCatalog, 'labor_daily')!
		for (const field of daily.fields) {
			expect(field.requiresSubject, field.id).toBeUndefined()
		}
		// The pay permission is a marker, not a subject anyone can report on.
		expect(
			getSubject(organizationCatalog, STAFF_PAY_REPORT_PERMISSION),
		).toBeNull()
	})

	it('define each ratio field over two fields that exist and fit', () => {
		for (const subject of staffingSubjects) {
			for (const field of subject.fields.filter((f) => f.type === 'ratio')) {
				expect(field.listable, field.id).toBe(false)
				const numerator = getField(subject, field.ratio!.numerator)
				const denominator = getField(subject, field.ratio!.denominator)
				expect(numerator, field.id).toBeTruthy()
				expect(denominator, field.id).toBeTruthy()
				if (field.ratio!.unit === 'per_hour') {
					expect(denominator!.type).toBe('duration')
				}
			}
		}
	})

	it('only measure minutes with duration fields', () => {
		for (const subject of staffingSubjects) {
			for (const field of subject.fields) {
				if (/Minutes$/.test(field.id)) {
					expect(field.type, `${subject.id}.${field.id}`).toBe('duration')
				}
			}
		}
	})
})

describe('staff report templates', () => {
	const staffTemplates = organizationTemplates().filter((template) =>
		STAFF_TEMPLATE_CATEGORIES.has(template.category),
	)

	it('cover the planned reports', () => {
		const ids = staffTemplates.map((template) => template.id)
		expect(ids).toEqual(
			expect.arrayContaining([
				'labor-cost-percent-by-day',
				'hours-by-employee',
				'overtime-hours-by-week',
				'scheduled-vs-actual-hours',
				'on-time-arrival',
				'labor-by-position',
				'sales-per-labor-hour',
				'tip-pool',
				'applicant-funnel',
			]),
		)
	})

	it('all run against the catalog', () => {
		for (const template of staffTemplates) {
			expect(
				validateReportDefinition(organizationCatalog, template.definition),
				template.id,
			).toBeNull()
		}
	})

	it('use shares that are ratios of sums, never averages of percentages', () => {
		for (const template of staffTemplates) {
			const { measure, valueField } = template.definition.visualization
			expect(measure, template.id).not.toBe('average')
			if (
				valueField === 'laborCostPercent' ||
				valueField === 'salesPerLaborHour'
			) {
				expect(measure, template.id).toBe('ratio')
			}
		}
	})

	it('need no more permission than their subject, except wage reports', () => {
		const wageReports = staffTemplates.filter((template) => {
			const subject = getSubject(
				organizationCatalog,
				template.definition.subject,
			)!
			return [...referencedFieldIds(subject, template.definition)].some(
				(id) => getField(subject, id)?.requiresSubject === 'staff_pay',
			)
		})
		expect(wageReports.map((template) => template.id)).toEqual([
			'labor-by-position',
		])
	})

	it('are not reachable with a token that lacks the subject', () => {
		const withoutStaff = { subjects: ['orders', 'phone_calls'] as never[] }
		for (const template of staffTemplates) {
			expect(
				operatorTokenAllowsSubject(withoutStaff, template.definition.subject),
				template.id,
			).toBe(false)
		}
	})
})

describe('what a person is offered', () => {
	const staffIds = [...STAFFING_REPORT_SUBJECTS]
	const ids = (catalog: ReturnType<typeof catalogForGrants>) =>
		catalog.subjects.map((subject) => subject.id)

	it('hides every staff subject until the token grants it', () => {
		const none = catalogForGrants(organizationCatalog, ['phone_calls'])
		for (const id of staffIds) expect(ids(none)).not.toContain(id)
		expect(ids(none)).toContain('phone_calls')
		expect(ids(none)).toContain('customers')

		const some = catalogForGrants(organizationCatalog, ['labor_daily'])
		expect(ids(some)).toContain('labor_daily')
		expect(ids(some)).not.toContain('time_entries')
	})

	it('hides pay fields without the pay permission, and shows them with it', () => {
		const without = catalogForGrants(organizationCatalog, ['time_entries'])
		const hours = getSubject(without, 'time_entries')!
		expect(getField(hours, 'paidMinutes')).toBeTruthy()
		expect(getField(hours, 'cost')).toBeNull()
		const withPay = catalogForGrants(organizationCatalog, [
			'time_entries',
			'staff_pay',
		])
		expect(getField(getSubject(withPay, 'time_entries')!, 'cost')).toBeTruthy()
	})

	it('offers no staff template to someone with no staff access', () => {
		const offered = templatesForGrants(
			organizationCatalog,
			organizationTemplates(),
			[],
		)
		expect(
			offered.filter((template) =>
				STAFF_TEMPLATE_CATEGORIES.has(template.category),
			),
		).toEqual([])
		// Everything else is untouched, except the Reservations templates, which
		// need their own grant.
		expect(offered.length).toBe(
			organizationTemplates().filter(
				(template) =>
					!STAFF_TEMPLATE_CATEGORIES.has(template.category) &&
					template.category !== 'Reservations',
			).length,
		)
	})

	it('offers the wage template only with the pay permission', () => {
		const labor = ['time_entries', 'labor_daily']
		const noPay = templatesForGrants(
			organizationCatalog,
			organizationTemplates(),
			labor,
		).map((template) => template.id)
		expect(noPay).toContain('hours-by-employee')
		expect(noPay).toContain('labor-cost-percent-by-day')
		expect(noPay).not.toContain('labor-by-position')
		const withPay = templatesForGrants(
			organizationCatalog,
			organizationTemplates(),
			[...labor, 'staff_pay'],
		).map((template) => template.id)
		expect(withPay).toContain('labor-by-position')
	})

	it('refuses a saved report on a subject the person no longer has', () => {
		const labor = organizationTemplates().find(
			(template) => template.id === 'labor-cost-percent-by-day',
		)!
		expect(
			definitionAllowed(organizationCatalog, labor.definition, ['labor_daily']),
		).toBe(true)
		expect(definitionAllowed(organizationCatalog, labor.definition, [])).toBe(
			false,
		)
	})
})

describe('withScopeWording', () => {
	it('re-words workplace to the vertical name without touching ids', () => {
		const reworded = withScopeWording(staffingSubjects, 'location')
		const labor = reworded.find((subject) => subject.id === 'labor_daily')!
		expect(getField(labor, 'scope')?.label).toBe('Location')
		expect(JSON.stringify(reworded)).not.toMatch(/workplace/i)
		expect(reworded.map((subject) => subject.id)).toEqual(
			staffingSubjects.map((subject) => subject.id),
		)
	})
})
