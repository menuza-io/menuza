import { rsvOutbox, type TenantDatabase } from '@repo/tenant-db'
import { and, asc, eq, inArray, lte } from 'drizzle-orm'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { forEachInChunks } from '../lib/chunked-in.ts'
import { getInternalCommandToken, syncEnvFromProcess } from '../lib/secrets.ts'
import { type ReservationWriteTx } from '../lib/reservations-write.ts'

/**
 * Manager alerts cross from this regional node to the App through an outbox
 * row, so an App outage never loses one and a retry never double-notifies.
 * The event is a kind, a location id and a count: no guest, party or time.
 */

export const MANAGER_ALERT_KINDS = [
	'large_party_request',
	'waitlist_remote_join',
	'unassigned_conflict',
	'payment_failed',
	'payment_review',
	'dispute_opened',
	'message_failed_bulk',
] as const
export type ManagerAlertKind = (typeof MANAGER_ALERT_KINDS)[number]

export const RESERVATIONS_NOTIFY_PATH = '/resources/reservations/notify'

const opaqueId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/)

export const managerAlertEventSchema = z
	.object({
		orgId: opaqueId,
		eventId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
		kind: z.enum(MANAGER_ALERT_KINDS),
		locationId: opaqueId,
		count: z.number().int().min(1).max(10_000),
	})
	.strict()
export type ManagerAlertEvent = z.infer<typeof managerAlertEventSchema>

export const OUTBOX_BATCH_GROUPS = 50
export const OUTBOX_MAX_ATTEMPTS = 8
const OUTBOX_BACKOFF_MIN = [1, 5, 30, 60, 120, 240, 480]

type Tx = ReservationWriteTx | TenantDatabase

/** Queues one alert; `dedupeKey` makes a repeat of the same event a no-op. */
export async function enqueueManagerAlert(
	tx: Tx,
	input: {
		orgId: string
		kind: ManagerAlertKind
		locationId: string
		count?: number
		dedupeKey: string
		now: number
	},
): Promise<boolean> {
	const eventId = `evt_${crypto.randomUUID().replace(/-/g, '')}`
	const result = await tx
		.insert(rsvOutbox)
		.values({
			kind: 'manager_alert',
			dedupeKey: input.dedupeKey,
			payload: {
				orgId: input.orgId,
				eventId,
				kind: input.kind,
				locationId: input.locationId,
				count: input.count ?? 1,
			},
			status: 'pending',
			attempts: 0,
			nextAttemptAt: input.now,
			createdAt: input.now,
		})
		.onConflictDoNothing({ target: rsvOutbox.dedupeKey })
		.returning({ id: rsvOutbox.id })
	return result.length > 0
}

export type AlertOutcome =
	| { status: 'delivered' }
	| { status: 'retry'; code: string }
	| { status: 'rejected'; code: string }

const RETRYABLE = new Set([401, 408, 425, 429, 500, 502, 503, 504])

function appUrl() {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

export async function postManagerAlert(
	event: ManagerAlertEvent,
): Promise<AlertOutcome> {
	const parsed = managerAlertEventSchema.safeParse(event)
	if (!parsed.success) return { status: 'rejected', code: 'invalid_event' }
	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) {
		return { status: 'retry', code: 'not_configured' }
	}
	try {
		const response = await fetch(`${base}${RESERVATIONS_NOTIFY_PATH}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(parsed.data),
			redirect: 'error',
			signal: AbortSignal.timeout(8_000),
		})
		if (!response.ok) {
			return {
				status: RETRYABLE.has(response.status) ? 'retry' : 'rejected',
				code: `http_${response.status}`,
			}
		}
		return { status: 'delivered' }
	} catch {
		return { status: 'retry', code: 'network_error' }
	}
}

export type OutboxTotals = {
	groups: number
	delivered: number
	retried: number
	failed: number
}

/**
 * Posts due `manager_alert` rows. Rows for the same kind and location that are
 * due together go as one event with the summed count, so a burst becomes one
 * notification; every row of the group shares the outcome.
 */
export async function deliverOutbox(
	db: TenantDatabase,
	options: {
		now: number
		limitGroups?: number
		post?: (event: ManagerAlertEvent) => Promise<AlertOutcome>
	},
): Promise<OutboxTotals> {
	const { now } = options
	const post = options.post ?? postManagerAlert
	const totals: OutboxTotals = {
		groups: 0,
		delivered: 0,
		retried: 0,
		failed: 0,
	}
	const rows = await db
		.select()
		.from(rsvOutbox)
		.where(
			and(
				eq(rsvOutbox.kind, 'manager_alert'),
				eq(rsvOutbox.status, 'pending'),
				lte(rsvOutbox.nextAttemptAt, now),
			),
		)
		.orderBy(asc(rsvOutbox.nextAttemptAt))
		.limit(500)

	const groups = new Map<string, typeof rows>()
	for (const row of rows) {
		const payload = row.payload as Partial<ManagerAlertEvent>
		const key = `${payload.kind}:${payload.locationId}`
		const list = groups.get(key) ?? []
		list.push(row)
		groups.set(key, list)
	}

	for (const group of [...groups.values()].slice(
		0,
		options.limitGroups ?? OUTBOX_BATCH_GROUPS,
	)) {
		totals.groups++
		const first = group[0]!
		const base = first.payload as ManagerAlertEvent
		const count = Math.min(
			10_000,
			group.reduce(
				(sum, row) =>
					sum + Number((row.payload as { count?: number }).count ?? 1),
				0,
			),
		)
		const outcome = await post({ ...base, count })
		const ids = group.map((row) => row.id)
		if (outcome.status === 'delivered') {
			await forEachInChunks(ids, (chunk) =>
				db
					.update(rsvOutbox)
					.set({ status: 'sent', deliveredAt: now, lastError: null })
					.where(inArray(rsvOutbox.id, chunk)),
			)
			totals.delivered += ids.length
			continue
		}
		for (const row of group) {
			const attempts = row.attempts + 1
			const giveUp =
				outcome.status === 'rejected' || attempts >= OUTBOX_MAX_ATTEMPTS
			await db
				.update(rsvOutbox)
				.set({
					attempts,
					status: giveUp ? 'failed' : 'pending',
					lastError: outcome.code,
					nextAttemptAt:
						now +
						(OUTBOX_BACKOFF_MIN[
							Math.min(attempts - 1, OUTBOX_BACKOFF_MIN.length - 1)
						] ?? 480) *
							60_000,
				})
				.where(eq(rsvOutbox.id, row.id))
			if (giveUp) totals.failed++
			else totals.retried++
		}
	}
	return totals
}
