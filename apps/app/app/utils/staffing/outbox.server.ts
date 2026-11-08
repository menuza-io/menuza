import {
	and,
	asc,
	db,
	eq,
	inArray,
	lt,
	lte,
	Organization,
	sql,
	StaffingOutbox,
} from '@repo/database'
import {
	STAFFING_OUTBOX_PATHS,
	STAFFING_OUTBOX_PAYLOAD_SCHEMAS,
	type StaffingOutboxKind,
} from '@repo/staffing'
import { postRegionalStaffInternal } from './regional-internal.server.ts'

/**
 * Control-plane outbox for staffing events that must reach the regional
 * database: link a login to a staff row (`link_user`), detach it
 * (`unlink_user`), anonymize it after account erasure (`erase_user`).
 *
 * Rows carry opaque ids only (never names, contact details, pay or times), so
 * nothing about a person is stored in the US control plane. Delivery is
 * at-least-once and every regional endpoint is idempotent.
 *
 * Who delivers:
 * 1. a best-effort attempt right after the row is enqueued (so a fresh link
 *    shows up immediately), and
 * 2. the `jobs.staffing-outbox` App route, driven by the existing `0 4 * * *`
 *    cron trigger (no new cron slot), which retries everything still pending
 *    with exponential backoff.
 *
 * Events for the same login in the same organization are delivered in the order
 * they were enqueued: a later event waits while an earlier one is pending, so an
 * erase can never overtake the unlink queued before it.
 */

export const OUTBOX_MAX_ATTEMPTS = 20
export const OUTBOX_BACKOFF_BASE_MS = 60_000
export const OUTBOX_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000
/** A row being delivered is hidden from other drains for this long. */
export const OUTBOX_LEASE_MS = 2 * 60 * 1000
export const OUTBOX_DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const OUTBOX_FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PENDING_LOAD_LIMIT = 1000

/** Exponential backoff: 1 min, 2, 4, ... capped at 24 hours. */
export function outboxBackoffMs(attempts: number): number {
	const exponent = Math.max(0, Math.min(attempts - 1, 20))
	return Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** exponent, OUTBOX_BACKOFF_MAX_MS)
}

export type EnqueueInput<K extends StaffingOutboxKind = StaffingOutboxKind> = {
	organizationId: string
	kind: K
	payload: Record<string, string>
	/**
	 * Queue even while the organization's database is marked unprovisioned
	 * (used by `erase_user`: a failed region switch clears the flag while the
	 * old database, and the staff row in it, may still exist).
	 */
	evenIfUnprovisioned?: boolean
}

/**
 * Queues an event. The payload is validated against the kind's strict schema
 * (ids only, unknown keys rejected). Organizations without a regional database
 * have nothing to deliver to, so no row is written and `null` is returned.
 */
export async function enqueueStaffingOutbox<K extends StaffingOutboxKind>(
	input: EnqueueInput<K>,
): Promise<string | null> {
	const payload = STAFFING_OUTBOX_PAYLOAD_SCHEMAS[input.kind].parse(
		input.payload,
	)
	const [organization] = await db
		.select({ hasProvisionedDb: Organization.hasProvisionedDb })
		.from(Organization)
		.where(eq(Organization.id, input.organizationId))
		.limit(1)
	if (!organization) return null
	if (!organization.hasProvisionedDb && !input.evenIfUnprovisioned) return null
	const [row] = await db
		.insert(StaffingOutbox)
		.values({
			organizationId: input.organizationId,
			kind: input.kind,
			payload,
		})
		.returning({ id: StaffingOutbox.id })
	return row?.id ?? null
}

type OutboxRow = typeof StaffingOutbox.$inferSelect
type DeliveryOutcome =
	| { result: 'done' }
	| { result: 'retry'; error: string }
	| { result: 'dead'; error: string }

/** A short code that is safe to store: never a body, a name, or a stack. */
function safeCode(value: unknown): string {
	return (
		String(value ?? 'unknown')
			.toLowerCase()
			.replace(/[^a-z0-9_.:-]/g, '_')
			.slice(0, 80) || 'unknown'
	)
}

/** Responses worth retrying: the node or the network may recover. */
const RETRYABLE_STATUSES = new Set([401, 408, 425, 429, 500, 502, 503, 504])

