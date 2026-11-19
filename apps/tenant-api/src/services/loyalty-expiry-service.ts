import {
	addExpiryMonths,
	computePointExpiry,
	loyaltyEventKeys,
	type ComputePointExpiryResult,
	type ExpiryLedgerEntry,
	type LoyaltyLedgerType,
	type LoyaltyProgramConfig,
	type LoyaltyWallet,
} from '@repo/loyalty'
import {
	getTenantDb,
	loyaltyBalances,
	loyaltyLedger,
	loyaltyMembers,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, gt } from 'drizzle-orm'
import { type LoyaltyReader, withLoyaltyWrite } from '../lib/loyalty-write.ts'
import { recordLoyaltyAudit } from './loyalty-audit.ts'
import { postLedgerEntryInTx } from './loyalty-ledger.ts'
import {
	dispatchLoyaltyNotice,
	type LoyaltyNoticePayload,
} from './loyalty-notices-service.ts'
import { readProgramInTx } from './loyalty-program-service.ts'

const EXPIRY_TICK_BATCH_LIMIT = 200
const EXPIRY_ENABLE_NOTIFY_LIMIT = 500

const ACTIVITY_LEDGER_TYPES = new Set<LoyaltyLedgerType>([
	'earn',
	'redeem',
	'welcome',
	'referral',
])

function resolveLastActivityAt(
	entries: readonly ExpiryLedgerEntry[],
	member: Pick<
		typeof loyaltyMembers.$inferSelect,
		'createdAt' | 'lastPurchaseAt'
	>,
): number {
	let latest = Math.max(member.createdAt, member.lastPurchaseAt ?? 0)
	for (const entry of entries) {
		if (
			ACTIVITY_LEDGER_TYPES.has(entry.type) ||
			(entry.type === 'adjust' && entry.delta > 0)
		) {
			if (entry.createdAt > latest) latest = entry.createdAt
		}
	}
	return latest
}

async function loadExpiryLedgerEntriesInTx(
	db: LoyaltyReader,
	memberId: string,
): Promise<ExpiryLedgerEntry[]> {
	const rows = await db
		.select({
			id: loyaltyLedger.id,
			type: loyaltyLedger.type,
			delta: loyaltyLedger.delta,
			createdAt: loyaltyLedger.at,
			purchaseId: loyaltyLedger.purchaseId,
		})
		.from(loyaltyLedger)
		.where(eq(loyaltyLedger.memberId, memberId))
		.orderBy(asc(loyaltyLedger.at), asc(loyaltyLedger.id))
		.all()
	return rows.map((row) => ({
		id: row.id,
		type: row.type,
		delta: row.delta,
		createdAt: row.createdAt,
		purchaseId: row.purchaseId,
	}))
}

export async function evaluateMemberExpiryInTx(
	db: LoyaltyReader,
	input: {
		member: Pick<
			typeof loyaltyMembers.$inferSelect,
			'id' | 'createdAt' | 'lastPurchaseAt'
		>
		balancePoints: number
		config: LoyaltyProgramConfig
		now: number
	},
): Promise<ComputePointExpiryResult> {
	if (input.config.expiry.mode === 'never' || input.balancePoints <= 0) {
		return {
			expiredDue: 0,
			nextExpiryAt: null,
			nextExpiryPoints: 0,
			expiringWithin30d: 0,
			expiringWithin7d: 0,
			lots: [],
		}
	}
	const entries = await loadExpiryLedgerEntriesInTx(db, input.member.id)
	return computePointExpiry({
		config: input.config.expiry,
		entries,
		currentBalance: input.balancePoints,
		lastActivityAt: resolveLastActivityAt(entries, input.member),
		now: input.now,
	})
}

export async function buildWalletExpiryViewInTx(
	db: LoyaltyReader,
	input: {
		member: Pick<
			typeof loyaltyMembers.$inferSelect,
			'id' | 'createdAt' | 'lastPurchaseAt'
		>
		balancePoints: number
		config: LoyaltyProgramConfig
		now: number
	},
): Promise<LoyaltyWallet['expiry']> {
	if (input.config.expiry.mode === 'never') return null
	const evalResult = await evaluateMemberExpiryInTx(db, input)
	return {
		mode: input.config.expiry.mode,
		months: input.config.expiry.months,
		nextExpiryAt: evalResult.nextExpiryAt,
		nextExpiryPoints: evalResult.nextExpiryPoints,
		expiringWithin30d: evalResult.expiringWithin30d,
	}
}

