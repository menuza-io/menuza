import {
	classifySaleTime,
	computeEarning,
	computeRefundReversal,
	LOYALTY_HOLDING_STATES,
	LOYALTY_OUTBOX_MAX_ATTEMPTS,
	LOYALTY_POS_DAILY_EARN_REVIEW_POINTS,
	LOYALTY_SOURCE_CHANNEL,
	LoyaltyDomainError,
	loyaltyEventKeys,
	loyaltyOutboxBackoffMs,
	loyaltyPurchaseSnapshotSchema,
	normalizeCurrency,
	sameCurrency,
	visitDateOf,
	type LoyaltyActorKind,
	type LoyaltyExcludedReason,
	type LoyaltyOperatorPurchase,
	type LoyaltyPurchaseSource,
	type LoyaltyReviewReason,
} from '@repo/loyalty'
import {
	getTenantDb,
	loyaltyMembers,
	loyaltyOutbox,
	loyaltyPurchases,
	loyaltyRedemptions,
} from '@repo/tenant-db'
import { and, asc, desc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { errorLogFields } from '../lib/error-log.ts'
import { reportLoyaltyDeferred } from '../lib/loyalty-alarm.ts'
import {
	type LoyaltyIdempotency,
	type LoyaltyReader,
	type LoyaltyTx,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import {
	qrTabLoyaltySource,
	restaurantOrderLoyaltySource,
} from '../restaurant/loyalty-sources.ts'
import { posOrderLoyaltySource } from '../restaurant/pos-loyalty-source.ts'
import { recordLoyaltyAudit } from './loyalty-audit.ts'
import { postLedgerEntryInTx } from './loyalty-ledger.ts'
import {
	locationVisible,
	readMemberInTx,
	toOperatorPurchase,
	type MemberRow,
} from './loyalty-member-service.ts'
import { closeParkedSourceInTx } from './loyalty-outbox.ts'
import {
	programVersionAtInTx,
	programVersionByNumberInTx,
} from './loyalty-program-service.ts'
import {
	activeRedemptionForSourceInTx,
	consumeRedemptionInTx,
	releaseRedemptionInTx,
	restoreRedemptionInTx,
	reviewRedemptionInTx,
	type RedemptionRow,
} from './loyalty-redemption-service.ts'
import {
	type LoyaltySourceAdapter,
	type LoyaltySourceFacts,
	type LoyaltySourceVerdict,
} from './loyalty-sources.ts'

/**
 * Purchases and their reconciliation.
 *
 * An order channel does two cheap things inside its own transaction: it claims
 * the purchase for a member (`claimPurchaseInTx`) and, whenever the sale
 * changes, queues the source (`queueLoyaltySourceInTx`). Everything else runs
 * here after the sale committed, and again from the tick until it succeeds:
 * the source adapter reads the authoritative order, tab or till sale and the
 * purchase and its redemption move from that verdict. A loyalty failure can
 * never refuse or alter a sale.
 */

export type PurchaseRow = typeof loyaltyPurchases.$inferSelect
export type LoyaltySourceRef = { type: LoyaltyPurchaseSource; id: string }

const adapters: Partial<Record<LoyaltyPurchaseSource, LoyaltySourceAdapter>> = {
	restaurant_order: restaurantOrderLoyaltySource,
	qr_tab: qrTabLoyaltySource,
	pos_order: posOrderLoyaltySource,
}

/** Adds (or replaces) the adapter of a source type. */
export function registerLoyaltySourceAdapter(adapter: LoyaltySourceAdapter) {
	adapters[adapter.type] = adapter
}

export function loyaltySourceAdapters(): LoyaltySourceAdapter[] {
	return Object.values(adapters).filter(
		(adapter): adapter is LoyaltySourceAdapter => adapter !== undefined,
	)
}

function adapterFor(type: LoyaltyPurchaseSource): LoyaltySourceAdapter {
	const adapter = adapters[type]
	if (!adapter) throw new LoyaltyDomainError('loyalty_unavailable')
	return adapter
}

export async function readSourceFactsInTx(
	db: LoyaltyReader,
	source: LoyaltySourceRef,
	context: { redemption: RedemptionRow | null; now: number },
): Promise<LoyaltySourceFacts | null> {
	return adapterFor(source.type).read(db, source.id, context)
}

function sourceIs(source: LoyaltySourceRef) {
	return and(
		eq(loyaltyPurchases.sourceType, source.type),
		eq(loyaltyPurchases.sourceId, source.id),
	)
}

export async function readPurchaseInTx(
	db: LoyaltyReader,
	purchaseId: string,
): Promise<PurchaseRow | null> {
	return (
		(await db
			.select()
			.from(loyaltyPurchases)
			.where(eq(loyaltyPurchases.id, purchaseId))
			.get()) ?? null
	)
}

export async function purchaseForSourceInTx(
	db: LoyaltyReader,
	source: LoyaltySourceRef,
): Promise<PurchaseRow | null> {
	return (
		(await db.select().from(loyaltyPurchases).where(sourceIs(source)).get()) ??
		null
	)
}

/** The source's open redemption, else the last one it released. */
export async function latestRedemptionForSourceInTx(
	db: LoyaltyReader,
	source: LoyaltySourceRef,
): Promise<RedemptionRow | null> {
	const active = await activeRedemptionForSourceInTx(db, source.type, source.id)
	if (active) return active
	return (
		(await db
			.select()
			.from(loyaltyRedemptions)
			.where(
				and(
					eq(loyaltyRedemptions.sourceType, source.type),
					eq(loyaltyRedemptions.sourceId, source.id),
				),
			)
			.orderBy(desc(loyaltyRedemptions.updatedAt), desc(loyaltyRedemptions.id))
			.limit(1)
			.get()) ?? null
	)
}

function holdsPoints(
	redemption: RedemptionRow | null,
): redemption is RedemptionRow {
	return (
		redemption !== null &&
		(LOYALTY_HOLDING_STATES as readonly string[]).includes(redemption.state)
	)
}

/**
 * Credits a sale to a member. The same source is only ever one purchase, so
 * claiming again is a no-op and another member cannot take it over.
 */
export async function claimPurchaseInTx(
	tx: LoyaltyTx,
	input: {
		member: MemberRow
		source: LoyaltySourceRef
		locationId: string | null
		currency: string
		at: number
	},
): Promise<PurchaseRow> {
	if (input.member.status !== 'active') {
		throw new LoyaltyDomainError('member_inactive')
	}
	const existing = await purchaseForSourceInTx(tx, input.source)
	if (existing) {
		if (existing.memberId !== input.member.id) {
			throw new LoyaltyDomainError('already_claimed')
		}
		return existing
	}
	const [row] = await tx
		.insert(loyaltyPurchases)
		.values({
			memberId: input.member.id,
			sourceType: input.source.type,
			sourceId: input.source.id,
			channel: LOYALTY_SOURCE_CHANNEL[input.source.type],
			locationId: input.locationId,
			currency: normalizeCurrency(input.currency),
			state: 'open',
			createdAt: input.at,
			updatedAt: input.at,
		})
		.returning()
	return row!
}

/**
 * Claims a shared sale (a QR tab) for the first verified member to order on
 * it or pay it. Unlike `claimPurchaseInTx` it never throws when another
 * member got there first: ordering and paying go on, and the points stay with
 * that member. Null when the member does not collect this sale.
 */
export async function claimPurchaseIfUnclaimedInTx(
	tx: LoyaltyTx,
	input: Parameters<typeof claimPurchaseInTx>[1],
): Promise<PurchaseRow | null> {
	if (input.member.status !== 'active') return null
	const existing = await purchaseForSourceInTx(tx, input.source)
	if (existing) return existing.memberId === input.member.id ? existing : null
	return claimPurchaseInTx(tx, input)
}

/**
 * Queues a source whose sale changed. Only sources loyalty knows about (a
 * claimed purchase or a redemption on it) are queued. Queueing again resets
 * the row, so repeated events coalesce into one reconciliation. With
 * `preserveAttempts` a row that has not finished keeps its attempt count: a
 * source re-armed by an event that changes nothing (a held upload) cannot
 * reset its backoff and retry budget forever.
 */
export async function queueLoyaltySourceInTx(
	tx: LoyaltyTx,
	source: LoyaltySourceRef,
	at: number,
	options: { preserveAttempts?: boolean } = {},
): Promise<boolean> {
	const purchase = await tx
		.select({ id: loyaltyPurchases.id })
		.from(loyaltyPurchases)
		.where(sourceIs(source))
		.get()
	const redemption = purchase
		? null
		: await activeRedemptionForSourceInTx(tx, source.type, source.id)
	if (!purchase && !redemption) return false
	const existing = options.preserveAttempts
		? await tx
				.select({
					attempts: loyaltyOutbox.attempts,
					doneAt: loyaltyOutbox.doneAt,
				})
				.from(loyaltyOutbox)
				.where(
					and(
						eq(loyaltyOutbox.sourceType, source.type),
						eq(loyaltyOutbox.sourceId, source.id),
					),
				)
				.get()
		: undefined
	const reset = {
		status: 'pending' as const,
		attempts: existing && existing.doneAt === null ? existing.attempts : 0,
		nextAttemptAt: at,
		lastError: null,
		claimedUntil: null,
		updatedAt: at,
		doneAt: null,
	}
	await tx
		.insert(loyaltyOutbox)
		.values({
			sourceType: source.type,
			sourceId: source.id,
			createdAt: at,
			...reset,
		})
		.onConflictDoUpdate({
			target: [loyaltyOutbox.sourceType, loyaltyOutbox.sourceId],
			set: reset,
		})
	return true
}

async function reviewPurchaseInTx(
	tx: LoyaltyTx,
	purchase: PurchaseRow,
	reason: LoyaltyReviewReason,
	at: number,
): Promise<PurchaseRow> {
	if (purchase.state === 'review' && purchase.reviewReason === reason) {
		return purchase
	}
	const [row] = await tx
		.update(loyaltyPurchases)
		.set({ state: 'review', reviewReason: reason, updatedAt: at })
		.where(eq(loyaltyPurchases.id, purchase.id))
		.returning()
	return row!
}

async function excludePurchaseInTx(
	tx: LoyaltyTx,
	purchase: PurchaseRow,
	reason: LoyaltyExcludedReason,
	at: number,
): Promise<PurchaseRow> {
	const [row] = await tx
		.update(loyaltyPurchases)
		.set({
			state: 'excluded',
			excludedReason: reason,
			reviewReason: null,
			updatedAt: at,
		})
		.where(eq(loyaltyPurchases.id, purchase.id))
		.returning()
	return row!
}

/**
 * Exclusions a later truth can undo: a late payment revives a cancelled sale,
 * and unmarking a tab that was never rung up on a till lets it earn.
 */
function reopenable(purchase: PurchaseRow): boolean {
	return (
		purchase.state === 'excluded' &&
		(purchase.excludedReason === 'cancelled' ||
			purchase.excludedReason === 'rung_up_on_station')
	)
}

function unsettled(purchase: PurchaseRow): boolean {
	return purchase.state === 'open' || purchase.state === 'review'
}

async function visitAwardedOnInTx(
	tx: LoyaltyTx,
	purchase: PurchaseRow,
	visitDate: string,
): Promise<boolean> {
	const other = await tx
		.select({ id: loyaltyPurchases.id })
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.memberId, purchase.memberId),
				eq(loyaltyPurchases.visitDate, visitDate),
				eq(loyaltyPurchases.visitAwarded, true),
				ne(loyaltyPurchases.id, purchase.id),
			),
		)
		.get()
	return Boolean(other)
}