async function deliver(
	row: OutboxRow,
	dataRegion: string,
	timeoutMs: number,
): Promise<DeliveryOutcome> {
	const kind = row.kind as StaffingOutboxKind
	const schema = STAFFING_OUTBOX_PAYLOAD_SCHEMAS[kind]
	const path = STAFFING_OUTBOX_PATHS[kind]
	if (!schema || !path) return { result: 'dead', error: 'unknown_kind' }
	const payload = schema.safeParse(row.payload)
	if (!payload.success) return { result: 'dead', error: 'invalid_payload' }

	let response: Response
	try {
		response = await postRegionalStaffInternal({
			dataRegion,
			path,
			body: { orgId: row.organizationId, ...payload.data },
			timeoutMs,
		})
	} catch (error) {
		return {
			result: 'retry',
			error: `network:${safeCode(error instanceof Error ? error.name : '')}`,
		}
	}
	if (response.ok) return { result: 'done' }
	let code = `http_${response.status}`
	try {
		const body = (await response.json()) as { error?: unknown }
		if (typeof body.error === 'string') code = safeCode(body.error)
	} catch {
		// Keep the status code.
	}
	// A database that is not provisioned right now may be mid region switch
	// (or a switch failed and will be retried), so the event waits for it
	// rather than being dropped; the attempt cap still bounds it.
	const retryable =
		RETRYABLE_STATUSES.has(response.status) ||
		(response.status === 404 && code === 'org_not_provisioned')
	return retryable
		? { result: 'retry', error: code }
		: { result: 'dead', error: code }
}

export type DrainResult = {
	attempted: number
	done: number
	retried: number
	failed: number
	/** Rows left waiting behind an earlier event for the same login. */
	waiting: number
	purged: number
}

export type DrainOptions = {
	now?: Date
	/** Limit to one organization (and, with `userId`, one login). */
	organizationId?: string
	userId?: string
	/** Rows delivered in one run. */
	limit?: number
	timeoutMs?: number
	/** Skip deleting old finished rows (the inline path never purges). */
	purge?: boolean
}

function userKey(row: OutboxRow): string {
	const payload = row.payload as { userId?: unknown } | null
	return `${row.organizationId}:${typeof payload?.userId === 'string' ? payload.userId : ''}`
}

/**
 * Delivers due events. Each organization's region comes from the control
 * plane's own record, so a region switch never sends an old event to the wrong
 * node.
 */
