import { parseOnlineOrderingSettings } from '@repo/common/location-settings'
import {
	largeOrderAlertRule,
	largeOrderAlertSettingsSchema,
	type LargeOrderAlertRule,
} from '@repo/common/operator-alerts'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { isOrderAlertsEnabled } from './switches.server.ts'

/** The stored `OrganizationLocation.largeOrderAlert` JSON, or null when off or unreadable. */
export function readLargeOrderAlert(value: string | null) {
	if (!value) return null
	try {
		const parsed = largeOrderAlertSettingsSchema.safeParse(JSON.parse(value))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

/**
 * The rule an alert falls back on: the location's existing large-order rule (its
 * saved dish count and amount, else its older single threshold).
 */
export function largeOrderAlertRuleFor(row: {
	largeOrderAlert: string | null
	onlineOrderingSettings: string | null
	largeOrderThreshold: number | null
	largeOrderThresholdType: string | null
}) {
	const alert = readLargeOrderAlert(row.largeOrderAlert)
	const saved = parseOnlineOrderingSettings(
		row.onlineOrderingSettings,
	)?.largeOrder
	return {
		alert,
		rule: alert?.enabled
			? largeOrderAlertRule({
					alert,
					saved,
					threshold: row.largeOrderThreshold,
					thresholdType: row.largeOrderThresholdType,
				})
			: null,
	}
}

/**
 * The order context's `largeOrderAlert` (#300): per location, the threshold that
 * flags an order as large at placement. Empty unless the organization has
 * manager alerts on and the location turned "tell me about large orders" on, so
 * nothing is flagged (and nothing is alerted) for anyone who did not ask.
 */
export async function buildLargeOrderAlertContext(
	organizationId: string,
	locationId?: string | null,
): Promise<Record<string, LargeOrderAlertRule>> {
	if (!(await isOrderAlertsEnabled(organizationId))) return {}
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			largeOrderAlert: OrganizationLocation.largeOrderAlert,
			onlineOrderingSettings: OrganizationLocation.onlineOrderingSettings,
			largeOrderThreshold: OrganizationLocation.largeOrderThreshold,
			largeOrderThresholdType: OrganizationLocation.largeOrderThresholdType,
		})
		.from(OrganizationLocation)
		.where(
			locationId
				? and(
						eq(OrganizationLocation.organizationId, organizationId),
						eq(OrganizationLocation.id, locationId),
					)
				: eq(OrganizationLocation.organizationId, organizationId),
		)
	const out: Record<string, LargeOrderAlertRule> = {}
	for (const row of rows) {
		const { rule } = largeOrderAlertRuleFor(row)
		if (rule) out[row.id] = rule
	}
	return out
}
