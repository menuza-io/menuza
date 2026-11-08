/**
 * Organization-wide report subjects (every customer, every text subscriber and
 * every shop order).
 * Only people with analytics, settings or website admin access may run them;
 * a module-only grant (staff reports) never covers them. Kept apart from the
 * token code so the browser-side access helpers can use it.
 */
export const ORG_WIDE_REPORT_SUBJECTS = [
	'customers',
	'text_subscribers',
	'shop_orders',
] as const

export function isOrgWideReportSubject(subject: string) {
	return ORG_WIDE_REPORT_SUBJECTS.some((orgWide) => orgWide === subject)
}

/**
 * Organization subjects that need the same permission as their app page: the
 * member list needs `read:member:any`, notes need `read:note:own`. Like the
 * subjects above they exist for someone only while their grants list them.
 */
export const PERMISSION_GATED_REPORT_SUBJECTS = {
	members: 'read:member:any',
	notes: 'read:note:own',
} as const

export function isPermissionGatedReportSubject(subject: string) {
	return Object.prototype.hasOwnProperty.call(
		PERMISSION_GATED_REPORT_SUBJECTS,
		subject,
	)
}
