import { type InventoryNotifyKind } from '@repo/inventory'
import {
	getInventoryFeatureState,
	getUserInventoryGrants,
} from './access.server.ts'
import {
	INVENTORY_ALERT_GRANTS,
	INVENTORY_ALERT_MARKER_TYPE,
	INVENTORY_ALERT_TYPE_PREFIX,
	inventoryAlertAllowedFor,
	inventoryAlertKindFromNotificationType,
} from './manager-alerts.ts'

/**
 * Inventory alerts already in a member's list stay hidden once they could no
 * longer be opened: the organization turned the module off (or Purchasing, for
 * the kinds that point at it), or the member's role no longer holds an
 * inventory grant (or the cost grant, for a kind that carries money). The rows
 * hold only a kind, a location id and a count, but a module that is off must
 * not show up anywhere.
 */

export function isInventoryNotificationType(type: string): boolean {
	return type.startsWith(INVENTORY_ALERT_TYPE_PREFIX)
}

const PURCHASING_KINDS: readonly InventoryNotifyKind[] = [
	'inventory_delivery_due',
	'inventory_price_rise',
]

/**
 * Organization ids (from `organizationIds`) where the member may see an alert
 * of `kind` (any inventory alert when omitted: the least strict test, used for
 * the settings page).
 */
export async function inventoryAlertVisibleOrgIds(
	userId: string,
	organizationIds: Iterable<string>,
	kind?: InventoryNotifyKind,
): Promise<Set<string>> {
	const visible = new Set<string>()
	await Promise.all(
		[...new Set(organizationIds)].map(async (organizationId) => {
			try {
				const features = await getInventoryFeatureState(organizationId)
				if (!features.enabled) return
				if (kind && PURCHASING_KINDS.includes(kind) && !features.purchasing) {
					return
				}
				const held = new Set<string>(
					await getUserInventoryGrants(userId, organizationId),
				)
				const allowed = kind
					? inventoryAlertAllowedFor(kind, held)
					: INVENTORY_ALERT_GRANTS.some((grant) => held.has(grant))
				if (allowed) visible.add(organizationId)
			} catch {
				// Cannot tell: hide rather than show.
			}
		}),
	)
	return visible
}

/** Whether the settings page should offer a kind (cost-bearing kinds need the cost grant). */
export async function inventoryAlertSettingsVisible(
	userId: string,
	organizationId: string,
): Promise<{ any: boolean; priceRise: boolean }> {
	const [anyOrgs, priceOrgs] = await Promise.all([
		inventoryAlertVisibleOrgIds(userId, [organizationId]),
		inventoryAlertVisibleOrgIds(
			userId,
			[organizationId],
			'inventory_price_rise',
		),
	])
	return {
		any: anyOrgs.has(organizationId),
		priceRise: priceOrgs.has(organizationId),
	}
}

type Row = { type: string; organizationId: string }

async function visibleRows<T extends Row>(
	userId: string,
	alerts: readonly T[],
): Promise<T[]> {
	const kinds = new Map<InventoryNotifyKind, T[]>()
	for (const alert of alerts) {
		const kind = inventoryAlertKindFromNotificationType(alert.type)
		if (!kind) continue
		kinds.set(kind, [...(kinds.get(kind) ?? []), alert])
	}
	const shown = new Set<T>()
	for (const [kind, rows] of kinds) {
		const orgs = await inventoryAlertVisibleOrgIds(
			userId,
			rows.map((row) => row.organizationId),
			kind,
		)
		for (const row of rows) if (orgs.has(row.organizationId)) shown.add(row)
	}
	return alerts.filter((alert) => shown.has(alert))
}

export async function countVisibleInventoryAlerts(
	userId: string,
	alerts: ReadonlyArray<Row>,
): Promise<number> {
	if (alerts.length === 0) return 0
	return (await visibleRows(userId, alerts)).length
}

/** Drops inventory alerts the member can no longer open and the email-only markers. */
export async function filterVisibleInventoryNotifications<T extends Row>(
	userId: string,
	notifications: readonly T[],
): Promise<T[]> {
	const alerts = notifications.filter((n) =>
		isInventoryNotificationType(n.type),
	)
	if (alerts.length === 0) return [...notifications]
	const shown = new Set(await visibleRows(userId, alerts))
	return notifications.filter(
		(n) =>
			!isInventoryNotificationType(n.type) ||
			(n.type !== INVENTORY_ALERT_MARKER_TYPE && shown.has(n)),
	)
}
