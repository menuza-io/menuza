import {
	type OrganizationEventKind,
	isOrganizationEventKind,
	parseOrganizationEventPayload,
} from '@repo/common/organization-events'
import { OrganizationEvent, db, lt, sql } from '@repo/database'

/**
 * Writes one account event for the Admin Timeline (#279). The writers are the
 * handlers that already see these events: the Stripe webhook, the domain notify
 * path, the launch checklist, the trial reminder. Each call names a kind and
 * passes ids, states and dates; the payload is checked against that kind's
 * strict schema, so a key that could carry a guest's name, phone, email or
 * order is refused (nothing is written) rather than stored.
 *
 * It never throws: a timeline row must not fail a webhook or a job. A retried
 * webhook passes the same `dedupeKey` and writes once.
 */
export async function recordOrganizationEvent(input: {
	organizationId: string
	kind: OrganizationEventKind
	payload?: Record<string, unknown>
	locationId?: string | null
	dedupeKey?: string
	at?: Date
}): Promise<boolean> {
	try {
		if (!isOrganizationEventKind(input.kind)) return false
		const payload = parseOrganizationEventPayload(
			input.kind,
			input.payload ?? {},
		)
		const inserted = await db
			.insert(OrganizationEvent)
			.values({
				organizationId: input.organizationId,
				locationId: input.locationId ?? null,
				kind: input.kind,
				payload: JSON.stringify(payload),
				dedupeKey: input.dedupeKey ?? null,
				createdAt: input.at ?? new Date(),
			})
			.onConflictDoNothing()
			.returning({ id: OrganizationEvent.id })
		return inserted.length > 0
	} catch (error) {
		// The kind only: the payload is never logged.
		console.error('Could not record an organization event', {
			kind: input.kind,
			error: error instanceof Error ? error.name : 'unknown',
		})
		return false
	}
}

/**
 * Timeline events are kept for the organization's audit retention period (#279):
 * its `AuditLogRetentionPolicy` days, else the 365-day default the audit log
 * uses. Run by the hourly operator-alerts sweep (no new cron slot).
 */
export const DEFAULT_EVENT_RETENTION_DAYS = 365

export async function pruneOrganizationEvents(
	now = new Date(),
): Promise<number> {
	const removed = await db
		.delete(OrganizationEvent)
		.where(
			lt(
				OrganizationEvent.createdAt,
				sql`${now.getTime()} - coalesce((select policy."retentionDays" from "AuditLogRetentionPolicy" as policy where policy."organizationId" = "OrganizationEvent"."organizationId"), ${DEFAULT_EVENT_RETENTION_DAYS}) * 86400000`,
			),
		)
		.returning({ id: OrganizationEvent.id })
	return removed.length
}
