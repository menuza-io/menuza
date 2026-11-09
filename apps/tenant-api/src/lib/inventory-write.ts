import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { type InventoryErrorCode } from '@repo/inventory'
import {
	getTenantDb,
	invIdempotencyKeys,
	runTenantTransaction,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { runExclusive } from '../services/order-service.ts'
import { HttpError } from './http.ts'
import { InventoryError } from './inventory-http.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

/**
 * The write gate for inventory. Every inventory mutation runs here:
 *
 * 1. the organization's in-process lock (`runExclusive`), shared with
 *    restaurant orders, QR tabs and loyalty, so a sale and the stock work it
 *    triggers never interleave inside one Durable Object transaction;
 * 2. `retryOnSqliteBusy` around
 * 3. one real transaction (`runTenantTransaction`), with the durable
 *    idempotency record checked first and written last.
 *
 * The lock is NOT re-entrant. A nested `withInventoryWrite` for the same
 * organization inside a running one joins its transaction (tracked with
 * AsyncLocalStorage) instead of taking the lock again. Code that already runs
 * inside an order, tab, till or loyalty transaction (phase 3's sale queue)
 * must use that transaction directly and never call this gate, or it waits
 * on itself.
 */

export type InventoryTx = TenantTransaction
export type InventoryReader = TenantDatabase | TenantTransaction

export const INVENTORY_IDEMPOTENCY_TTL_MS = 48 * 60 * 60_000

export type InventoryWriteContext = {
	orgId: string
	now: number
	/** Runs after the transaction commits; never for an idempotent replay. */
	afterCommit: (hook: () => void | Promise<void>) => void
}

export type InventoryIdempotency = {
	scope: string
	key: string
	requestHash: string
}

type ActiveWrite = {
	orgId: string
	tx: InventoryTx
	ctx: InventoryWriteContext
	/** Set once the transaction has finished (see loyalty-write.ts). */
	done: boolean
}

const activeWrite = new AsyncLocalStorage<ActiveWrite>()

export function hashInventoryRequest(payload: unknown): string {
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

const CONSTRAINT_CODES: ReadonlyArray<
	readonly [string, InventoryErrorCode, number]
> = [
	['inventory count is closed', 'count_closed', 409],
	['inventory unit in use', 'unit_in_use', 409],
	['inventory item unit is fixed', 'unit_in_use', 409],
	['_active_name', 'name_taken', 409],
	['inventory waste reversal does not match', 'invalid_request', 400],
	['uniq_inv_waste_reverses', 'invalid_request', 400],
	// Phase 2 (tenant migration 0034): a trigger that fired means a state the
	// service should have refused first; these keep a race from leaking a 500.
	['inventory order is closed', 'order_closed', 409],
	['inventory order lines are frozen', 'order_not_editable', 409],
	['inventory order cannot go back', 'order_closed', 409],
	['uniq_inv_orders_client', 'idempotency_conflict', 409],
	// Phase 3 (tenant migration 0035): the service refuses these first; the
	// mapping keeps a race from leaking a 500.
	['only a made item can be counted in batches', 'not_a_made_item', 400],
	['a made item recipe needs a made item', 'not_a_made_item', 400],
	['a made item cannot be its own ingredient', 'recipe_cycle', 409],
	['inventory recipe versions only move forward', 'stale_version', 409],
	['uniq_inv_recipes_current', 'stale_version', 409],
	['uniq_inv_recipes_owner_version', 'stale_version', 409],
]

/**
 * Turns a constraint or trigger failure into an inventory error code. Never
 * forwards the driver message: drizzle puts the failing statement and its
 * bound parameters into it.
 */
export function mapInventoryDbError(error: unknown): unknown {
	if (error instanceof InventoryError || error instanceof HttpError) {
		return error
	}
	const text = errorText(error)
	for (const [needle, code, status] of CONSTRAINT_CODES) {
		if (text.includes(needle)) return new InventoryError(code, status)
	}
	return error
}

/** The transaction of the inventory write running for `orgId`, if any. */
export function activeInventoryTx(orgId: string): InventoryTx | null {
	const active = activeWrite.getStore()
	return active && active.orgId === orgId && !active.done ? active.tx : null
}

export async function withInventoryWrite<T>(
	options: {
		orgId: string
		db?: TenantDatabase
		now?: number
		idempotency?: InventoryIdempotency | null
		/** Called when `idempotency` found an earlier result and `fn` did not run. */
		onReplay?: () => void
	},
	fn: (tx: InventoryTx, ctx: InventoryWriteContext) => Promise<T>,
): Promise<T> {
	const { orgId } = options
	const active = activeWrite.getStore()
	if (active && active.orgId === orgId && !active.done) {
		// The outer write owns the transaction and its idempotency record.
		if (options.idempotency) {
			throw new Error(
				'withInventoryWrite: idempotency is not allowed on a nested write',
			)
		}
		return fn(active.tx, active.ctx)
	}
	const idempotency = options.idempotency ?? null
	// Per-attempt state: a SQLITE_BUSY retry re-runs the whole closure.
	let committedHooks: Array<() => void | Promise<void>> = []

	const outcome = await runExclusive(orgId, async () => {
		// Read the clock once the lock is held: a write that queued behind
		// another must not act on the time it started waiting.
		const now = options.now ?? Date.now()
		const db = options.db ?? (await getTenantDb(orgId))
		return retryOnSqliteBusy(async () => {
			const hooks: Array<() => void | Promise<void>> = []
			let entry: ActiveWrite | null = null
			try {
				const result = await runTenantTransaction(db, async (tx) => {
					if (idempotency) {
						const existing = await tx
							.select()
							.from(invIdempotencyKeys)
							.where(
								and(
									eq(invIdempotencyKeys.scope, idempotency.scope),
									eq(invIdempotencyKeys.key, idempotency.key),
								),
							)
							.get()
						if (existing && existing.expiresAt > now) {
							if (existing.requestHash !== idempotency.requestHash) {
								throw new InventoryError('idempotency_conflict', 409)
							}
							return {
								replayed: true as const,
								value: JSON.parse(existing.responseJson) as T,
							}
						}
					}
					const ctx: InventoryWriteContext = {
						orgId,
						now,
						afterCommit: (hook) => {
							hooks.push(hook)
						},
					}
					entry = { orgId, tx, ctx, done: false }
					const value = await activeWrite.run(entry, () => fn(tx, ctx))
					if (idempotency) {
						const record = {
							requestHash: idempotency.requestHash,
							statusCode: 200,
							responseJson: JSON.stringify(value ?? null),
							createdAt: now,
							expiresAt: now + INVENTORY_IDEMPOTENCY_TTL_MS,
						}
						await tx
							.insert(invIdempotencyKeys)
							.values({
								scope: idempotency.scope,
								key: idempotency.key,
								...record,
							})
							.onConflictDoUpdate({
								target: [invIdempotencyKeys.scope, invIdempotencyKeys.key],
								set: record,
							})
					}
					return { replayed: false as const, value }
				})
				committedHooks = hooks
				return result
			} catch (error) {
				throw mapInventoryDbError(error)
			} finally {
				if (entry) (entry as ActiveWrite).done = true
			}
		})
	})

	if (outcome.replayed) options.onReplay?.()
	if (!outcome.replayed) {
		for (const hook of committedHooks) {
			try {
				await hook()
			} catch (error) {
				console.error(
					'Inventory after-commit hook failed',
					error instanceof Error ? error.name : 'unknown',
				)
			}
		}
	}
	return outcome.value
}