/** Points the member already earned at tills on the sale's organization-local day. */
async function posEarnedOnVisitDateInTx(
	tx: LoyaltyTx,
	memberId: string,
	visitDate: string,
): Promise<number> {
	const row = await tx
		.select({
			total: sql<number>`coalesce(sum(${loyaltyPurchases.awardedPoints}), 0)`,
		})
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.memberId, memberId),
				eq(loyaltyPurchases.sourceType, 'pos_order'),
				eq(loyaltyPurchases.state, 'completed'),
				eq(loyaltyPurchases.visitDate, visitDate),
			),
		)
		.get()
	return Number(row?.total ?? 0)
}

export type ReconcileOptions = {
	/**
	 * An operator vouched for the sale: settle it without the sale-time and
	 * discount checks that would send it to review.
	 */
	trusted?: boolean
	actorKind?: LoyaltyActorKind
	actorId?: string | null
}

type CompletedVerdict = Extract<LoyaltySourceVerdict, { kind: 'completed' }>

/**
 * Takes back points for money returned, from the purchase's own snapshot and
 * the program version it earned under, never today's rules. Cumulative: the
 * event key carries the total refunded so far, so replaying a refund posts
 * nothing new.
 */
export async function applyPurchaseRefundsInTx(
	tx: LoyaltyTx,
	purchase: PurchaseRow,
	input: { at: number; actorKind: LoyaltyActorKind; actorId?: string | null },
): Promise<{
	purchase: PurchaseRow
	pointsReversed: number
	fullRefund: boolean
}> {
	if (
		purchase.state !== 'completed' ||
		purchase.programVersion === null ||
		!purchase.snapshot
	) {
		return { purchase, pointsReversed: 0, fullRefund: false }
	}
	const snapshot = loyaltyPurchaseSnapshotSchema.parse(purchase.snapshot)
	const fullRefund =
		snapshot.totalPaidMinor > 0 &&
		purchase.refundedMinor >= snapshot.totalPaidMinor
	if (purchase.awardedPoints <= 0) {
		return { purchase, pointsReversed: 0, fullRefund }
	}
	const version = await programVersionByNumberInTx(tx, purchase.programVersion)
	if (!version) throw new LoyaltyDomainError('program_not_found')
	const reversal = computeRefundReversal({
		rule: version.config.earning,
		minimumSpendMinor: version.config.minimumSpendMinor,
		snapshot,
		awardedPoints: purchase.awardedPoints,
		previouslyReversedPoints: purchase.reversedPoints,
		cumulativeRefundedMinor: purchase.refundedMinor,
	})
	if (reversal.reversePoints <= 0) {
		return { purchase, pointsReversed: 0, fullRefund: reversal.fullRefund }
	}
	const posted = await postLedgerEntryInTx(tx, {
		memberId: purchase.memberId,
		type: 'earn_reversal',
		delta: -reversal.reversePoints,
		eventKey: loyaltyEventKeys.reversal(
			purchase.id,
			String(purchase.refundedMinor),
		),
		purchaseId: purchase.id,
		channel: purchase.channel,
		locationId: purchase.locationId,
		programVersion: purchase.programVersion,
		actorKind: input.actorKind,
		actorId: input.actorId ?? null,
		at: input.at,
	})
	if (!posted.inserted) {
		return { purchase, pointsReversed: 0, fullRefund: reversal.fullRefund }
	}
	const [row] = await tx
		.update(loyaltyPurchases)
		.set({
			reversedPoints: purchase.reversedPoints + reversal.reversePoints,
			updatedAt: input.at,
		})
		.where(eq(loyaltyPurchases.id, purchase.id))
		.returning()
	return {
		purchase: row!,
		pointsReversed: reversal.reversePoints,
		fullRefund: reversal.fullRefund,
	}
}

