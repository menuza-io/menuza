import { isImpersonating, userHasOrganizationPermission } from '@repo/auth'
import {
	ACCOUNTING_REPORT_SUBJECT,
	DELIVERY_REPORT_SUBJECTS,
	ORDER_REPORT_SUBJECTS,
	ORG_WIDE_REPORT_SUBJECTS,
	SALES_STAFF_FIELD_PERMISSION,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import { resolveGiftCardReportAccess } from '#app/utils/gift-cards/report-access.server.ts'
import { resolveInventoryReportAccess } from '#app/utils/inventory/report-access.server.ts'
import { isInHouseDeliveryEnabled } from '#app/utils/orders/deliveries.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import {
	intersectScopeIds,
	resolveReservationsReportAccess,
} from '#app/utils/reservations/report-access.server.ts'
import { resolveStaffReportAccess } from '#app/utils/staffing/report-access.server.ts'
import {
	canReadSalesStaffFields,
	hasAdminReportAccess,
} from '#app/utils/staffing/report-grants.server.ts'
import { isAccountingEnabled } from './accounting-flag.ts'

/**
 * What a member's reports token carries: the restricted subjects they may run,
 * and the scopes and locations those subjects are limited to. One resolver for
 * the browser's token route (`reports+/token.ts`) and for jobs that run a
 * report for a member who is not at a keyboard (scheduled report emails #121,
 * the monthly results email #221), so an email can never reach further than
 * the member's own token would.
 */
export type ReportTokenGrants = {
	hasAdminAccess: boolean
	/** True when the member may run at least one regional report. */
	hasAnyGrant: boolean
	subjects: RestrictedReportSubject[]
	scopeIds: string[] | null
	/** Locations the sales subjects are limited to; undefined when sales are not granted. */
	locationIds: string[] | null | undefined
}

export async function resolveReportTokenGrants(input: {
	request: Request
	userId: string
	organizationId: string
}): Promise<ReportTokenGrants> {
	const { request, userId, organizationId } = input
	const impersonated = await isImpersonating(request)
	const hasAdminAccess = await hasAdminReportAccess(userId, organizationId)
	// Call reports include caller numbers, so they also need call access.
	// Order reports follow the orders page, which menu access covers (and, as
	// before, only for people who can run reports at all).
	const [canReadPhoneCalls, canReadOrders] = await Promise.all([
		hasAdminAccess &&
			userHasOrganizationPermission(
				userId,
				organizationId,
				ORG_PERMISSIONS.READ_PHONE_CALL_ANY,
			),
		hasAdminAccess &&
			userHasOrganizationPermission(
				userId,
				organizationId,
				ORG_PERMISSIONS.READ_MENU_ANY,
			),
	])
	const canReadSalesStaff =
		canReadOrders &&
		(await canReadSalesStaffFields(userId, organizationId, impersonated))
	// Staff reports (time cards, shifts, daily labor, applications) follow the
	// staffing flags, the staffing permissions, and the person's scope grants.
	const staff = await resolveStaffReportAccess({
		userId,
		organizationId,
		impersonated,
	})
	// Bookings, waitlist and pacing reports need the reservation report grant
	// and the master Reservations flag, limited to the person's locations.
	const reservations = await resolveReservationsReportAccess({
		request,
		userId,
		organizationId,
	})
	// Gift card reports follow the gift_cards.enabled flag and
	// `read:gift_card:any`, limited to the person's locations.
	const giftCards = await resolveGiftCardReportAccess({
		request,
		userId,
		organizationId,
	})
	const inventory = await resolveInventoryReportAccess({
		request,
		userId,
		organizationId,
	})
	const hasAnyGrant =
		hasAdminAccess ||
		staff.subjects.length > 0 ||
		reservations.subjects.length > 0 ||
		giftCards.subjects.length > 0 ||
		inventory.subjects.length > 0
	// Each module that grants subjects limits the token to its own scopes; the
	// token carries the narrowest of them. With none granted, staff's (empty).
	const scoped = [staff, reservations, giftCards, inventory].filter(
		(module) => module.subjects.length > 0,
	)
	const scopeIds =
		scoped.length === 0
			? staff.scopeIds
			: scoped
					.map((module) => module.scopeIds)
					.reduce<string[] | null>(
						(narrow, next, index) =>
							index === 0 ? next : intersectScopeIds(narrow, next),
						null,
					)
	// Own-driver delivery reports (#324): only with `delivery.in_house` on, and
	// for members who may read orders. The driver's name rides on the staff grant.
	const canReadDeliveries =
		canReadOrders && (await isInHouseDeliveryEnabled(organizationId))
	// The accounting export (#189): behind its flag, for members who may read
	// orders (the money grants the sales reports need), limited to their locations.
	const canExportAccounting =
		canReadOrders && (await isAccountingEnabled(organizationId))
	const subjects: RestrictedReportSubject[] = [
		// A module-only grant never lists the organization-wide subjects.
		...(hasAdminAccess ? ORG_WIDE_REPORT_SUBJECTS : []),
		...(canReadPhoneCalls ? (['phone_calls'] as const) : []),
		...(canReadOrders ? ORDER_REPORT_SUBJECTS : []),
		...(canReadDeliveries ? DELIVERY_REPORT_SUBJECTS : []),
		...(canExportAccounting ? [ACCOUNTING_REPORT_SUBJECT] : []),
		...(canReadSalesStaff ? [SALES_STAFF_FIELD_PERMISSION] : []),
		...staff.subjects,
		...reservations.subjects,
		...giftCards.subjects,
		...inventory.subjects,
	]
	// Sales subjects need a location limit on the token (same ids as Reservations).
	const locationIds = canReadOrders
		? await resolveReservationsLocationIds(userId, organizationId)
		: undefined
	return { hasAdminAccess, hasAnyGrant, subjects, scopeIds, locationIds }
}

/**
 * The same resolution for a member with no session (a job): never
 * impersonated, so the request is a placeholder with no cookies.
 */
export function resolveReportTokenGrantsForMember(input: {
	userId: string
	organizationId: string
}): Promise<ReportTokenGrants> {
	return resolveReportTokenGrants({
		request: new Request('https://job.invalid/'),
		...input,
	})
}
