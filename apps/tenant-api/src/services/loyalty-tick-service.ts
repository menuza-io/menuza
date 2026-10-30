import {
	LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS,
	LOYALTY_PURGE_AFTER_MS,
} from '@repo/loyalty'
import {
	getTenantDb,
	loyaltyApprovals,
	loyaltyIdempotencyKeys,
	loyaltyOutbox,
	loyaltyPrograms,
	loyaltyRedemptions,
	posOrders,
} from '@repo/tenant-db'
import {
	and,
	asc,
	count,
	eq,
	inArray,
	lte,
	min,
	notExists,
	or,
	sql,
} from 'drizzle-orm'
import { forEachWithBudget } from '../lib/concurrency.ts'
import { errorLogFields } from '../lib/error-log.ts'
import { purgeLoyaltyRateCounters } from '../lib/loyalty-rate-limit.ts'
import {
	type LoyaltyReader,
	type LoyaltyTx,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import {
	expireLoyaltyApprovalsInTx,
	LOYALTY_TILL_SOURCE,
	purgeLoyaltyAccessInTx,
} from './loyalty-code-service.ts'
import { countParkedLoyaltySources } from './loyalty-outbox.ts'
import {
	loyaltySourceAdapters,
	processLoyaltyOutbox,
	queueLoyaltySourceInTx,
} from './loyalty-purchase-service.ts'
import {
	readRedemptionInTx,
	releaseRedemptionInTx,
	reviewRedemptionInTx,
} from './loyalty-redemption-service.ts'
import { sweepExpiredHolds } from './order-service.ts'

/**
 * The loyalty tick for one organization: lapsed online order holds expire,
 * expired unbound holds give their points back, stale till requests expire,
 * queued sources and sources whose verdict changed with time (an unpaid
 * order whose payment page closed) are reconciled again, a till redemption
 * whose sale never arrived goes to review, and spent codes, bindings,
 * idempotency records and rate counters are purged.
 *
 * It never stops on the kill switch or the flags: everything here finishes
 * work that already started. Results are counts only.
 *
 * Every row is its own transaction: one row that cannot be written is logged
 * and retried next tick, and never holds back the other rows, the other steps
 * or the outbox pass.
 */

const BATCH = 200

/**
 * A till redemption the tick still has to act on: its sale never arrived, it
 * arrived and was never queued, or the outbox already reconciled it and it is
 * still bound (the sale was uploaded open and its close never arrived). While
 * queued or parked for an operator the outbox owns the sale: queueing it again
 * would reset its attempts, so a failing one would retry forever and never
 * park.
 */
function tillRedemptionNeedsTick(db: LoyaltyReader) {
	return or(
		notExists(
			db
				.select({ one: sql`1` })
				.from(posOrders)
				.where(eq(posOrders.id, loyaltyRedemptions.sourceId)),
		),
		notExists(
			db
				.select({ one: sql`1` })
				.from(loyaltyOutbox)
				.where(
					and(
						eq(loyaltyOutbox.sourceType, loyaltyRedemptions.sourceType),
						eq(loyaltyOutbox.sourceId, loyaltyRedemptions.sourceId),
						inArray(loyaltyOutbox.status, ['pending', 'failed']),
					),
				),
		),
	)
}

/** Till redemptions waiting for an operator because their sale never arrived. */
async function countMissingUploads(db: LoyaltyReader): Promise<number> {
	const row = await db
		.select({ waiting: count() })
		.from(loyaltyRedemptions)
		.where(
			and(
				eq(loyaltyRedemptions.state, 'review'),
				eq(loyaltyRedemptions.reviewReason, 'upload_missing'),
			),
		)
		.get()
	return row?.waiting ?? 0
}

export type LoyaltyTickResult = {
	holdsReleased: number
	approvalsExpired: number
	outboxProcessed: number
	outboxFailed: number
	/** Parked by this tick. */
	outboxParked: number
	/** Parked and still waiting for an operator, whenever they were parked. */
	outboxParkedTotal: number
	/** Sent to review by this tick: their till sale never arrived. */
	uploadsMissing: number
	/** Still in review for a till sale that never arrived, whenever sent. */
	uploadsMissingTotal: number
	needsFollowUp: boolean
	nextDueAt: number | null
}

export async function runLoyaltyTickForOrg(
	orgId: string,
	options: { now?: number } = {},
): Promise<LoyaltyTickResult> {
	const now = options.now ?? Date.now()
	const db = await getTenantDb(orgId)
	// Nothing loyalty does can exist before a program was saved.
	const program = await db
		.select({ id: loyaltyPrograms.id })
		.from(loyaltyPrograms)
		.limit(1)
		.get()
	if (!program) {
		return {
			holdsReleased: 0,
			approvalsExpired: 0,
			outboxProcessed: 0,
			outboxFailed: 0,
			outboxParked: 0,
			outboxParkedTotal: 0,
			uploadsMissing: 0,
			uploadsMissingTotal: 0,
			needsFollowUp: false,
			nextDueAt: null,
		}
	}

	// Without this an abandoned checkout keeps its reward held until someone
	// reads the organization's orders.
	await sweepExpiredHolds(orgId, new Date(now)).catch((error: unknown) => {
		console.error(
			'Loyalty tick hold sweep failed',
			orgId,
			error instanceof Error ? error.name : 'unknown',
		)
	})

	const failures: Array<{ step: string; rowId: string | null }> = []
	/** One row (or one step) in its own transaction; a failure is logged, not thrown. */
	async function inOwnTx<T>(
		step: string,
		rowId: string | null,
		fn: (tx: LoyaltyTx) => Promise<T>,
	): Promise<T | undefined> {
		try {
			return await withLoyaltyWrite({ orgId, db, now }, (tx) => fn(tx))
		} catch (error) {
			failures.push({ step, rowId })
			console.error('Loyalty tick step failed', {
				orgId,
				step,
				rowId,
				...errorLogFields(error),
			})
			return undefined
		}
	}
	/** A read the steps start from; a failure skips the step for this tick. */
	async function listFor<T>(step: string, read: () => Promise<T[]>) {
		try {
			return await read()
		} catch (error) {
			failures.push({ step, rowId: null })
			console.error('Loyalty tick step failed', {
				orgId,
				step,
				rowId: null,
				...errorLogFields(error),
			})
			return []
		}
	}

	const expiredHolds = await listFor('expired_hold', () =>
		db
			.select({ id: loyaltyRedemptions.id })
			.from(loyaltyRedemptions)
			.where(
				and(
					eq(loyaltyRedemptions.state, 'reserved'),
					lte(loyaltyRedemptions.expiresAt, now),
				),
			)
			.orderBy(asc(loyaltyRedemptions.expiresAt))
			.limit(BATCH)
			.all(),
	)
	let holdsReleased = 0
	for (const { id } of expiredHolds) {
		const released = await inOwnTx('expired_hold', id, async (tx) => {
			const hold = await readRedemptionInTx(tx, id)
			if (hold?.state !== 'reserved' || (hold.expiresAt ?? now + 1) > now) {
				return false
			}
			await releaseRedemptionInTx(tx, hold, { reason: 'expired', at: now })
			return true
		})
		if (released) holdsReleased += 1
	}

	const approvalsExpired =
		(await inOwnTx('expire_approvals', null, (tx) =>
			expireLoyaltyApprovalsInTx(tx, now),
		)) ?? 0

	for (const adapter of loyaltySourceAdapters()) {
		if (!adapter.timed) continue
		const timed = adapter.timed
		const step = `timed_${adapter.type}`
		for (const id of await listFor(step, () => timed.due(db, now, BATCH))) {
			await inOwnTx(step, id, (tx) =>
				queueLoyaltySourceInTx(tx, { type: adapter.type, id }, now),
			)
		}
	}

	// A till redemption still bound a day later: queue its sale if it arrived
	// and was never queued, otherwise someone has to look. Never released by a
	// timer.
	const stale = await listFor('stale_till', () =>
		db
			.select({ id: loyaltyRedemptions.id })
			.from(loyaltyRedemptions)
			.where(
				and(
					eq(loyaltyRedemptions.state, 'bound'),
					eq(loyaltyRedemptions.sourceType, LOYALTY_TILL_SOURCE),
					lte(
						loyaltyRedemptions.boundAt,
						now - LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS,
					),
					tillRedemptionNeedsTick(db),
				),
			)
			.orderBy(asc(loyaltyRedemptions.boundAt))
			.limit(BATCH)
			.all(),
	)
	let uploadsMissing = 0
	for (const { id } of stale) {
		const outcome = await inOwnTx('stale_till', id, async (tx) => {
			const redemption = await readRedemptionInTx(tx, id)
			if (redemption?.state !== 'bound' || !redemption.sourceId) return null
			const saleId = redemption.sourceId
			const sale = await tx
				.select({ id: posOrders.id, status: posOrders.status })
				.from(posOrders)
				.where(eq(posOrders.id, saleId))
				.get()
			const queued = sale
				? await tx
						.select({ status: loyaltyOutbox.status })
						.from(loyaltyOutbox)
						.where(
							and(
								eq(loyaltyOutbox.sourceType, LOYALTY_TILL_SOURCE),
								eq(loyaltyOutbox.sourceId, saleId),
							),
						)
						.get()
				: undefined
			if (queued && queued.status !== 'done') return null
			if (sale && (!queued || sale.status !== 'open')) {
				await queueLoyaltySourceInTx(
					tx,
					{ type: LOYALTY_TILL_SOURCE, id: saleId },
					now,
				)
				return null
			}
			await reviewRedemptionInTx(tx, redemption, {
				reason: 'upload_missing',
				at: now,
			})
			return { saleId, uploaded: sale !== undefined }
		})
		if (!outcome) continue
		uploadsMissing += 1
		console.error(
			outcome.uploaded
				? 'Loyalty till sale never closed'
				: 'Loyalty till sale never uploaded',
			{ orgId, redemptionId: id, saleId: outcome.saleId },
		)
	}

	const olderThan = now - LOYALTY_PURGE_AFTER_MS
	await inOwnTx('purge', null, async (tx) => {
		await purgeLoyaltyAccessInTx(tx, olderThan)
		await tx
			.delete(loyaltyIdempotencyKeys)
			.where(lte(loyaltyIdempotencyKeys.expiresAt, now))
		await tx
			.delete(loyaltyOutbox)
			.where(
				and(
					eq(loyaltyOutbox.status, 'done'),
					lte(loyaltyOutbox.doneAt, olderThan),
				),
			)
	})
	const housekeeping = { holdsReleased, approvalsExpired, uploadsMissing }

	await purgeLoyaltyRateCounters(db, now).catch((error: unknown) => {
		failures.push({ step: 'purge_rate_counters', rowId: null })
		console.error('Loyalty tick step failed', {
			orgId,
			step: 'purge_rate_counters',
			rowId: null,
			...errorLogFields(error),
		})
	})
	const outbox = await processLoyaltyOutbox(orgId, { now })

	const [holds, approvals, queued, tillBound, parkedTotal, missingTotal] =
		await Promise.all([
			db
				.select({ at: min(loyaltyRedemptions.expiresAt) })
				.from(loyaltyRedemptions)
				.where(eq(loyaltyRedemptions.state, 'reserved'))
				.get(),
			db
				.select({ at: min(loyaltyApprovals.expiresAt) })
				.from(loyaltyApprovals)
				.where(eq(loyaltyApprovals.status, 'pending'))
				.get(),
			db
				.select({ at: min(loyaltyOutbox.nextAttemptAt) })
				.from(loyaltyOutbox)
				.where(eq(loyaltyOutbox.status, 'pending'))
				.get(),
			db
				.select({
					at: sql<
						number | null
					>`min(${loyaltyRedemptions.boundAt}) + ${LOYALTY_POS_UPLOAD_REVIEW_AFTER_MS}`,
				})
				.from(loyaltyRedemptions)
				.where(
					and(
						eq(loyaltyRedemptions.state, 'bound'),
						eq(loyaltyRedemptions.sourceType, LOYALTY_TILL_SOURCE),
						tillRedemptionNeedsTick(db),
					),
				)
				.get(),
			countParkedLoyaltySources(db),
			countMissingUploads(db),
		])
	const timed = await Promise.all(
		loyaltySourceAdapters().map(
			(adapter) => adapter.timed?.nextDueAt(db) ?? Promise.resolve(null),
		),
	)
	const due = [holds?.at, approvals?.at, queued?.at, tillBound?.at, ...timed]
		.map((value) =>
			value === null || value === undefined ? null : Number(value),
		)
		.filter(
			(value): value is number => value !== null && Number.isFinite(value),
		)
	const nextDueAt = due.length > 0 ? Math.min(...due) : null
	const result = {
		...housekeeping,
		outboxProcessed: outbox.processed,
		outboxFailed: outbox.failed,
		outboxParked: outbox.parked,
		outboxParkedTotal: parkedTotal,
		uploadsMissingTotal: missingTotal,
		needsFollowUp: nextDueAt !== null,
		nextDueAt,
	}
	// One structured line per tick that did anything, at error level when an
	// operator has to look: nothing here should be invisible. Sources parked and
	// missing uploads sent to review earlier stay in the line but alone do not
	// log every tick; the hourly cron keeps failing on them instead.
	const counts = {
		holdsReleased: result.holdsReleased,
		approvalsExpired: result.approvalsExpired,
		outboxProcessed: result.outboxProcessed,
		outboxFailed: result.outboxFailed,
		outboxParked: result.outboxParked,
		uploadsMissing: result.uploadsMissing,
	}
	const line = {
		orgId,
		...counts,
		outboxParkedTotal: parkedTotal,
		uploadsMissingTotal: missingTotal,
		stepsFailed: failures.length,
	}
	if (
		result.outboxParked > 0 ||
		result.uploadsMissing > 0 ||
		failures.length > 0
	) {
		console.error('Loyalty tick needs attention', line)
	} else if (Object.values(counts).some((count) => count > 0)) {
		console.info('Loyalty tick', line)
	}
	return result
}

/**
 * The per-organization half of a fan-out: one failing organization never
 * stops the others, but its failure is logged with the organization and
 * counted in the aggregate, never swallowed.
 */
export async function runLoyaltyTickLogged(
	orgId: string,
): Promise<LoyaltyTickResult | null> {
	try {
		return await runLoyaltyTickForOrg(orgId)
	} catch (error) {
		console.error(
			'Loyalty tick failed for organization',
			orgId,
			error instanceof Error ? error.name : 'unknown',
		)
		return null
	}
}

export type LoyaltyTickAggregate = Omit<
	LoyaltyTickResult,
	'needsFollowUp' | 'nextDueAt'
> & { orgs: number; errors: number; orgsDeferred: number }

export function emptyLoyaltyAggregate(): LoyaltyTickAggregate {
	return {
		orgs: 0,
		errors: 0,
		orgsDeferred: 0,
		holdsReleased: 0,
		approvalsExpired: 0,
		outboxProcessed: 0,
		outboxFailed: 0,
		outboxParked: 0,
		outboxParkedTotal: 0,
		uploadsMissing: 0,
		uploadsMissingTotal: 0,
	}
}

const HOUR_MS = 60 * 60 * 1000

/**
 * The same organizations starting `bucket` places further along. The budgeted
 * walk stops at its deadline, so a fixed order would never reach the tail of a
 * long list; a start that moves with every run gives each organization its
 * turn at the front.
 */
export function rotateOrgIds(
	orgIds: readonly string[],
	bucket: number,
): string[] {
	if (orgIds.length < 2) return [...orgIds]
	const start =
		((Math.trunc(bucket) % orgIds.length) + orgIds.length) % orgIds.length
	return [...orgIds.slice(start), ...orgIds.slice(0, start)]
}

/**
 * Runs the tick for many organizations with bounded concurrency and a time
 * budget (Node runs each in-process, the Workers edge forwards each to its
 * Durable Object). The walk starts at a different organization each hour
 * (`rotateBucket`, the hour number by default) so a run that ends at its
 * deadline does not always leave the same ones for last. An organization not
 * reached in time waits for a later run and is counted in `orgsDeferred`.
 */
export async function fanOutLoyaltyTick(options: {
	orgIds: readonly string[]
	run: (orgId: string) => Promise<LoyaltyTickResult | null>
	budgetMs?: number
	concurrency?: number
	now?: () => number
	/** Where the walk starts: the list rotates by this many places. */
	rotateBucket?: number
}): Promise<LoyaltyTickAggregate> {
	const now = options.now ?? Date.now
	const total = emptyLoyaltyAggregate()
	const orgIds = rotateOrgIds(
		options.orgIds,
		options.rotateBucket ?? Math.floor(now() / HOUR_MS),
	)
	const run = await forEachWithBudget(
		orgIds,
		{
			concurrency: options.concurrency ?? 4,
			deadline: now() + (options.budgetMs ?? 50_000),
			now,
		},
		async (orgId) => {
			const result = await options.run(orgId)
			if (!result) {
				total.errors++
				return
			}
			total.orgs++
			total.holdsReleased += result.holdsReleased
			total.approvalsExpired += result.approvalsExpired
			total.outboxProcessed += result.outboxProcessed
			total.outboxFailed += result.outboxFailed
			total.outboxParked += result.outboxParked
			total.outboxParkedTotal += result.outboxParkedTotal
			total.uploadsMissing += result.uploadsMissing
			total.uploadsMissingTotal += result.uploadsMissingTotal
		},
	)
	total.orgsDeferred = run.skipped
	if (run.skipped > 0) {
		console.warn('Loyalty tick ran out of time', {
			orgs: total.orgs,
			errors: total.errors,
			orgsDeferred: total.orgsDeferred,
		})
	}
	return total
}