/**
 * Earns a finished sale under the program version in force when it finished.
 * Program, member and currency problems exclude it; an untrustworthy sale time,
 * a flagged till sale or a discount without a matching redemption sends it to
 * review, and a till sale flagged once stays there until an operator decides.
 */
async function settlePurchaseInTx(
	tx: LoyaltyTx,
	purchase: PurchaseRow,
	facts: LoyaltySourceFacts,
	verdict: CompletedVerdict,
	redemption: RedemptionRow | null,
	now: number,
	options: ReconcileOptions,
): Promise<PurchaseRow> {
	if (!unsettled(purchase) && !reopenable(purchase)) return purchase
	if (!options.trusted) {
		if (
			purchase.state === 'review' &&
			purchase.reviewReason === 'sale_flagged'
		) {
			return purchase
		}
		if (
			verdict.receivedAt !== null &&
			classifySaleTime(verdict.occurredAt, verdict.receivedAt) !== 'ok'
		) {
			return reviewPurchaseInTx(tx, purchase, 'sale_time_suspicious', now)
		}
		if (verdict.holdReason) {
			return reviewPurchaseInTx(tx, purchase, verdict.holdReason, now)
		}
		if (verdict.loyaltyDiscountMinor > 0) {
			if (!redemption) {
				return reviewPurchaseInTx(tx, purchase, 'redemption_unknown', now)
			}
			if (redemption.state === 'released') {
				return reviewPurchaseInTx(tx, purchase, 'redemption_released', now)
			}
		}
		if (
			redemption &&
			redemption.state !== 'released' &&
			redemption.discountMinor !== verdict.loyaltyDiscountMinor
		) {
			return reviewPurchaseInTx(tx, purchase, 'upload_mismatch', now)
		}
	}
	const member = await readMemberInTx(tx, purchase.memberId)
	if (!member || member.status !== 'active') {
		return excludePurchaseInTx(tx, purchase, 'member_inactive', now)
	}
	const version = await programVersionAtInTx(tx, verdict.occurredAt)
	if (!version || version.status !== 'active') {
		return excludePurchaseInTx(tx, purchase, 'program_inactive', now)
	}
	if (!sameCurrency(version.currency, verdict.snapshot.currency)) {
		return excludePurchaseInTx(tx, purchase, 'currency_mismatch', now)
	}
	const { config } = version
	const visitDate = visitDateOf(verdict.occurredAt, config.timeZone)
	const isVisit = config.earning.method === 'visit'
	const earning = computeEarning(
		{
			rule: config.earning,
			minimumSpendMinor: config.minimumSpendMinor,
			snapshot: verdict.snapshot,
		},
		{
			visitAlreadyAwarded:
				isVisit && (await visitAwardedOnInTx(tx, purchase, visitDate)),
		},
	)
	if (
		!options.trusted &&
		earning.points > 0 &&
		purchase.sourceType === 'pos_order' &&
		(await posEarnedOnVisitDateInTx(tx, purchase.memberId, visitDate)) +
			earning.points >
			LOYALTY_POS_DAILY_EARN_REVIEW_POINTS
	) {
		return reviewPurchaseInTx(tx, purchase, 'large_earn', now)
	}
	const [row] = await tx
		.update(loyaltyPurchases)
		.set({
			state: 'completed',
			reviewReason: null,
			excludedReason: null,
			skipReason: earning.reason,
			programVersion: version.version,
			occurredAt: verdict.occurredAt,
			visitDate,
			visitAwarded: isVisit && earning.points > 0,
			snapshot: verdict.snapshot as unknown as Record<string, unknown>,
			eligibleMinor: earning.eligibleMinor,
			totalPaidMinor: verdict.snapshot.totalPaidMinor,
			awardedPoints: earning.points,
			locationId: facts.locationId ?? purchase.locationId,
			currency: verdict.snapshot.currency,
			updatedAt: now,
		})
		.where(eq(loyaltyPurchases.id, purchase.id))
		.returning()
	let settled = row!
	if (earning.points > 0) {
		await postLedgerEntryInTx(tx, {
			memberId: purchase.memberId,
			type: 'earn',
			delta: earning.points,
			eventKey: loyaltyEventKeys.earn(purchase.id),
			purchaseId: purchase.id,
			channel: purchase.channel,
			locationId: settled.locationId,
			programVersion: version.version,
			actorKind: options.actorKind ?? 'system',
			actorId: options.actorId ?? null,
			at: now,
		})
	}
	await tx
		.update(loyaltyMembers)
		.set({
			lastPurchaseAt: sql`max(coalesce(${loyaltyMembers.lastPurchaseAt}, 0), ${verdict.occurredAt})`,
			updatedAt: now,
		})
		.where(eq(loyaltyMembers.id, member.id))
	if (settled.refundedMinor > 0) {
		// Money recorded as returned before the sale finished.
		settled = (
			await applyPurchaseRefundsInTx(tx, settled, {
				at: now,
				actorKind: 'system',
			})
		).purchase
	}
	return settled
}

