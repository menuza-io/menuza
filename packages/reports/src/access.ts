import { type ReportCatalog, type ReportSubject, getField } from './catalog.ts'
import { isReservationsReportSubject } from './catalog-reservations.ts'
import {
	STAFF_PAY_REPORT_PERMISSION,
	isStaffingReportSubject,
} from './catalog-staffing.ts'
import { type ReportDefinition } from './dsl.ts'
import { referencedFieldIds } from './engine.ts'
import { type ReportTemplate } from './templates.ts'

/**
 * What a person is offered in the Reports screens. Staff subjects (time cards,
 * shifts, daily labor, applications) and the fields that show one person's pay
 * exist for someone only while their token grants them: with the staffing flag
 * off or without the permission, they are absent from the subject list, the
 * field pickers and the templates, as if the module did not exist. The regional
 * API enforces the same grants again on every run; this is the part the person
 * can see.
 *
 * `granted` is the restricted subjects the reports token lists.
 */

function isGatedSubject(subject: string) {
	return (
		isStaffingReportSubject(subject) || isReservationsReportSubject(subject)
	)
}

function fieldAvailable(
	field: { requiresSubject?: string },
	granted: ReadonlySet<string>,
) {
	return (
		field.requiresSubject !== STAFF_PAY_REPORT_PERMISSION ||
		granted.has(STAFF_PAY_REPORT_PERMISSION)
	)
}

/** The catalog without the staff subjects and pay fields `granted` does not cover. */
export function catalogForGrants(
	catalog: ReportCatalog,
	granted: readonly string[],
): ReportCatalog {
	const set = new Set(granted)
	const subjects: ReportSubject[] = []
	for (const subject of catalog.subjects) {
		if (isGatedSubject(subject.id) && !set.has(subject.id)) continue
		subjects.push({
			...subject,
			fields: subject.fields.filter((field) => fieldAvailable(field, set)),
		})
	}
	return { ...catalog, subjects }
}

/**
 * Whether `granted` covers everything a definition reads from `catalog` (the
 * full catalog): its subject if that is a staff subject, and any field that
 * shows one person's pay. Anything else is left to the run itself, so a saved
 * report is never hidden for reasons that are not about access.
 */
export function definitionAllowed(
	catalog: ReportCatalog,
	definition: ReportDefinition,
	granted: readonly string[],
): boolean {
	const set = new Set(granted)
	const subject = catalog.subjects.find(
		(item) => item.id === definition.subject,
	)
	if (!subject) return true
	if (isGatedSubject(subject.id) && !set.has(subject.id)) return false
	for (const id of referencedFieldIds(subject, definition)) {
		const field = getField(subject, id)
		if (field && !fieldAvailable(field, set)) return false
	}
	return true
}

/** Templates `granted` covers. */
export function templatesForGrants(
	catalog: ReportCatalog,
	templates: readonly ReportTemplate[],
	granted: readonly string[],
): ReportTemplate[] {
	return templates.filter((template) =>
		definitionAllowed(catalog, template.definition, granted),
	)
}
