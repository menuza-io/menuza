import {
	LOYALTY_ADJUSTMENT_CREDIT_WINDOW_MS,
	LOYALTY_MAX_ADJUSTMENT_DELTA,
	LOYALTY_MAX_DAILY_ADJUSTMENT_CREDIT,
	LoyaltyDomainError,
	loyaltyEventKeys,
	type LoyaltyAdjustmentReason,
	type LoyaltyBalanceView,
	type LoyaltyOperatorBalance,
	type LoyaltyFeatures,
	type LoyaltyHistoryEntry,
	type LoyaltyMemberSummary,
	type LoyaltyOperatorLedgerEntry,
	type LoyaltyOperatorPurchase,
	type LoyaltyOperatorRedemption,
	type LoyaltyWallet,
} from '@repo/loyalty'
import {
	customers,
	loyaltyApprovals,
	loyaltyLedger,
	loyaltyMemberBindings,
	loyaltyMemberCodes,
	loyaltyMembers,
	loyaltyPurchases,
	loyaltyRedemptions,
} from '@repo/tenant-db'
import {
	and,
	type AnyColumn,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	or,
	sql,
	type SQL,
} from 'drizzle-orm'
import { inJsonList } from '../lib/chunked-in.ts'
import { getLoyaltyFlagState } from '../lib/loyalty-context.ts'
import {
	type LoyaltyIdempotency,
	type LoyaltyReader,
	type LoyaltyTx,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import { recordLoyaltyAudit } from './loyalty-audit.ts'
import {
	ensureBalanceRowInTx,
	postLedgerEntryInTx,
	readBalanceViewInTx,
	readOperatorBalanceViewInTx,
} from './loyalty-ledger.ts'
import { getPublicProgram, readProgramInTx } from './loyalty-program-service.ts'
import { releaseRedemptionInTx } from './loyalty-redemption-service.ts'

export type MemberRow = typeof loyaltyMembers.$inferSelect

export const LOYALTY_PAGE_LIMIT = 50

// ---------------------------------------------------------------------------
// Cursors: opaque `(at, id)` positions for newest-first pages.
// ---------------------------------------------------------------------------

export function encodeLoyaltyCursor(at: number, id: string): string {
	return btoa(JSON.stringify([at, id]))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

export function decodeLoyaltyCursor(
	cursor: string | null | undefined,
): { at: number; id: string } | null {
	if (!cursor) return null
	try {
		if (cursor.length > 200) throw new Error('cursor')
		const padded = cursor.replace(/-/g, '+').replace(/_/g, '/')
		const value: unknown = JSON.parse(atob(padded))
		if (
			Array.isArray(value) &&
			value.length === 2 &&
			Number.isSafeInteger(value[0]) &&
			typeof value[1] === 'string' &&
			value[1].length <= 64
		) {
			return { at: value[0] as number, id: value[1] }
		}
	} catch {
		// fall through
	}
	throw new LoyaltyDomainError('invalid_request', { field: 'cursor' })
}

export function beforeCursor(
	atColumn: AnyColumn,
	idColumn: AnyColumn,
	cursor: { at: number; id: string } | null,
): SQL | undefined {
	if (!cursor) return undefined
	return or(
		lt(atColumn, cursor.at),
		and(eq(atColumn, cursor.at), lt(idColumn, cursor.id)),
	)
}

function pageLimit(limit: number | undefined): number {
	return Math.min(Math.max(Math.floor(limit ?? LOYALTY_PAGE_LIMIT), 1), 100)
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function readMemberInTx(
	db: LoyaltyReader,
	memberId: string,
): Promise<MemberRow | null> {
	return (
		(await db
			.select()
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.id, memberId))
			.get()) ?? null
	)
}

export async function memberForCustomerInTx(
	db: LoyaltyReader,
	customerId: string,
): Promise<MemberRow | null> {
	return (
		(await db
			.select()
			.from(loyaltyMembers)
			.where(eq(loyaltyMembers.customerId, customerId))
			.get()) ?? null
	)
}

/**
 * A customer is the member: signing in with a verified phone links the
 * customer to the points system without any step of their own. This opens the
 * customer's points account (a member row and its balance) and nothing else.
 * It never touches marketing consent.
 *
 * Does nothing (returns null) unless the program exists and is active, the
 * customer exists with a verified phone (a phone that only a till or a form
 * captured is never linked), and no account exists yet. An existing account is
 * returned as it is: a suspended account stays suspended, an erased one is
 * never recreated. Race-safe: callers run under the organization's write lock
 * and the customer column is unique, so concurrent calls open one account.
 */
export async function ensureMemberForCustomerInTx(
	tx: LoyaltyTx,
	customerId: string,
	now: number,
): Promise<MemberRow | null> {
	const existing = await memberForCustomerInTx(tx, customerId)
	if (existing) return existing
	const program = await readProgramInTx(tx)
	if (!program || program.program.status !== 'active') return null
	const customer = await tx
		.select({ id: customers.id, phoneVerified: customers.phoneVerified })
		.from(customers)
		.where(eq(customers.id, customerId))
		.get()
	if (!customer?.phoneVerified) return null
	await tx
		.insert(loyaltyMembers)
		.values({
			customerId,
			status: 'active',
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
	const member = await memberForCustomerInTx(tx, customerId)
	if (!member) return null
	await ensureBalanceRowInTx(tx, member.id, now)
	return member
}

/**
 * `ensureMemberForCustomerInTx` as its own write, for the places that are not
 * already inside a transaction (sign-in, the wallet read).
 */
export async function ensureMemberForCustomer(
	orgId: string,
	input: { customerId: string; now?: number },
): Promise<MemberRow | null> {
	return withLoyaltyWrite({ orgId, now: input.now }, async (tx, ctx) => {
		const member = await ensureMemberForCustomerInTx(
			tx,
			input.customerId,
			ctx.now,
		)
		if (member) ctx.linkMember(member.id)
		return member
	})
}

/**
 * What sign-in does for loyalty: when the organization's loyalty features are
 * known to be on, open the customer's points account. Never throws and never
 * reports anything but ids to the log, so it can run behind a sign-in that must
 * not fail or wait for it. Unknown flags open nothing: the wallet, the first
 * order and the member code open it later.
 */
export async function openPointsAccountOnSignIn(
	orgId: string,
	customerId: string,
): Promise<void> {
	try {
		const flags = await getLoyaltyFlagState(orgId)
		if (flags.status !== 'on') return
		await ensureMemberForCustomer(orgId, { customerId })
	} catch (error) {
		console.error('Loyalty account could not be opened at sign-in', {
			orgId,
			customerId,
			reason: error instanceof Error ? error.name : 'unknown',
		})
	}
}

export async function pendingApprovalCountInTx(
	db: LoyaltyReader,
	memberId: string,
	now: number,
): Promise<number> {
	const row = await db
		.select({ count: sql<number>`count(*)` })
		.from(loyaltyApprovals)
		.where(
			and(
				eq(loyaltyApprovals.memberId, memberId),
				eq(loyaltyApprovals.status, 'pending'),
				gt(loyaltyApprovals.expiresAt, now),
			),
		)
		.get()
	return Number(row?.count ?? 0)
}

/** The signed-in customer's wallet; `null` when the program is not available. */
export async function getWallet(
	db: LoyaltyReader,
	input: { customerId: string; features: LoyaltyFeatures; now?: number },
): Promise<LoyaltyWallet | null> {
	const now = input.now ?? Date.now()
	const program = await getPublicProgram(db, input.features)
	if (!program) return null
	const member = await memberForCustomerInTx(db, input.customerId)
	if (!member || member.status === 'erased') {
		return {
			program,
			member: null,
			balance: null,
			nextReward: null,
			pendingApprovals: 0,
		}
	}
	const balance = await readBalanceViewInTx(db, member.id)
	const next = program.rewards
		.filter((reward) => reward.pointsCost > balance.available)
		.sort((a, b) => a.pointsCost - b.pointsCost)[0]
	return {
		program,
		member: { id: member.id, status: member.status },
		balance,
		nextReward: next
			? {
					rewardId: next.id,
					pointsNeeded: next.pointsCost - balance.available,
				}
			: null,
		pendingApprovals: await pendingApprovalCountInTx(db, member.id, now),
	}
}

/** A member's own point history, newest first. */
export async function getMemberHistory(
	db: LoyaltyReader,
	input: { memberId: string; cursor?: string | null; limit?: number },
): Promise<{ entries: LoyaltyHistoryEntry[]; nextCursor: string | null }> {
	const limit = pageLimit(input.limit)
	const cursor = decodeLoyaltyCursor(input.cursor)
	const rows = await db
		.select({
			id: loyaltyLedger.id,
			at: loyaltyLedger.at,
			type: loyaltyLedger.type,
			delta: loyaltyLedger.delta,
			channel: loyaltyLedger.channel,
			reason: loyaltyLedger.reason,
			rewardName: loyaltyRedemptions.rewardName,
		})
		.from(loyaltyLedger)
		.leftJoin(
			loyaltyRedemptions,
			eq(loyaltyRedemptions.id, loyaltyLedger.redemptionId),
		)
		.where(
			and(
				eq(loyaltyLedger.memberId, input.memberId),
				beforeCursor(loyaltyLedger.at, loyaltyLedger.id, cursor),
			),
		)
		.orderBy(desc(loyaltyLedger.at), desc(loyaltyLedger.id))
		.limit(limit + 1)
		.all()
	const page = rows.slice(0, limit)
	const last = page[page.length - 1]
	return {
		entries: page.map((row) => ({
			id: row.id,
			at: row.at,
			type: row.type,
			delta: row.delta,
			channel: row.channel,
			rewardName: row.rewardName ?? null,
			reason: row.type === 'adjust' ? row.reason : null,
		})),
		nextCursor:
			rows.length > limit && last
				? encodeLoyaltyCursor(last.at, last.id)
				: null,
	}
}

// ---------------------------------------------------------------------------
// Operator views
// ---------------------------------------------------------------------------

function phoneLast4(phone: string | null): string | null {
	if (!phone) return null
	const digits = phone.replace(/\D/g, '')
	return digits.length >= 4 ? digits.slice(-4) : null
}

type MemberWithCustomer = {
	member: MemberRow
	name: string | null
	phone: string | null
}

function toSummary(
	row: MemberWithCustomer,
	balance: LoyaltyOperatorBalance,
): LoyaltyMemberSummary {
	return {
		id: row.member.id,
		customerId: row.member.customerId,
		name: row.member.status === 'erased' ? null : row.name,
		phoneLast4: row.member.status === 'erased' ? null : phoneLast4(row.phone),
		status: row.member.status,
		createdAt: row.member.createdAt,
		balance,
		lastPurchaseAt: row.member.lastPurchaseAt,
	}
}

function memberWithCustomerQuery(db: LoyaltyReader) {
	return db
		.select({
			member: loyaltyMembers,
			name: customers.name,
			phone: customers.phone,
		})
		.from(loyaltyMembers)
		.leftJoin(customers, eq(customers.id, loyaltyMembers.customerId))
}

/**
 * Members a location-scoped operator may see. A member has no location of
 * their own, so they are visible through a purchase or a redemption at one of
 * the token's locations, the clause the report counts members with (a row
 * with no location is organization-wide and counts for every scope). Ledger
 * entries count only when tied to a listed location: organization-wide
 * entries such as manual adjustments say nothing about where a member shops.
 */
function memberScopeCondition(
	locationIds: readonly string[] | null,
): SQL | undefined {
	if (locationIds === null) return undefined
	const orgWideOrListed = (column: AnyColumn) =>
		locationIds.length === 0
			? isNull(column)
			: or(isNull(column), inJsonList(column, locationIds))!
	const clauses = [
		sql`exists (select 1 from ${loyaltyPurchases} where ${loyaltyPurchases.memberId} = ${loyaltyMembers.id} and ${orgWideOrListed(loyaltyPurchases.locationId)})`,
		sql`exists (select 1 from ${loyaltyRedemptions} where ${loyaltyRedemptions.memberId} = ${loyaltyMembers.id} and ${orgWideOrListed(loyaltyRedemptions.locationId)})`,
	]
	if (locationIds.length > 0) {
		clauses.push(
			sql`exists (select 1 from ${loyaltyLedger} where ${loyaltyLedger.memberId} = ${loyaltyMembers.id} and ${inJsonList(loyaltyLedger.locationId, locationIds)})`,
		)
	}
	return or(...clauses)
}

export async function getMemberSummaryInTx(
	db: LoyaltyReader,
	memberId: string,
	locationIds: readonly string[] | null = null,
): Promise<LoyaltyMemberSummary | null> {
	const row = await memberWithCustomerQuery(db)
		.where(
			and(eq(loyaltyMembers.id, memberId), memberScopeCondition(locationIds)),
		)
		.get()
	if (!row) return null
	return toSummary(row, await readOperatorBalanceViewInTx(db, memberId))
}

export async function getMemberForCustomer(
	db: LoyaltyReader,
	customerId: string,
	locationIds: readonly string[] | null = null,
): Promise<LoyaltyMemberSummary | null> {
	const member = await memberForCustomerInTx(db, customerId)
	return member ? getMemberSummaryInTx(db, member.id, locationIds) : null
}

export function toOperatorLedgerEntry(
	row: typeof loyaltyLedger.$inferSelect,
	/** The member's customer; null once the person is erased. */
	customerId: string | null,
): LoyaltyOperatorLedgerEntry {
	return {
		id: row.id,
		at: row.at,
		memberId: row.memberId,
		customerId,
		type: row.type,
		delta: row.delta,
		channel: row.channel,
		locationId: row.locationId,
		purchaseId: row.purchaseId,
		redemptionId: row.redemptionId,
		reason: row.reason,
		note: row.note,
		actorKind: row.actorKind,
		actorId: row.actorId,
	}
}

export function toOperatorPurchase(
	row: typeof loyaltyPurchases.$inferSelect,
): LoyaltyOperatorPurchase {
	return {
		id: row.id,
		memberId: row.memberId,
		channel: row.channel,
		sourceType: row.sourceType,
		sourceId: row.sourceId,
		locationId: row.locationId,
		currency: row.currency,
		occurredAt: row.occurredAt,
		state: row.state,
		reviewReason: row.reviewReason as LoyaltyOperatorPurchase['reviewReason'],
		excludedReason:
			row.excludedReason as LoyaltyOperatorPurchase['excludedReason'],
		skipReason: row.skipReason as LoyaltyOperatorPurchase['skipReason'],
		programVersion: row.programVersion,
		eligibleMinor: row.eligibleMinor,
		totalPaidMinor: row.totalPaidMinor,
		awardedPoints: row.awardedPoints,
		reversedPoints: row.reversedPoints,
		refundedMinor: row.refundedMinor,
	}
}

export function toOperatorRedemption(
	row: typeof loyaltyRedemptions.$inferSelect,
): LoyaltyOperatorRedemption {
	return {
		id: row.id,
		memberId: row.memberId,
		rewardId: row.rewardId,
		rewardVersion: row.rewardVersion,
		rewardName: row.rewardName,
		points: row.points,
		state: row.state,
		channel: row.channel,
		sourceType: row.sourceType,
		sourceId: row.sourceId,
		locationId: row.locationId,
		currency: row.currency,
		discountMinor: row.discountMinor,
		reviewReason: row.reviewReason as LoyaltyOperatorRedemption['reviewReason'],
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

/** Whether a location-scoped operator may see a row tied to `locationId`. */
export function locationVisible(
	locationIds: readonly string[] | null,
	locationId: string | null,
): boolean {
	if (locationIds === null || locationId === null) return true
	return locationIds.includes(locationId)
}

const DETAIL_ENTRY_LIMIT = 100
const DETAIL_ROW_LIMIT = 50

/**
 * One member for an operator, or null when a location-scoped operator cannot
 * see the member at all. Activity tied to a location the operator cannot see
 * is left out (and says so); organization-wide entries such as manual
 * adjustments are always shown.
 */
export async function getMemberDetail(
	db: LoyaltyReader,
	input: { memberId: string; locationIds: readonly string[] | null },
): Promise<{
	member: LoyaltyMemberSummary
	entries: LoyaltyOperatorLedgerEntry[]
	purchases: LoyaltyOperatorPurchase[]
	redemptions: LoyaltyOperatorRedemption[]
	filteredByLocation: boolean
} | null> {
	const member = await getMemberSummaryInTx(
		db,
		input.memberId,
		input.locationIds,
	)
	if (!member) return null
	const entries = await db
		.select()
		.from(loyaltyLedger)
		.where(eq(loyaltyLedger.memberId, input.memberId))
		.orderBy(desc(loyaltyLedger.at), desc(loyaltyLedger.id))
		.limit(DETAIL_ENTRY_LIMIT)
		.all()
	const purchases = await db
		.select()
		.from(loyaltyPurchases)
		.where(eq(loyaltyPurchases.memberId, input.memberId))
		.orderBy(desc(loyaltyPurchases.createdAt), desc(loyaltyPurchases.id))
		.limit(DETAIL_ROW_LIMIT)
		.all()
	const redemptions = await db
		.select()
		.from(loyaltyRedemptions)
		.where(eq(loyaltyRedemptions.memberId, input.memberId))
		.orderBy(desc(loyaltyRedemptions.createdAt), desc(loyaltyRedemptions.id))
		.limit(DETAIL_ROW_LIMIT)
		.all()
	const visible = <T extends { locationId: string | null }>(rows: T[]) =>
		rows.filter((row) => locationVisible(input.locationIds, row.locationId))
	const shownEntries = visible(entries)
	const shownPurchases = visible(purchases)
	const shownRedemptions = visible(redemptions)
	return {
		member,
		entries: shownEntries.map((row) =>
			toOperatorLedgerEntry(row, member.customerId),
		),
		purchases: shownPurchases.map(toOperatorPurchase),
		redemptions: shownRedemptions.map(toOperatorRedemption),
		filteredByLocation:
			shownEntries.length !== entries.length ||
			shownPurchases.length !== purchases.length ||
			shownRedemptions.length !== redemptions.length,
	}
}

/**
 * Refuses an addition that would take one operator past
 * LOYALTY_MAX_DAILY_ADJUSTMENT_CREDIT points within the window. A retry of an
 * adjustment that was already posted is never counted twice.
 */
async function requireAdjustmentAllowanceInTx(
	tx: LoyaltyTx,
	input: { actorId: string; delta: number; eventKey: string; now: number },
): Promise<void> {
	const posted = await tx
		.select({ id: loyaltyLedger.id })
		.from(loyaltyLedger)
		.where(eq(loyaltyLedger.eventKey, input.eventKey))
		.get()
	if (posted) return
	const row = await tx
		.select({
			added: sql<number>`coalesce(sum(${loyaltyLedger.delta}), 0)`,
		})
		.from(loyaltyLedger)
		.where(
			and(
				gt(loyaltyLedger.at, input.now - LOYALTY_ADJUSTMENT_CREDIT_WINDOW_MS),
				eq(loyaltyLedger.type, 'adjust'),
				eq(loyaltyLedger.actorKind, 'operator'),
				eq(loyaltyLedger.actorId, input.actorId),
				gt(loyaltyLedger.delta, 0),
			),
		)
		.get()
	const remainingPoints = Math.max(
		0,
		LOYALTY_MAX_DAILY_ADJUSTMENT_CREDIT - Number(row?.added ?? 0),
	)
	if (input.delta > remainingPoints) {
		throw new LoyaltyDomainError('adjustment_limit', { remainingPoints })
	}
}

/**
 * A manual point change. Needs a reason and a note, keeps the operator on the
 * ledger entry and in the audit log, and may leave the member owing points.
 * Additions are limited per operator per day; removals only per call.
 */
export async function adjustMemberPoints(
	orgId: string,
	input: {
		memberId: string
		delta: number
		reason: LoyaltyAdjustmentReason
		note: string
		actorId: string
		idempotencyKey: string
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<{
	entry: LoyaltyOperatorLedgerEntry
	balance: LoyaltyOperatorBalance
}> {
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			if (
				!Number.isSafeInteger(input.delta) ||
				input.delta === 0 ||
				Math.abs(input.delta) > LOYALTY_MAX_ADJUSTMENT_DELTA
			) {
				throw new LoyaltyDomainError('adjustment_invalid')
			}
			const member = await readMemberInTx(tx, input.memberId)
			if (!member || member.status === 'erased') {
				throw new LoyaltyDomainError('member_not_found')
			}
			ctx.linkMember(member.id)
			const eventKey = loyaltyEventKeys.adjust(member.id, input.idempotencyKey)
			if (input.delta > 0) {
				await requireAdjustmentAllowanceInTx(tx, {
					actorId: input.actorId,
					delta: input.delta,
					eventKey,
					now: ctx.now,
				})
			}
			const posted = await postLedgerEntryInTx(tx, {
				memberId: member.id,
				type: 'adjust',
				delta: input.delta,
				eventKey,
				reason: input.reason,
				note: input.note,
				actorKind: 'operator',
				actorId: input.actorId,
				at: ctx.now,
			})
			if (posted.inserted) {
				await recordLoyaltyAudit(tx, {
					actorKind: 'operator',
					actorId: input.actorId,
					action: 'points.adjusted',
					entityType: 'member',
					entityId: member.id,
					changes: { delta: input.delta, reason: input.reason },
					at: ctx.now,
				})
			}
			const entry = await tx
				.select()
				.from(loyaltyLedger)
				.where(eq(loyaltyLedger.id, posted.id))
				.get()
			return {
				entry: toOperatorLedgerEntry(entry!, member.customerId),
				balance: await readOperatorBalanceViewInTx(tx, member.id),
			}
		},
	)
}

/**
 * Suspends or reinstates a member. A suspended member cannot spend or earn;
 * their unbound holds are released, pending till approvals cancelled, and
 * member codes and till bindings stop working.
 */
export async function setMemberStatus(
	orgId: string,
	input: {
		memberId: string
		status: 'active' | 'suspended'
		actorId: string
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<LoyaltyMemberSummary> {
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			const member = await readMemberInTx(tx, input.memberId)
			if (!member || member.status === 'erased') {
				throw new LoyaltyDomainError('member_not_found')
			}
			ctx.linkMember(member.id)
			if (member.status !== input.status) {
				await tx
					.update(loyaltyMembers)
					.set({
						status: input.status,
						suspendedAt: input.status === 'suspended' ? ctx.now : null,
						updatedAt: ctx.now,
					})
					.where(eq(loyaltyMembers.id, member.id))
				if (input.status === 'suspended') {
					await closeMemberAccessInTx(tx, member.id, ctx.now)
				}
				await recordLoyaltyAudit(tx, {
					actorKind: 'operator',
					actorId: input.actorId,
					action:
						input.status === 'suspended'
							? 'member.suspended'
							: 'member.reinstated',
					entityType: 'member',
					entityId: member.id,
					at: ctx.now,
				})
			}
			return (await getMemberSummaryInTx(tx, member.id))!
		},
	)
}

/**
 * Stops everything that lets someone act as the member: unused member codes,
 * till bindings, pending approvals and unbound holds. Bound redemptions stay:
 * their sale may already carry the discount.
 */
export async function closeMemberAccessInTx(
	tx: LoyaltyTx,
	memberId: string,
	now: number,
): Promise<void> {
	await tx
		.delete(loyaltyMemberCodes)
		.where(
			and(
				eq(loyaltyMemberCodes.memberId, memberId),
				isNull(loyaltyMemberCodes.usedAt),
			),
		)
	await tx
		.update(loyaltyMemberBindings)
		.set({ revokedAt: now })
		.where(
			and(
				eq(loyaltyMemberBindings.memberId, memberId),
				isNull(loyaltyMemberBindings.revokedAt),
			),
		)
	await tx
		.update(loyaltyApprovals)
		.set({ status: 'cancelled', decidedAt: now, updatedAt: now })
		.where(
			and(
				eq(loyaltyApprovals.memberId, memberId),
				eq(loyaltyApprovals.status, 'pending'),
			),
		)
	const holds = await tx
		.select()
		.from(loyaltyRedemptions)
		.where(
			and(
				eq(loyaltyRedemptions.memberId, memberId),
				eq(loyaltyRedemptions.state, 'reserved'),
			),
		)
		.all()
	for (const hold of holds) {
		await releaseRedemptionInTx(tx, hold, { reason: 'member_closed', at: now })
	}
}
