import {
	DEFAULT_ORDER_ALERT_MINUTES,
	ordersAlertSettingsSchema,
	type OrdersAlertSettings,
} from '@repo/common/operator-alerts'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { largeOrderAlertRuleFor } from '#app/utils/alerts/large-order.server.ts'
import { loadAlertOrganization } from '#app/utils/alerts/order-alerts.server.ts'
import { isOrderAlertsEnabled } from '#app/utils/alerts/switches.server.ts'
import { openIntervalsAround } from '#app/utils/alerts/window.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const query = z.object({ orgId: z.string().min(1).max(64) })

/**
 * `GET /resources/orders/alert-settings?orgId=`: what the region needs before it
 * looks for anything to alert about (#131, #300, #190): whether the
 * organization has the order alerts on, per location how long an order may stay
 * New, when the location is open (so the region can keep its alerts to opening
 * hours without holding any hours itself) and the large-order alert threshold.
 * Settings and times only; no guest, no member. Internal token only.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}
	const parsed = query.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}
	const organization = await loadAlertOrganization(parsed.data.orgId)
	if (!organization) {
		return Response.json(
			{ error: 'org_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}
	const enabled = await isOrderAlertsEnabled(organization.id)
	const now = Date.now()
	const rows = enabled
		? await db
				.select({
					id: OrganizationLocation.id,
					timezone: OrganizationLocation.timezone,
					isActive: OrganizationLocation.isActive,
					storeHours: OrganizationLocation.storeHours,
					onlineHours: OrganizationLocation.onlineHours,
					specialHours: OrganizationLocation.specialHours,
					orderAlertMinutes: OrganizationLocation.orderAlertMinutes,
					largeOrderAlert: OrganizationLocation.largeOrderAlert,
					onlineOrderingSettings: OrganizationLocation.onlineOrderingSettings,
					largeOrderThreshold: OrganizationLocation.largeOrderThreshold,
					largeOrderThresholdType: OrganizationLocation.largeOrderThresholdType,
				})
				.from(OrganizationLocation)
				.where(
					and(
						eq(OrganizationLocation.organizationId, organization.id),
						eq(OrganizationLocation.isActive, true),
					),
				)
		: []
	const body: OrdersAlertSettings = {
		enabled,
		locations: rows.map((row) => {
			const { alert, rule } = largeOrderAlertRuleFor(row)
			return {
				id: row.id,
				waitingMinutes: row.orderAlertMinutes ?? DEFAULT_ORDER_ALERT_MINUTES,
				openIntervals: openIntervalsAround(row, now),
				largeOrder:
					alert?.enabled && rule
						? { ...rule, remindMinutes: alert.remindMinutes }
						: null,
			}
		}),
	}
	return Response.json(ordersAlertSettingsSchema.parse(body), {
		headers: NO_STORE,
	})
}