export async function countExpiringSoon30dInTx(
	db: LoyaltyReader,
	input: { config: LoyaltyProgramConfig; now: number },
): Promise<{ pointsExpiringSoon30d: number; membersExpiringSoon30d: number }> {
	if (input.config.expiry.mode === 'never') {
		return { pointsExpiringSoon30d: 0, membersExpiringSoon30d: 0 }
	}
	const rows = await db
		.select({
			member: {
				id: loyaltyMembers.id,
				createdAt: loyaltyMembers.createdAt,
				lastPurchaseAt: loyaltyMembers.lastPurchaseAt,
			},
			points: loyaltyBalances.points,
		})
		.from(loyaltyMembers)
		.innerJoin(loyaltyBalances, eq(loyaltyBalances.memberId, loyaltyMembers.id))
		.where(
			and(eq(loyaltyMembers.status, 'active'), gt(loyaltyBalances.points, 0)),
		)
		.all()

	let pointsExpiringSoon30d = 0
	let membersExpiringSoon30d = 0
	for (const row of rows) {
		const evalResult = await evaluateMemberExpiryInTx(db, {
			member: row.member,
			balancePoints: row.points,
			config: input.config,
			now: input.now,
		})
		if (evalResult.expiringWithin30d > 0) {
			pointsExpiringSoon30d += evalResult.expiringWithin30d
			membersExpiringSoon30d += 1
		}
	}
	return { pointsExpiringSoon30d, membersExpiringSoon30d }
}

/**
 * Scheduled expiry tick: expires due point lots FIFO / after inactivity and
 * dispatches deduplicated 30-day and 7-day warning notices before points lapse.
 */
export async function processExpiryTickForOrg(
	orgId: string,
	options: { db?: TenantDatabase; now?: number } = {},
): Promise<{ expiredPoints: number; expiredMembers: number; warned: number }> {
	const now = options.now ?? Date.now()
	const reader = options.db ?? (await getTenantDb(orgId))
	const program = await readProgramInTx(reader)
	if (!program || program.current.config.expiry.mode === 'never') {
		return { expiredPoints: 0, expiredMembers: 0, warned: 0 }
	}
	const config = program.current.config
	const candidates = await reader
		.select({
			member: {
				id: loyaltyMembers.id,
				createdAt: loyaltyMembers.createdAt,
				lastPurchaseAt: loyaltyMembers.lastPurchaseAt,
			},
			points: loyaltyBalances.points,
		})
		.from(loyaltyMembers)
		.innerJoin(loyaltyBalances, eq(loyaltyBalances.memberId, loyaltyMembers.id))
		.where(
			and(eq(loyaltyMembers.status, 'active'), gt(loyaltyBalances.points, 0)),
		)
		.limit(EXPIRY_TICK_BATCH_LIMIT)
		.all()

	let expiredPoints = 0
	let expiredMembers = 0
	const pendingNotices: LoyaltyNoticePayload[] = []

	for (const candidate of candidates) {
		const initialEval = await evaluateMemberExpiryInTx(reader, {
			member: candidate.member,
			balancePoints: candidate.points,
			config,
			now,
		})

		let afterEval = initialEval
		if (initialEval.expiredDue > 0) {
			const postedDelta = await withLoyaltyWrite(
				{ orgId, db: options.db, now },
				async (tx, ctx) => {
					const latestProgram = await readProgramInTx(tx)
					if (
						!latestProgram ||
						latestProgram.current.config.expiry.mode === 'never'
					) {
						return { delta: 0, evalResult: initialEval }
					}
					const memberRow = await tx
						.select()
						.from(loyaltyMembers)
						.where(eq(loyaltyMembers.id, candidate.member.id))
						.get()
					const balanceRow = await tx
						.select()
						.from(loyaltyBalances)
						.where(eq(loyaltyBalances.memberId, candidate.member.id))
						.get()
					if (!memberRow || memberRow.status !== 'active' || !balanceRow) {
						return { delta: 0, evalResult: initialEval }
					}
					const maxExpirable = Math.max(
						0,
						balanceRow.points - balanceRow.reserved,
					)
					if (maxExpirable === 0) {
						return { delta: 0, evalResult: initialEval }
					}
					const evalInTx = await evaluateMemberExpiryInTx(tx, {
						member: memberRow,
						balancePoints: balanceRow.points,
						config: latestProgram.current.config,
						now: ctx.now,
					})
					const toExpire = Math.min(evalInTx.expiredDue, maxExpirable)
					if (toExpire <= 0) {
						return { delta: 0, evalResult: evalInTx }
					}
					const dueLots = evalInTx.lots.filter((l) => l.expiresAt <= ctx.now)
					const maxDueAt = dueLots.reduce(
						(acc, lot) => Math.max(acc, lot.expiresAt),
						ctx.now,
					)
					const batchKey = `${latestProgram.current.config.expiry.mode}:${maxDueAt}`
					const posted = await postLedgerEntryInTx(tx, {
						memberId: memberRow.id,
						type: 'expired',
						delta: -toExpire,
						eventKey: loyaltyEventKeys.expired(memberRow.id, batchKey),
						programVersion: latestProgram.current.version,
						note: latestProgram.current.config.expiry.mode,
						actorKind: 'system',
						at: ctx.now,
					})
					if (!posted.inserted) {
						return { delta: 0, evalResult: evalInTx }
					}
					await recordLoyaltyAudit(tx, {
						actorKind: 'system',
						action: 'points.expired',
						entityType: 'member',
						entityId: memberRow.id,
						changes: {
							points: toExpire,
							mode: latestProgram.current.config.expiry.mode,
						},
						at: ctx.now,
					})
					const updatedEval = await evaluateMemberExpiryInTx(tx, {
						member: memberRow,
						balancePoints: balanceRow.points - toExpire,
						config: latestProgram.current.config,
						now: ctx.now,
					})
					return { delta: toExpire, evalResult: updatedEval }
				},
			)
			if (postedDelta.delta > 0) {
				expiredPoints += postedDelta.delta
				expiredMembers += 1
			}
			afterEval = postedDelta.evalResult
		}

		if (afterEval.expiringWithin7d > 0 && afterEval.nextExpiryAt !== null) {
			pendingNotices.push({
				kind: 'expiry_7d',
				memberId: candidate.member.id,
				dedupeKey: `${config.expiry.mode}:${afterEval.nextExpiryAt}:7d`,
				programName: config.name,
				unitLabel: config.unitLabel,
				expiringPoints: afterEval.expiringWithin7d,
				expiresAt: afterEval.nextExpiryAt,
				now,
			})
		} else if (
			afterEval.expiringWithin30d > 0 &&
			afterEval.nextExpiryAt !== null
		) {
			pendingNotices.push({
				kind: 'expiry_30d',
				memberId: candidate.member.id,
				dedupeKey: `${config.expiry.mode}:${afterEval.nextExpiryAt}:30d`,
				programName: config.name,
				unitLabel: config.unitLabel,
				expiringPoints: afterEval.expiringWithin30d,
				expiresAt: afterEval.nextExpiryAt,
				now,
			})
		}
	}

	let warned = 0
	for (const notice of pendingNotices) {
		const delivery = await dispatchLoyaltyNotice(orgId, notice, {
			db: options.db,
		})
		if (delivery.sent) warned += 1
	}
	return { expiredPoints, expiredMembers, warned }
}