export type ReconcileResult = {
	purchase: PurchaseRow | null
	redemption: RedemptionRow | null
	verdict: LoyaltySourceVerdict['kind'] | 'missing' | 'untracked'
}

/**
 * Refunds a source records itself (an online order's), applied however often
 * reconciliation runs: points come back from the purchase's own snapshot, and
 * once every cent paid is back the reward the sale spent is restored, once.
 */
async function applySourceRefundsInTx(
	tx: LoyaltyTx,
	source: LoyaltySourceRef,
	facts: LoyaltySourceFacts,
	input: { purchase: PurchaseRow | null; reversedBefore: number; now: number },
): Promise<{ purchase: PurchaseRow | null; restored: RedemptionRow | null }> {
	const refundedMinor = facts.refundedMinor
	let purchase = input.purchase
	if (purchase?.state === 'completed') {
		purchase = (
			await applyPurchaseRefundsInTx(tx, purchase, {
				at: input.now,
				actorKind: 'system',
			})
		).purchase
	}
	const fullRefund = facts.totalMinor > 0 && refundedMinor >= facts.totalMinor
	let restored: RedemptionRow | null = null
	if (fullRefund) {
		const latest = await latestRedemptionForSourceInTx(tx, source)
		if (latest?.state === 'consumed') {
			restored = await restoreRedemptionInTx(tx, latest, {
				at: input.now,
				actorKind: 'system',
			})
		}
	}
	const pointsReversed = (purchase?.reversedPoints ?? 0) - input.reversedBefore
	if (pointsReversed > 0 || restored) {
		await recordLoyaltyAudit(tx, {
			actorKind: 'system',
			locationId: facts.locationId,
			action: 'refund.applied',
			entityType: purchase ? 'purchase' : 'redemption',
			entityId: purchase?.id ?? restored!.id,
			changes: {
				sourceType: source.type,
				sourceId: source.id,
				cumulativeRefundedMinor: refundedMinor,
				pointsReversed,
				fullRefund,
				rewardRestored: restored !== null,
			},
			at: input.now,
		})
	}
	return { purchase, restored }
}

