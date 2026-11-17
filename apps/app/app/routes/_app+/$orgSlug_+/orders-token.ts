import {
	isImpersonating,
	ORG_PERMISSIONS,
	userHasOrganizationPermission,
} from '@repo/auth'
import { db, eq, User } from '@repo/database'
import { LOYALTY_PERMISSIONS } from '@repo/loyalty'
import { data, type LoaderFunctionArgs } from 'react-router'
import {
	getUserLoyaltyGrants,
	resolveLoyaltyLocationIds,
} from '#app/utils/loyalty/access.server.ts'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { getOrderCustomerLinkAccess } from '#app/utils/orders/customer-link.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { getStationAppGrants } from '#app/utils/pos/station-apps.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	const url = new URL(request.url)
	const shiftCloseOnly = url.searchParams.get('shift') === '1'
	const scope =
		!shiftCloseOnly && url.searchParams.get('write') === '1'
			? 'orders:write'
			: 'orders:read'
	const userId =
		scope === 'orders:write'
			? await requireMenuWrite(request, organization.id)
			: await requireMenuRead(request, organization.id)
	// Signed claims say which person pages this member may open, so the
	// regional API returns a `customerKey` only when the link will work.
	const link = await getOrderCustomerLinkAccess(request, params.orgSlug || '')
	// Which Station apps this member may switch on for a terminal: each needs its
	// own module's settings permission, not only the menu one.
	const stationApps =
		scope === 'orders:write'
			? await getStationAppGrants(request, organization.id)
			: null
	const [locationIds, impersonated] = await Promise.all([
		resolveLoyaltyLocationIds(userId, organization.id),
		isImpersonating(request),
	])
	// A refund on an order loyalty tracks takes points back and restores
	// rewards, so it also needs the loyalty redemption grant.
	const refundLoyalty =
		scope === 'orders:write' &&
		!impersonated &&
		(await getUserLoyaltyGrants(userId, organization.id)).includes(
			LOYALTY_PERMISSIONS.UPDATE_LOYALTY_REDEMPTION,
		)
	// Cancelling a paid online order with a refund returns money through the
	// payment provider: only for holders of the order refund permission, and
	// never while an admin is impersonating.
	const refundProvider =
		scope === 'orders:write' &&
		!impersonated &&
		(await userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_ORDER_REFUND_ANY,
		))
	const wantsShiftClose = shiftCloseOnly || scope === 'orders:write'
	const closeShifts =
		wantsShiftClose &&
		!impersonated &&
		(await userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_POS_SHIFT_ANY,
		))
	if (shiftCloseOnly && !closeShifts) {
		throw new Response('Forbidden', { status: 403 })
	}
	let operatorName: string | undefined
	if (closeShifts) {
		const [operator] = await db
			.select({ name: User.name, username: User.username, email: User.email })
			.from(User)
			.where(eq(User.id, userId))
		operatorName =
			operator?.name?.trim() || operator?.username || operator?.email || userId
	}
	const claims = {
		...(link.linkCustomers || link.linkGuests ? link : {}),
		...(stationApps &&
		(stationApps.timeclock || stationApps.reservations || stationApps.inventory)
			? { stationApps }
			: {}),
		locationIds,
		...(impersonated ? { impersonated: true } : {}),
		...(refundLoyalty ? { refundLoyalty: true } : {}),
		...(refundProvider ? { refundProvider: true } : {}),
		...(closeShifts ? { closeShifts: true, operatorName } : {}),
	}
	const { jwt, tenantApiUrl } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
		{ scope, claims },
	)
	return data(
		{ jwt, tenantApiUrl },
		{
			headers: { 'Cache-Control': 'private, no-store' },
		},
	)
}
