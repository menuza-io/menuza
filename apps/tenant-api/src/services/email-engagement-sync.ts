import {
	fetchOciEngagementEvents,
	isOciEngagementLoggingConfigured,
	type OciEngagementEvent,
} from '@repo/email'
import {
	getTenantDb,
	listTenantOrgIds,
	marketingMessages,
	type MarketingMessage,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'

export type EmailEngagementSyncResult = {
	synced: boolean
	reason?: string
	eventsFetched: number
	eventsApplied: number
	orgsProcessed: number
}

const SYNC_THROTTLE_MS = 2 * 60 * 1000
const lastSyncedAtByOrg = new Map<string, number>()

export function resetEmailEngagementSyncThrottle() {
	lastSyncedAtByOrg.clear()
}

function shouldThrottleOrgSync(orgId: string, force: boolean) {
	if (force) return false
	const lastSyncedAt = lastSyncedAtByOrg.get(orgId)
	if (!lastSyncedAt) return false
	return Date.now() - lastSyncedAt < SYNC_THROTTLE_MS
}

function markOrgSynced(orgId: string) {
	lastSyncedAtByOrg.set(orgId, Date.now())
}

function buildMessageUpdates(
	existing: MarketingMessage,
	event: OciEngagementEvent,
) {
	const updates: Partial<MarketingMessage> = {}

	if (event.action === 'open') {
		if (!existing.openedAt) {
			updates.openedAt = event.occurredAt
		}
		if (existing.status === 'Sent' || existing.status === 'Processing') {
			updates.status = 'Opened'
		}
	}

	if (event.action === 'click') {
		if (!existing.clickedAt || event.occurredAt > existing.clickedAt) {
			updates.clickedAt = event.occurredAt
		}
		if (!existing.openedAt) {
			updates.openedAt = event.occurredAt
		}
		updates.status = 'Clicked'
	}

	return updates
}

async function applyEngagementEventsForOrg(
	orgId: string,
	events: OciEngagementEvent[],
) {
	const orgEvents = events.filter((event) => event.orgId === orgId)
	if (orgEvents.length === 0) {
		return 0
	}

	const db = await getTenantDb(orgId)
	let applied = 0

	for (const event of orgEvents) {
		const [existing] = await db
			.select()
			.from(marketingMessages)
			.where(eq(marketingMessages.id, event.messageId))

		if (!existing) continue

		const updates = buildMessageUpdates(existing, event)
		if (Object.keys(updates).length === 0) continue

		await db
			.update(marketingMessages)
			.set(updates)
			.where(eq(marketingMessages.id, event.messageId))
		applied++
	}

	return applied
}

export async function syncEmailEngagementForOrg(
	orgId: string,
	options?: { lookbackHours?: number; force?: boolean },
): Promise<EmailEngagementSyncResult> {
	if (!isOciEngagementLoggingConfigured()) {
		return {
			synced: false,
			reason: 'oci_engagement_logging_not_configured',
			eventsFetched: 0,
			eventsApplied: 0,
			orgsProcessed: 0,
		}
	}

	if (shouldThrottleOrgSync(orgId, Boolean(options?.force))) {
		return {
			synced: false,
			reason: 'throttled',
			eventsFetched: 0,
			eventsApplied: 0,
			orgsProcessed: 0,
		}
	}

	const events = await fetchOciEngagementEvents({
		lookbackHours: options?.lookbackHours,
		orgId,
	})
	const eventsApplied = await applyEngagementEventsForOrg(orgId, events)
	markOrgSynced(orgId)

	return {
		synced: true,
		eventsFetched: events.length,
		eventsApplied,
		orgsProcessed: 1,
	}
}

export async function syncEmailEngagementForAllOrgs(options?: {
	lookbackHours?: number
}): Promise<EmailEngagementSyncResult> {
	if (!isOciEngagementLoggingConfigured()) {
		return {
			synced: false,
			reason: 'oci_engagement_logging_not_configured',
			eventsFetched: 0,
			eventsApplied: 0,
			orgsProcessed: 0,
		}
	}

	const events = await fetchOciEngagementEvents({
		lookbackHours: options?.lookbackHours,
	})
	const orgIds = new Set<string>(await listTenantOrgIds())
	for (const event of events) {
		if (event.orgId) orgIds.add(event.orgId)
	}

	let eventsApplied = 0
	let orgsFailed = 0
	for (const orgId of orgIds) {
		// One org whose database is not on this node (deleted, moved region,
		// or another region's events) must not stop the rest of the run.
		try {
			eventsApplied += await applyEngagementEventsForOrg(orgId, events)
			markOrgSynced(orgId)
		} catch (error) {
			orgsFailed++
			console.error('Email engagement sync failed for organization', {
				orgId,
				error: error instanceof Error ? error.name : 'unknown',
				code: (error as { code?: unknown } | null)?.code,
			})
		}
	}

	return {
		synced: true,
		eventsFetched: events.length,
		eventsApplied,
		orgsProcessed: orgIds.size - orgsFailed,
	}
}

export async function ensureEmailEngagementSynced(
	orgId: string,
	options?: { force?: boolean },
) {
	await syncEmailEngagementForOrg(orgId, options)
}
