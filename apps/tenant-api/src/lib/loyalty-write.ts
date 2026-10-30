import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { LoyaltyDomainError, type LoyaltyErrorCode } from '@repo/loyalty'
import {
	getTenantDb,
	loyaltyIdempotencyKeys,
	runTenantTransaction,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { runExclusive } from '../services/order-service.ts'
import { HttpError } from './http.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

/**
 * The write gate for loyalty. Every loyalty mutation runs here:
 *
 * 1. the organization's in-process lock, shared with restaurant orders and QR
 *    tabs so a payment event and the loyalty work it triggers never
 *    interleave inside one Durable Object transaction;
 * 2. `retryOnSqliteBusy` around
 * 3. one real transaction (`runTenantTransaction`), with the durable
 *    idempotency record checked first and written last.
 *
 * Code that already runs inside an order, tab or till transaction calls the
 * `...InTx` functions with that transaction instead, and must never call this
 * gate (the lock is not re-entrant across modules).
 */

export type LoyaltyTx = TenantTransaction
export type LoyaltyReader = TenantDatabase | TenantTransaction

export const LOYALTY_IDEMPOTENCY_TTL_MS = 48 * 60 * 60_000

export type LoyaltyWriteContext = {
	orgId: string
	now: number
	/** Runs after the transaction commits; never for an idempotent replay. */
	afterCommit: (hook: () => void | Promise<void>) => void
	/**
	 * Names the member this write is about, so erasing that member also deletes
	 * the stored idempotent response (it can carry their name, phone digits or
	 * an operator note).
	 */
	linkMember: (memberId: string) => void
}

export type LoyaltyIdempotency = {
	scope: string
	key: string
	requestHash: string
}

type ActiveWrite = {
	orgId: string
	tx: LoyaltyTx
	ctx: LoyaltyWriteContext
	/**
	 * Set once the transaction has finished. Work started inside the callback
	 * that outlives it (a background promise) still sees this entry, and must
	 * take the full path instead of joining a transaction that is gone.
	 */
	done: boolean
}

const activeWrite = new AsyncLocalStorage<ActiveWrite>()

export function hashLoyaltyRequest(payload: unknown): string {
	const normalized =
		typeof payload === 'string' ? payload : JSON.stringify(payload ?? null)
	return createHash('sha256').update(normalized).digest('hex')
}

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	const cause =
		error instanceof Error
			? String((error as { cause?: unknown }).cause ?? '')
			: ''
	return `${message} ${cause}`
}

const CONSTRAINT_CODES: ReadonlyArray<readonly [string, LoyaltyErrorCode]> = [
	[
		'loyalty_redemptions.source_type, loyalty_redemptions.source_id',
		'one_reward_per_order',
	],
	['loyalty_redemptions.approval_id', 'approval_closed'],
	['loyalty_approvals.sale_id', 'approval_closed'],
	['loyalty_redemptions transition not allowed', 'invalid_transition'],
	['loyalty_redemptions facts are fixed', 'invalid_transition'],
	['chk_loyalty_balances_reserved', 'invalid_transition'],
	['loyalty member is erased', 'member_not_found'],
	['loyalty program currency is locked', 'config_invalid'],
	['loyalty member code already used', 'code_invalid'],
]

/**
 * Turns a constraint or trigger failure into a loyalty error code. Never
 * forwards the driver message: drizzle puts the failing statement and its
 * bound parameters into it.
 */
export function mapLoyaltyDbError(error: unknown): unknown {
	if (error instanceof LoyaltyDomainError || error instanceof HttpError) {
		return error
	}
	const text = errorText(error)
	for (const [needle, code] of CONSTRAINT_CODES) {
		if (text.includes(needle)) return new LoyaltyDomainError(code)
	}
	return error
}

/** The transaction of the loyalty write running for `orgId`, if any. */
export function activeLoyaltyTx(orgId: string): LoyaltyTx | null {
	const active = activeWrite.getStore()
	return active && active.orgId === orgId && !active.done ? active.tx : null
}

export async function withLoyaltyWrite<T>(
	options: {
		orgId: string
		db?: TenantDatabase
		now?: number
		idempotency?: LoyaltyIdempotency
	},
	fn: (tx: LoyaltyTx, ctx: LoyaltyWriteContext) => Promise<T>,
): Promise<T> {
	const { orgId } = options
	const active = activeWrite.getStore()
	if (active && active.orgId === orgId && !active.done) {
		// The outer write owns the transaction and its idempotency record; a
		// nested record would be written inside it and replay the inner result
		// on its own, so refuse it rather than silently ignore it.
		if (options.idempotency) {
			throw new Error(
				'withLoyaltyWrite: idempotency is not allowed on a nested write',
			)
		}
		return fn(active.tx, active.ctx)
	}
	const idempotency = options.idempotency
	// Per-attempt state: a SQLITE_BUSY retry re-runs the whole closure.
	let committedHooks: Array<() => void | Promise<void>> = []

	const outcome = await runExclusive(orgId, async () => {
		// Read the clock once the lock is held: a write that queued behind
		// another must not act on the time it started waiting.
		const now = options.now ?? Date.now()
		const db = options.db ?? (await getTenantDb(orgId))
		return retryOnSqliteBusy(async () => {
			const hooks: Array<() => void | Promise<void>> = []
			let linkedMemberId: string | null = null
			let entry: ActiveWrite | null = null
			try {
				const result = await runTenantTransaction(db, async (tx) => {
					if (idempotency) {
						const existing = await tx
							.select()
							.from(loyaltyIdempotencyKeys)
							.where(
								and(
									eq(loyaltyIdempotencyKeys.scope, idempotency.scope),
									eq(loyaltyIdempotencyKeys.key, idempotency.key),
								),
							)
							.get()
						if (existing && existing.expiresAt > now) {
							if (existing.requestHash !== idempotency.requestHash) {
								throw new LoyaltyDomainError('idempotency_conflict')
							}
							return {
								replayed: true as const,
								value: JSON.parse(existing.responseJson) as T,
							}
						}
					}
					const ctx: LoyaltyWriteContext = {
						orgId,
						now,
						afterCommit: (hook) => {
							hooks.push(hook)
						},
						linkMember: (memberId) => {
							linkedMemberId = memberId
						},
					}
					entry = { orgId, tx, ctx, done: false }
					const value = await activeWrite.run(entry, () => fn(tx, ctx))
					if (idempotency) {
						const record = {
							requestHash: idempotency.requestHash,
							statusCode: 200,
							responseJson: JSON.stringify(value ?? null),
							memberId: linkedMemberId,
							createdAt: now,
							expiresAt: now + LOYALTY_IDEMPOTENCY_TTL_MS,
						}
						await tx
							.insert(loyaltyIdempotencyKeys)
							.values({
								scope: idempotency.scope,
								key: idempotency.key,
								...record,
							})
							.onConflictDoUpdate({
								target: [
									loyaltyIdempotencyKeys.scope,
									loyaltyIdempotencyKeys.key,
								],
								set: record,
							})
					}
					return { replayed: false as const, value }
				})
				committedHooks = hooks
				return result
			} catch (error) {
				throw mapLoyaltyDbError(error)
			} finally {
				if (entry) (entry as ActiveWrite).done = true
			}
		})
	})

	if (!outcome.replayed) {
		for (const hook of committedHooks) {
			try {
				await hook()
			} catch (error) {
				console.error(
					'Loyalty after-commit hook failed',
					error instanceof Error ? error.name : 'unknown',
				)
			}
		}
	}
	return outcome.value
}