export async function drainStaffingOutbox(
	options: DrainOptions = {},
): Promise<DrainResult> {
	const now = options.now ?? new Date()
	/**
	 * Due checks and leases use the wall clock at the moment they happen, not the
	 * moment the drain started: a long drain would otherwise lease rows with a
	 * lease that has already expired. `options.now` may only move this later
	 * (and feeds backoff).
	 */
	const effectiveNow = () => new Date(Math.max(now.getTime(), Date.now()))
	const limit = options.limit ?? 200
	const timeoutMs = options.timeoutMs ?? 10_000
	const result: DrainResult = {
		attempted: 0,
		done: 0,
		retried: 0,
		failed: 0,
		waiting: 0,
		purged: 0,
	}

	// Only logins whose oldest pending event is due are loaded (with the rest of
	// their queue behind it), so a backlog of backed-off rows can never push
	// newer due rows out of the load window.
	const scope = and(
		options.organizationId
			? eq(StaffingOutbox.organizationId, options.organizationId)
			: undefined,
		options.userId
			? sql`coalesce(json_extract(${StaffingOutbox.payload}, '$.userId'), '') = ${options.userId}`
			: undefined,
	)
	const heads = await db
		.select({
			organizationId: StaffingOutbox.organizationId,
			userId: sql<string>`coalesce(json_extract(${StaffingOutbox.payload}, '$.userId'), '')`,
		})
		.from(StaffingOutbox)
		.where(
			and(
				eq(StaffingOutbox.status, 'pending'),
				lte(StaffingOutbox.nextAttemptAt, effectiveNow()),
				scope,
				sql`not exists (
					select 1 from "StaffingOutbox" as earlier
					where earlier.status = 'pending'
						and earlier."organizationId" = ${StaffingOutbox.organizationId}
						and coalesce(json_extract(earlier.payload, '$.userId'), '') = coalesce(json_extract(${StaffingOutbox.payload}, '$.userId'), '')
						and (earlier."createdAt" < ${StaffingOutbox.createdAt}
							or (earlier."createdAt" = ${StaffingOutbox.createdAt} and earlier.rowid < "StaffingOutbox".rowid))
				)`,
			),
		)
		.orderBy(asc(StaffingOutbox.createdAt), asc(sql`rowid`))
		.limit(PENDING_LOAD_LIMIT)
	const headKeys = new Set(heads.map((h) => `${h.organizationId}:${h.userId}`))
	const pending = heads.length
		? (
				await db
					.select()
					.from(StaffingOutbox)
					.where(
						and(
							eq(StaffingOutbox.status, 'pending'),
							inArray(StaffingOutbox.organizationId, [
								...new Set(heads.map((h) => h.organizationId)),
							]),
							inArray(
								sql`coalesce(json_extract(${StaffingOutbox.payload}, '$.userId'), '')`,
								[...new Set(heads.map((h) => h.userId))],
							),
						),
					)
					// `createdAt` has millisecond resolution, so two events queued in the same
					// millisecond tie; the rowid (insertion order) settles it.
					.orderBy(asc(StaffingOutbox.createdAt), asc(sql`rowid`))
			).filter((row) => headKeys.has(userKey(row)))
		: []

	const groups = new Map<string, OutboxRow[]>()
	for (const row of pending) {
		const key = userKey(row)
		if (options.userId && !key.endsWith(`:${options.userId}`)) continue
		groups.set(key, [...(groups.get(key) ?? []), row])
	}

	const orgIds = [...new Set(pending.map((row) => row.organizationId))]
	const orgs = orgIds.length
		? await db
				.select({
					id: Organization.id,
					dataRegion: Organization.dataRegion,
				})
				.from(Organization)
				.where(inArray(Organization.id, orgIds))
		: []
	const regionByOrg = new Map(orgs.map((org) => [org.id, org.dataRegion]))

	for (const rows of groups.values()) {
		for (const [index, row] of rows.entries()) {
			if (result.attempted >= limit) {
				result.waiting += rows.length - index
				break
			}
			const leaseAt = effectiveNow()
			if (row.nextAttemptAt > leaseAt) {
				result.waiting += rows.length - index
				break
			}
			// Lease the row so a concurrent drain does not deliver it twice.
			const [leased] = await db
				.update(StaffingOutbox)
				.set({ nextAttemptAt: new Date(leaseAt.getTime() + OUTBOX_LEASE_MS) })
				.where(
					and(
						eq(StaffingOutbox.id, row.id),
						eq(StaffingOutbox.status, 'pending'),
						lte(StaffingOutbox.nextAttemptAt, leaseAt),
					),
				)
				.returning({ id: StaffingOutbox.id })
			if (!leased) {
				result.waiting += rows.length - index
				break
			}

			result.attempted += 1
			const dataRegion = regionByOrg.get(row.organizationId)
			const outcome: DeliveryOutcome = dataRegion
				? await deliver(row, dataRegion, timeoutMs)
				: { result: 'dead', error: 'org_not_found' }
			const attempts = row.attempts + 1

			if (outcome.result === 'done') {
				await db
					.update(StaffingOutbox)
					.set({ status: 'done', attempts, lastError: null })
					.where(eq(StaffingOutbox.id, row.id))
				result.done += 1
				continue
			}
			if (outcome.result === 'dead' || attempts >= OUTBOX_MAX_ATTEMPTS) {
				await db
					.update(StaffingOutbox)
					.set({ status: 'failed', attempts, lastError: outcome.error })
					.where(eq(StaffingOutbox.id, row.id))
				result.failed += 1
				console.error('Staffing outbox event failed permanently', {
					outboxId: row.id,
					kind: row.kind,
					organizationId: row.organizationId,
					error: outcome.error,
				})
				continue
			}
			await db
				.update(StaffingOutbox)
				.set({
					attempts,
					lastError: outcome.error,
					nextAttemptAt: new Date(now.getTime() + outboxBackoffMs(attempts)),
				})
				.where(eq(StaffingOutbox.id, row.id))
			result.retried += 1
			// Later events for this login wait behind the one that just failed.
			result.waiting += rows.length - index - 1
			break
		}
	}

	if (options.purge) {
		const doneBefore = new Date(now.getTime() - OUTBOX_DONE_RETENTION_MS)
		const failedBefore = new Date(now.getTime() - OUTBOX_FAILED_RETENTION_MS)
		const purgedDone = await db
			.delete(StaffingOutbox)
			.where(
				and(
					eq(StaffingOutbox.status, 'done'),
					lt(StaffingOutbox.updatedAt, doneBefore),
				),
			)
			.returning({ id: StaffingOutbox.id })
		const purgedFailed = await db
			.delete(StaffingOutbox)
			.where(
				and(
					eq(StaffingOutbox.status, 'failed'),
					lt(StaffingOutbox.updatedAt, failedBefore),
				),
			)
			.returning({ id: StaffingOutbox.id })
		result.purged = purgedDone.length + purgedFailed.length
	}
	return result
}

/**
 * Best-effort immediate delivery for one login, used right after enqueueing. It
 * never throws and never blocks for long: whatever does not go through now stays
 * queued for the cron-driven drain.
 */
export async function flushStaffingOutboxFor(
	organizationId: string,
	userId: string,
): Promise<void> {
	try {
		await drainStaffingOutbox({
			organizationId,
			userId,
			timeoutMs: 3_000,
			limit: 5,
		})
	} catch (error) {
		console.error('Staffing outbox inline delivery failed', {
			organizationId,
			error: error instanceof Error ? error.name : 'unknown',
		})
	}
}

/** Cancels everything pending for an organization (for example after a region switch). */
export async function cancelPendingStaffingOutbox(
	organizationId: string,
	reason: string,
): Promise<number> {
	const rows = await db
		.update(StaffingOutbox)
		.set({ status: 'failed', lastError: safeCode(reason) })
		.where(
			and(
				eq(StaffingOutbox.organizationId, organizationId),
				eq(StaffingOutbox.status, 'pending'),
			),
		)
		.returning({ id: StaffingOutbox.id })
	return rows.length
}