/**
 * Notifies existing members with a positive balance once when an operator turns
 * points expiry on, explaining the full grace period ahead of them.
 */
export async function notifyExpiryEnabledForOrg(
	orgId: string,
	options: { db?: TenantDatabase; now?: number } = {},
): Promise<number> {
	const now = options.now ?? Date.now()
	const reader = options.db ?? (await getTenantDb(orgId))
	const program = await readProgramInTx(reader)
	if (
		!program ||
		program.current.config.expiry.mode === 'never' ||
		!program.current.config.expiry.enabledAt
	) {
		return 0
	}
	const config = program.current.config
	const enabledAt = config.expiry.enabledAt!
	const expiresAt = addExpiryMonths(enabledAt, config.expiry.months)

	const rows = await reader
		.select({
			memberId: loyaltyMembers.id,
			points: loyaltyBalances.points,
		})
		.from(loyaltyMembers)
		.innerJoin(loyaltyBalances, eq(loyaltyBalances.memberId, loyaltyMembers.id))
		.where(
			and(eq(loyaltyMembers.status, 'active'), gt(loyaltyBalances.points, 0)),
		)
		.limit(EXPIRY_ENABLE_NOTIFY_LIMIT)
		.all()

	let sent = 0
	for (const row of rows) {
		const delivery = await dispatchLoyaltyNotice(
			orgId,
			{
				kind: 'expiry_enabled',
				memberId: row.memberId,
				dedupeKey: `enabled:${enabledAt}:${config.expiry.mode}:${config.expiry.months}`,
				programName: config.name,
				unitLabel: config.unitLabel,
				expiringPoints: row.points,
				expiresAt,
				months: config.expiry.months,
				now,
			},
			{ db: options.db },
		)
		if (delivery.sent) sent += 1
	}
	return sent
}