/** Copies what the source records as refunded onto its purchase. */
async function syncRefundedMinorInTx(
	tx: LoyaltyTx,
	purchase: PurchaseRow | null,
	facts: LoyaltySourceFacts,
	now: number,
): Promise<PurchaseRow | null> {
	const sourceRefundedMinor = facts.refundedMinor
	if (!purchase || sourceRefundedMinor <= purchase.refundedMinor) {
		return purchase
	}
	const [row] = await tx
		.update(loyaltyPurchases)
		.set({ refundedMinor: sourceRefundedMinor, updatedAt: now })
		.where(eq(loyaltyPurchases.id, purchase.id))
		.returning()
	return row!
}

/**
 * Applies the source's recorded refunds right after an operator decided its
 * purchase or redemption, in the same transaction: a reward spent after every
 * cent came back is restored at once, so the outcome never depends on whether
 * the refund or the decision came first. Skips reading the source when
 * nothing the decision left could change (no spent reward, no earned sale).
 */
export async function applyRefundsAfterDecisionInTx(
	tx: LoyaltyTx,
	source: LoyaltySourceRef,
	now: number,
): Promise<void> {
	const latest = await latestRedemptionForSourceInTx(tx, source)
	const purchase = await purchaseForSourceInTx(tx, source)
	if (latest?.state !== 'consumed' && purchase?.state !== 'completed') return
	const facts = await readSourceFactsInTx(tx, source, {
		redemption: latest,
		now,
	})
	if (!facts || facts.refundedMinor <= 0) return
	const synced = await syncRefundedMinorInTx(tx, purchase, facts, now)
	await applySourceRefundsInTx(tx, source, facts, {
		purchase: synced,
		reversedBefore: synced?.reversedPoints ?? 0,
		now,
	})
}

/** Moves a source's purchase and redemption to what the sale itself says now. */
export async function reconcileSourceInTx(
	tx: LoyaltyTx,
	source: LoyaltySourceRef,
	now: number,
	options: ReconcileOptions = {},
): Promise<ReconcileResult> {
	let purchase = await purchaseForSourceInTx(tx, source)
	let redemption = await activeRedemptionForSourceInTx(
		tx,
		source.type,
		source.id,
	)
	if (!purchase && !redemption) {
		return { purchase: null, redemption: null, verdict: 'untracked' }
	}
	const facts = await readSourceFactsInTx(tx, source, {
		redemption: redemption ?? (await latestRedemptionForSourceInTx(tx, source)),
		now,
	})
	if (!facts) return { purchase, redemption, verdict: 'missing' }
	const { verdict } = facts
	const sourceRefundedMinor = facts.refundedMinor
	// Settling a sale applies what its purchase records as refunded.
	purchase = await syncRefundedMinorInTx(tx, purchase, facts, now)
	const reversedBefore = purchase?.reversedPoints ?? 0
	switch (verdict.kind) {
		case 'open':
			break
		case 'cancelled': {
			if (holdsPoints(redemption)) {
				redemption = await releaseRedemptionInTx(tx, redemption, {
					reason: verdict.releaseReason,
					at: now,
				})
			}
			if (purchase && unsettled(purchase)) {
				purchase = await excludePurchaseInTx(tx, purchase, 'cancelled', now)
			}
			break
		}
		case 'review': {
			if (redemption?.state === 'bound') {
				redemption = await reviewRedemptionInTx(tx, redemption, {
					reason: verdict.reason,
					at: now,
				})
			}
			if (purchase && (unsettled(purchase) || reopenable(purchase))) {
				purchase = await reviewPurchaseInTx(tx, purchase, verdict.reason, now)
			}
			break
		}
		case 'excluded': {
			if (holdsPoints(redemption)) {
				redemption = await releaseRedemptionInTx(tx, redemption, {
					reason: verdict.releaseReason,
					at: now,
				})
			}
			if (purchase && (unsettled(purchase) || reopenable(purchase))) {
				purchase = await excludePurchaseInTx(tx, purchase, verdict.reason, now)
			}
			break
		}
		case 'completed': {
			if (
				redemption &&
				(redemption.state === 'bound' || redemption.state === 'review')
			) {
				if (verdict.releaseReason) {
					redemption = await releaseRedemptionInTx(tx, redemption, {
						reason: verdict.releaseReason,
						at: now,
					})
				} else if (!options.trusted && verdict.holdReason) {
					// The sale waits for an operator (a flagged till sale, lines that
					// no longer fit the reward): the points stay held with it. A
					// suspicious sale time is not a hold reason: the upload carries
					// the approved discount, only its earning is in doubt.
					redemption = await reviewRedemptionInTx(tx, redemption, {
						reason: verdict.holdReason,
						at: now,
					})
				} else if (
					!options.trusted &&
					redemption.discountMinor !== verdict.loyaltyDiscountMinor
				) {
					// The sale carries another discount than the one approved: an
					// operator decides whether the reward was used, so the points
					// stay held instead of being spent.
					redemption = await reviewRedemptionInTx(tx, redemption, {
						reason: 'upload_mismatch',
						at: now,
					})
				} else {
					redemption = await consumeRedemptionInTx(tx, redemption, {
						at: now,
						actorKind: options.actorKind ?? 'system',
						actorId: options.actorId ?? null,
					})
				}
			}
			if (purchase) {
				purchase = await settlePurchaseInTx(
					tx,
					purchase,
					facts,
					verdict,
					redemption ?? (await latestRedemptionForSourceInTx(tx, source)),
					now,
					options,
				)
			}
			break
		}
	}
	if (sourceRefundedMinor > 0) {
		const applied = await applySourceRefundsInTx(tx, source, facts, {
			purchase,
			reversedBefore,
			now,
		})
		purchase = applied.purchase
		if (applied.restored && applied.restored.id === redemption?.id) {
			redemption = applied.restored
		}
	}
	return { purchase, redemption, verdict: verdict.kind }
}

