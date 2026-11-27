import { type ReportCatalog, getSubject } from './catalog.ts'
import { type ReportDefinition } from './dsl.ts'
import { referencedFieldIds } from './engine.ts'

/**
 * Report fields that hold a person's name, phone or email (a guest, a caller,
 * a reviewer, a staff member). A scheduled report is emailed outside the
 * browser session that could read it, so it may only carry aggregate,
 * non-personal fields (#121): a definition that reads, groups by or filters on
 * one of these cannot be scheduled (`report_has_personal_fields`). One list
 * for the App and the region, which both refuse.
 *
 * Adding a catalog field with a person's name, phone or email means adding it
 * here: `personal-fields.test.ts` scans the whole catalog and fails when a
 * field that looks personal is in neither this list nor its allowlist.
 */
export const PERSONAL_REPORT_FIELDS: Readonly<Record<string, readonly string[]>> =
	{
		orders: ['customerName', 'customerPhone', 'customerEmail'],
		shop_orders: ['customerName', 'customerPhone', 'customerEmail'],
		customers: ['name', 'email', 'phone'],
		text_subscribers: ['customerName', 'customerPhone'],
		reviews: ['reviewer'],
		phone_calls: ['callerPhone'],
		time_entries: ['employee'],
		shifts: ['employee'],
		members: ['name', 'email'],
		sales: ['staffName'],
		cancelled_orders: ['staffName', 'guestName'],
		cash_drawer_shifts: ['cashierName', 'closedByName', 'remoteCloserName'],
		cash_drawer_movements: ['staffName', 'approvedByName'],
	}

export const REPORT_HAS_PERSONAL_FIELDS = 'report_has_personal_fields' as const

export function isPersonalReportField(subjectId: string, fieldId: string) {
	return PERSONAL_REPORT_FIELDS[subjectId]?.includes(fieldId) === true
}

/**
 * The personal fields a definition reads, as `subject.field` ids (empty when
 * it can be scheduled). Counts columns, group-bys, filters, the time field and
 * the measured field alike.
 */
export function personalFieldsUsed(
	catalog: ReportCatalog,
	definition: ReportDefinition,
): string[] {
	const subject = getSubject(catalog, definition.subject)
	if (!subject) return []
	return [...referencedFieldIds(subject, definition)]
		.filter((fieldId) => isPersonalReportField(subject.id, fieldId))
		.sort()
		.map((fieldId) => `${subject.id}.${fieldId}`)
}
