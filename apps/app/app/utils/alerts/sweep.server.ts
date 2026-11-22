import { BUSY_ALERT_MS, PAUSE_ALERT_MS } from '@repo/common/operator-alerts'
import { and, db, eq, isNotNull, OrganizationLocation } from '@repo/database'
import { releaseHeldAlerts } from './held.server.ts'
import {
	deliverOrderAlert,
	loadAlertLocation,
	loadAlertOrganization,
	requestsFromPause,
} from './order-alerts.server.ts'
import { pruneAlertLog } from './policy.server.ts'
import { processOperatorPushReceipts } from './push.server.ts'
import { isOrderAlertsEnabled } from './switches.server.ts'

/**
 * The App half of the alerts' timing (#106, #131, #366): what the hourly sweep
 * and the `OperatorAlertsWorkflow` wake-up (jobs-cron, no extra cron slot) run.
 * - Ordering paused for over two hours, or busy mode on for over three, alerts
 *   the location's managers once per pause (the log's unique key is the claim).
 * - Alerts held by quiet hours are sent when those end.
 * - Push receipts: tokens the push service reports dead are removed.
 * - The alert log is pruned after 90 days.
 */
export type SweepResult = {
	pauseAlerts: number
	released: number
	dropped: number
	deferred: number
	receiptsChecked: number
	removedDevices: number
}

/** Ordering controls that have been on long enough to alert about. */
export async function alertLongOrderingControls(
	now = Date.now(),
): Promise<number> {
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			organizationId: OrganizationLocation.organizationId,
			orderingPausedAt: OrganizationLocation.orderingPausedAt,
			orderingPausedUntil: OrganizationLocation.orderingPausedUntil,
			busyExtraPrepMinutes: OrganizationLocation.busyExtraPrepMinutes,
			busyUntil: OrganizationLocation.busyUntil,
			busyStartedAt: OrganizationLocation.busyStartedAt,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.isActive, true),
				// Either control on: the rest is checked below.
				isNotNull(OrganizationLocation.orderingPausedAt),
			),
		)
	const busyRows = await db
		.select({
			id: OrganizationLocation.id,
			organizationId: OrganizationLocation.organizationId,
			orderingPausedAt: OrganizationLocation.orderingPausedAt,
			orderingPausedUntil: OrganizationLocation.orderingPausedUntil,
			busyExtraPrepMinutes: OrganizationLocation.busyExtraPrepMinutes,
			busyUntil: OrganizationLocation.busyUntil,
			busyStartedAt: OrganizationLocation.busyStartedAt,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.isActive, true),
				isNotNull(OrganizationLocation.busyStartedAt),
			),
		)
	const seen = new Set<string>()
	let alerted = 0
	const enabledOrgs = new Map<string, boolean>()
	for (const row of [...rows, ...busyRows]) {
		if (seen.has(row.id)) continue
		seen.add(row.id)
		let enabled = enabledOrgs.get(row.organizationId)
		if (enabled === undefined) {
			enabled = await isOrderAlertsEnabled(row.organizationId)
			enabledOrgs.set(row.organizationId, enabled)
		}
		if (!enabled) continue

		const pausedAt = row.orderingPausedAt?.getTime() ?? null
		const pauseActive =
			pausedAt !== null &&
			(row.orderingPausedUntil === null ||
				row.orderingPausedUntil.getTime() > now)
		const busyStart = row.busyStartedAt?.getTime() ?? null
		const busyActive =
			busyStart !== null &&
			row.busyExtraPrepMinutes !== null &&
			(row.busyUntil === null || row.busyUntil.getTime() > now)

		const due: Array<{ mode: 'paused' | 'busy'; since: number }> = []
		if (pauseActive && now - pausedAt! >= PAUSE_ALERT_MS) {
			due.push({ mode: 'paused', since: pausedAt! })
		}
		if (busyActive && now - busyStart! >= BUSY_ALERT_MS) {
			due.push({ mode: 'busy', since: busyStart! })
		}
		if (due.length === 0) continue
		const organization = await loadAlertOrganization(row.organizationId)
		const location = await loadAlertLocation(row.organizationId, row.id)
		if (!organization || !location) continue
		for (const item of due) {
			const result = await deliverOrderAlert({
				organization,
				location,
				requests: requestsFromPause({
					locationId: row.id,
					mode: item.mode,
					since: item.since,
					now,
				}),
				now,
			})
			alerted += result.inApp + result.emailed + result.pushed
		}
	}
	return alerted
}

export async function runOperatorAlertsSweep(
	now = Date.now(),
): Promise<SweepResult> {
	const pauseAlerts = await alertLongOrderingControls(now)
	const held = await releaseHeldAlerts(now)
	const receipts = await processOperatorPushReceipts(now)
	await pruneAlertLog(now)
	return {
		pauseAlerts,
		released: held.released,
		dropped: held.dropped,
		deferred: held.deferred,
		receiptsChecked: receipts.checked,
		removedDevices: receipts.removedDevices,
	}
}