/**
 * Closes a source's outbox row once it reconciled, only while the row is
 * still pending: a row another driver already finished stays as it was (its
 * done time is not overwritten), and a parked row stays parked until an
 * operator answers it or the source is queued again. Reconciling itself is
 * idempotent under the lock, so a driver that lost its lease still did no harm.
 */
async function markOutboxDoneInTx(
	tx: LoyaltyTx,
	source: LoyaltySourceRef,
	at: number,
): Promise<void> {
	await tx
		.update(loyaltyOutbox)
		.set({
			status: 'done',
			doneAt: at,
			lastError: null,
			claimedUntil: null,
			updatedAt: at,
		})
		.where(and(outboxRowIs(source), eq(loyaltyOutbox.status, 'pending')))
}

export async function reconcileLoyaltySource(
	orgId: string,
	source: LoyaltySourceRef,
	options: { now?: number } = {},
): Promise<ReconcileResult> {
	return withLoyaltyWrite({ orgId, now: options.now }, async (tx, ctx) => {
		const result = await reconcileSourceInTx(tx, source, ctx.now)
		await markOutboxDoneInTx(tx, source, ctx.now)
		return result
	})
}

function failureCode(error: unknown): string {
	if (error instanceof LoyaltyDomainError) return error.code
	return (error instanceof Error ? error.name : 'unknown').slice(0, 64)
}

/** How long a driver holds an outbox row it is reconciling. */
export const LOYALTY_OUTBOX_LEASE_MS = 60_000

function outboxRowIs(source: LoyaltySourceRef) {
	return and(
		eq(loyaltyOutbox.sourceType, source.type),
		eq(loyaltyOutbox.sourceId, source.id),
	)
}

/**
 * Takes a due row for one driver, under the lock: the lease it returns, or
 * null when the row is no longer due (another driver finished or counted it)
 * or another driver holds it. A lease left by a driver that died runs out.
 */
async function claimOutboxRow(
	orgId: string,
	source: LoyaltySourceRef,
	now: number,
): Promise<number | null> {
	const lease = now + LOYALTY_OUTBOX_LEASE_MS
	const claimed = await withLoyaltyWrite({ orgId, now }, (tx) =>
		tx
			.update(loyaltyOutbox)
			.set({ claimedUntil: lease })
			.where(
				and(
					outboxRowIs(source),
					eq(loyaltyOutbox.status, 'pending'),
					lte(loyaltyOutbox.nextAttemptAt, now),
					or(
						isNull(loyaltyOutbox.claimedUntil),
						lte(loyaltyOutbox.claimedUntil, now),
					),
				),
			)
			.returning({ sourceId: loyaltyOutbox.sourceId }),
	)
	return claimed.length > 0 ? lease : null
}

type OutboxFailure = {
	/** False when another driver already counted this attempt. */
	counted: boolean
	parked: boolean
	/** When the source is due again; null when parked or not recorded. */
	nextAttemptAt: number | null
}

/**
 * Backs a failed source off; after the last attempt it is parked and its
 * purchase and bound redemption wait for an operator. Under the lock it
 * counts the failure only while the attempt is still the one that failed:
 * the row is pending and due, and not held by another driver (with `lease`,
 * still held by this one). The attempt is committed before the reviews, so a
 * review that cannot be written never keeps a source retrying forever.
 */
