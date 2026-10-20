/**
 * Organization-wide report subjects (every customer and every shop order).
 * Only people with analytics, settings or website admin access may run them;
 * a module-only grant (staff reports) never covers them. Kept apart from the
 * token code so the browser-side access helpers can use it.
 */
export const ORG_WIDE_REPORT_SUBJECTS = ['customers', 'shop_orders'] as const

export function isOrgWideReportSubject(subject: string) {
	return ORG_WIDE_REPORT_SUBJECTS.some((orgWide) => orgWide === subject)
}