async function recordOutboxFailure(
	orgId: string,
	source: LoyaltySourceRef,
	error: unknown,
	now: number,
	lease?: number,
): Promise<OutboxFailure> {
	const code = failureCode(error)
	let recorded: { attempts: number; park: boolean; nextAttemptAt: number }
	try {
		const result = await withLoyaltyWrite({ orgId, now }, async (tx) => {
			const current = await tx
				.select()
				.from(loyaltyOutbox)
				.where(outboxRowIs(source))
				.get()
			if (
				!current ||
				current.status !== 'pending' ||
				current.nextAttemptAt > now ||
				(lease === undefined
					? current.claimedUntil !== null && current.claimedUntil > now
					: current.claimedUntil !== lease)
			) {
				return null
			}
			const attempts = current.attempts + 1
			const park = attempts >= LOYALTY_OUTBOX_MAX_ATTEMPTS
			const nextAttemptAt = now + loyaltyOutboxBackoffMs(attempts)
			await tx
				.update(loyaltyOutbox)
				.set({
					attempts,
					status: park ? 'failed' : 'pending',
					nextAttemptAt,
					lastError: code,
					claimedUntil: null,
					updatedAt: now,
				})
				.where(outboxRowIs(source))
			return { attempts, park, nextAttemptAt }
		})
		if (!result) return { counted: false, parked: false, nextAttemptAt: null }
		recorded = result
	} catch (inner) {
		console.error('Loyalty outbox failure not recorded', {
			orgId,
			sourceType: source.type,
			sourceId: source.id,
			...errorLogFields(inner),
		})
		return { counted: true, parked: false, nextAttemptAt: null }
	}
	if (!recorded.park) {
		return {
			counted: true,
			parked: false,
			nextAttemptAt: recorded.nextAttemptAt,
		}
	}
	console.error('Loyalty source parked for operator review', {
		orgId,
		sourceType: source.type,
		sourceId: source.id,
		error: code,
	})
	try {
		await withLoyaltyWrite({ orgId, now }, async (tx) => {
			const purchase = await purchaseForSourceInTx(tx, source)
			if (purchase && unsettled(purchase)) {
				await reviewPurchaseInTx(tx, purchase, 'reconciliation_failed', now)
			}
			const redemption = await activeRedemptionForSourceInTx(
				tx,
				source.type,
				source.id,
			)
			if (redemption?.state === 'bound') {
				await reviewRedemptionInTx(tx, redemption, {
					reason: 'reconciliation_failed',
					at: now,
				})
			}
			await recordLoyaltyAudit(tx, {
				actorKind: 'system',
				action: 'outbox.parked',
				entityType: 'outbox',
				entityId: `${source.type}:${source.id}`,
				changes: { attempts: recorded.attempts, error: code },
				at: now,
			})
		})
	} catch (inner) {
		// Still parked and counted: an operator finds it on the outbox list.
		console.error('Loyalty parked source review failed', {
			orgId,
			sourceType: source.type,
			sourceId: source.id,
			...errorLogFields(inner),
		})
	}
	return { counted: true, parked: true, nextAttemptAt: null }
}

export type LoyaltySettleResult = {
	settled: number
	/** Sources that failed and wait in the outbox for a retry. */
	deferred: number
	/** When the earliest deferred source is due again. */
	nextAttemptAt: number | null
}

/**
 * Settles sources right after the sale's own transaction committed. Never
 * throws: a source that fails stays queued for the tick, and the runtime is
 * told when it is due (`reportLoyaltyDeferred`) so it can wake up for it.
 */
export async function settleLoyaltySources(
	orgId: string,
	sources: readonly LoyaltySourceRef[],
	options: { now?: number } = {},
): Promise<LoyaltySettleResult> {
	const result: LoyaltySettleResult = {
		settled: 0,
		deferred: 0,
		nextAttemptAt: null,
	}
	for (const source of sources) {
		const now = options.now ?? Date.now()
		try {
			await reconcileLoyaltySource(orgId, source, { now })
			result.settled += 1
		} catch (error) {
			console.error('Loyalty reconciliation deferred', {
				orgId,
				sourceType: source.type,
				sourceId: source.id,
				error: failureCode(error),
			})
			const failure = await recordOutboxFailure(orgId, source, error, now)
			if (failure.parked) continue
			result.deferred += 1
			if (failure.nextAttemptAt !== null) {
				result.nextAttemptAt = Math.min(
					result.nextAttemptAt ?? failure.nextAttemptAt,
					failure.nextAttemptAt,
				)
			}
		}
	}
	if (result.nextAttemptAt !== null) {
		await reportLoyaltyDeferred(orgId, result.nextAttemptAt)
	}
	return result
}

export type LoyaltySettleQueue = {
	/** `queueLoyaltySourceInTx`, remembering the source for `settle`. */
	queue(
		tx: LoyaltyTx,
		source: LoyaltySourceRef,
		at: number,
		options?: { preserveAttempts?: boolean },
	): Promise<boolean>
	/** Call once the transaction committed and the org lock is free. */
	settle(
		orgId: string,
		options?: { now?: number },
	): Promise<LoyaltySettleResult>
}

/**
 * Collects the sources one sale transaction queued, to settle them right
 * after it commits. A busy retry may queue a source again, or one a rolled-back
 * attempt queued: settling re-reads the sale, so either is harmless.
 */
export function loyaltySettleQueue(): LoyaltySettleQueue {
	const sources = new Map<string, LoyaltySourceRef>()
	return {
		async queue(tx, source, at, options) {
			const queued = await queueLoyaltySourceInTx(tx, source, at, options)
			if (queued) sources.set(`${source.type}:${source.id}`, source)
			return queued
		},
		async settle(orgId, options) {
			if (sources.size === 0) {
				return { settled: 0, deferred: 0, nextAttemptAt: null }
			}
			const pending = [...sources.values()]
			sources.clear()
			return settleLoyaltySources(orgId, pending, options)
		},
	}
}

export const LOYALTY_OUTBOX_BATCH = 50

/**
 * Works through due sources, oldest first. The due list is read outside the
 * lock, so each row is claimed first: another driver (cron, alarm, interval,
 * settle) that got to it skips it instead of reconciling it again.
 */
export async function processLoyaltyOutbox(
	orgId: string,
	options: { now?: number; limit?: number } = {},
): Promise<{ processed: number; failed: number; parked: number }> {
	const now = options.now ?? Date.now()
	const limit = Math.min(
		Math.max(options.limit ?? LOYALTY_OUTBOX_BATCH, 1),
		200,
	)
	const db = await getTenantDb(orgId)
	const due = await db
		.select()
		.from(loyaltyOutbox)
		.where(
			and(
				eq(loyaltyOutbox.status, 'pending'),
				lte(loyaltyOutbox.nextAttemptAt, now),
			),
		)
		.orderBy(asc(loyaltyOutbox.nextAttemptAt))
		.limit(limit)
		.all()
	let processed = 0
	let failed = 0
	let parked = 0
	for (const row of due) {
		const source = { type: row.sourceType, id: row.sourceId }
		const lease = await claimOutboxRow(orgId, source, now)
		if (lease === null) continue
		try {
			await reconcileLoyaltySource(orgId, source, { now })
			processed += 1
		} catch (error) {
			const failure = await recordOutboxFailure(
				orgId,
				source,
				error,
				now,
				lease,
			)
			if (failure.counted) failed += 1
			if (failure.parked) parked += 1
		}
	}
	return { processed, failed, parked }
}
/**
 * An operator retries a parked source. One with nothing left to reconcile
 * (its only hold ended after it parked) is closed instead: a retry would do
 * nothing, and the parked count would never come down. Returns whether it
 * was queued.
 */
export async function requeueLoyaltySource(
	orgId: string,
	input: {
		source: LoyaltySourceRef
		actorId: string
		locationIds: readonly string[] | null
		now?: number
	},
): Promise<{ queued: boolean }> {
	const queued = await withLoyaltyWrite(
		{ orgId, now: input.now },
		async (tx, ctx) => {
			const purchase = await purchaseForSourceInTx(tx, input.source)
			const redemption = await latestRedemptionForSourceInTx(tx, input.source)
			const locationId = purchase?.locationId ?? redemption?.locationId ?? null
			if (!locationVisible(input.locationIds, locationId)) {
				throw new LoyaltyDomainError('location_forbidden')
			}
			const audit = {
				actorKind: 'operator' as const,
				actorId: input.actorId,
				locationId,
				entityType: 'outbox' as const,
				entityId: `${input.source.type}:${input.source.id}`,
				at: ctx.now,
			}
			if (await queueLoyaltySourceInTx(tx, input.source, ctx.now)) {
				await recordLoyaltyAudit(tx, { ...audit, action: 'outbox.requeued' })
				return true
			}
			const closed = await tx
				.update(loyaltyOutbox)
				.set({
					status: 'done',
					doneAt: ctx.now,
					lastError: null,
					updatedAt: ctx.now,
				})
				.where(
					and(
						eq(loyaltyOutbox.sourceType, input.source.type),
						eq(loyaltyOutbox.sourceId, input.source.id),
						eq(loyaltyOutbox.status, 'failed'),
					),
				)
				.returning({ sourceId: loyaltyOutbox.sourceId })
			if (closed.length === 0)
				throw new LoyaltyDomainError('purchase_not_found')
			await recordLoyaltyAudit(tx, { ...audit, action: 'outbox.closed' })
			return false
		},
	)
	if (queued)
		await settleLoyaltySources(orgId, [input.source], { now: input.now })
	return { queued }
}

/**
 * An operator decides a purchase waiting in review: award it (the sale is
 * complete; the operator vouches for its time and discount) or exclude it.
 */
export async function resolvePurchase(
	orgId: string,
	input: {
		purchaseId: string
		action: 'award' | 'exclude'
		note: string
		actorId: string
		locationIds: readonly string[] | null
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<LoyaltyOperatorPurchase> {
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			const purchase = await readPurchaseInTx(tx, input.purchaseId)
			if (!purchase) throw new LoyaltyDomainError('purchase_not_found')
			if (!locationVisible(input.locationIds, purchase.locationId)) {
				throw new LoyaltyDomainError('location_forbidden')
			}
			ctx.linkMember(purchase.memberId)
			if (purchase.state !== 'review') {
				throw new LoyaltyDomainError('invalid_transition')
			}
			let next: PurchaseRow
			if (input.action === 'exclude') {
				next = await excludePurchaseInTx(
					tx,
					purchase,
					'operator_excluded',
					ctx.now,
				)
				await applyRefundsAfterDecisionInTx(
					tx,
					{ type: purchase.sourceType, id: purchase.sourceId },
					ctx.now,
				)
			} else {
				const result = await reconcileSourceInTx(
					tx,
					{ type: purchase.sourceType, id: purchase.sourceId },
					ctx.now,
					{ trusted: true, actorKind: 'operator', actorId: input.actorId },
				)
				// Only a finished sale can be awarded; fix the order first.
				if (result.purchase?.state !== 'completed') {
					throw new LoyaltyDomainError('invalid_transition')
				}
				next = result.purchase
			}
			await closeParkedSourceInTx(
				tx,
				{ type: purchase.sourceType, id: purchase.sourceId },
				ctx.now,
			)
			await recordLoyaltyAudit(tx, {
				actorKind: 'operator',
				actorId: input.actorId,
				locationId: purchase.locationId,
				action:
					input.action === 'award' ? 'purchase.awarded' : 'purchase.excluded',
				entityType: 'purchase',
				entityId: purchase.id,
				changes: {
					reviewReason: purchase.reviewReason,
					points: next.awardedPoints,
					note: input.note,
				},
				at: ctx.now,
			})
			return toOperatorPurchase(next)
		},
	)
}
