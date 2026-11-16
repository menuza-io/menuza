import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { GiftCardDomainError } from '@repo/common/gift-cards'
import {
	getTenantDb,
	giftCardIdempotencyKeys,
	runTenantTransaction,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { runExclusive } from '../services/order-service.ts'
import { openGiftCardCode, sealGiftCardCode } from './gift-card-secret.ts'
import { HttpError } from './http.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

/**
 * The write gate for gift cards, modelled on `withLoyaltyWrite`. Every card
 * mutation runs here:
 *
 * 1. the organization's in-process lock, shared with restaurant orders, QR
 *    tabs and loyalty, so a payment event and the card work it triggers never
 *    interleave inside one Durable Object transaction;
 * 2. `retryOnSqliteBusy` around
 * 3. one real transaction, with the durable idempotency record checked first
 *    and written last.
 *
 * The balance can never go below zero even if this gate were bypassed: a
 * trigger on `gift_card_ledger` refuses an entry that would. Code that
 * already runs inside an order, till or payment transaction uses the `...InTx`
 * functions with that transaction and must never call this gate (the lock is
 * not re-entrant across modules).
 */

export type GiftCardTx = TenantTransaction
export type GiftCardReader = TenantDatabase | TenantTransaction

export const GIFT_CARD_IDEMPOTENCY_TTL_MS = 48 * 60 * 60_000

export type GiftCardWriteContext = {
	orgId: string
	now: number
	/** Runs after the transaction commits; never for an idempotent replay. */
	afterCommit: (hook: () => void | Promise<void>) => void
	/** Names the card the write is about, so erasure deletes the stored response. */
	linkCard: (cardId: string) => void
}

export type GiftCardIdempotency = {
	scope: string
	key: string
	requestHash: string
}

type ActiveWrite = {
	orgId: string
	tx: GiftCardTx
	ctx: GiftCardWriteContext
	done: boolean
}

const activeWrite = new AsyncLocalStorage<ActiveWrite>()

/**
 * A result's secret fields, sealed for the stored idempotent response. A card
 * code must never sit in the database in plaintext (only its HMAC does), yet a
 * retry after a lost answer has to get the same code back, so the stored copy
 * holds it sealed and a replay opens it.
 */
function sealResultFields(
	value: unknown,
	fields: readonly string[] | undefined,
): unknown {
	if (!fields?.length || value === null || typeof value !== 'object') {
		return value ?? null
	}
	const copy: Record<string, unknown> = {
		...(value as Record<string, unknown>),
	}
	for (const field of fields) {
		const secret = copy[field]
		if (typeof secret === 'string' && secret !== '') {
			copy[field] = sealGiftCardCode(secret)
		}
	}
	return copy
}

/**
 * The replayed result with its sealed fields opened. A value that cannot be
 * read (corrupt) comes back as null; a missing or changed key throws, so a
 * configuration problem is never mistaken for bad data.
 */
function openResultFields<T>(
	stored: T,
	fields: readonly string[] | undefined,
): T {
	if (!fields?.length || stored === null || typeof stored !== 'object') {
		return stored
	}
	const copy: Record<string, unknown> = {
		...(stored as Record<string, unknown>),
	}
	for (const field of fields) {
		const sealed = copy[field]
		if (typeof sealed === 'string' && sealed !== '') {
			copy[field] = openGiftCardCode(sealed)
		}
	}
	return copy as T
}

export function hashGiftCardRequest(payload: unknown): string {
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
	readonly [string, GiftCardDomainError['code']]
> = [
	['gift card balance would go negative', 'gift_card_balance_low'],
	['gift card is not active', 'gift_card_not_active'],
	['gift card refund exceeds charge', 'gift_card_refund_exceeds_charge'],
	['gift_cards.code_hash', 'idempotency_conflict'],
	['gift_card_ledger.idempotency_key', 'idempotency_conflict'],
]

/**
 * Turns a constraint or trigger failure into a gift-card error code. Never
 * forwards the driver message: drizzle puts the failing statement and its
 * bound parameters into it.
 */
export function mapGiftCardDbError(error: unknown): unknown {
	if (error instanceof GiftCardDomainError || error instanceof HttpError) {
		return error
	}
	const text = errorText(error)
	for (const [needle, code] of CONSTRAINT_CODES) {
		if (text.includes(needle)) return new GiftCardDomainError(code)
	}
	return error
}

/** The transaction of the gift-card write running for `orgId`, if any. */
export function activeGiftCardTx(orgId: string): GiftCardTx | null {
	const active = activeWrite.getStore()
	return active && active.orgId === orgId && !active.done ? active.tx : null
}

export async function withGiftCardWrite<T>(
	options: {
		orgId: string
		db?: TenantDatabase
		now?: number
		idempotency?: GiftCardIdempotency
		/**
		 * Top-level string fields of the result that are secrets (a card code).
		 * They are stored sealed in the idempotent response, never in plaintext.
		 */
		sealFields?: readonly string[]
	},
	fn: (tx: GiftCardTx, ctx: GiftCardWriteContext) => Promise<T>,
): Promise<T> {
	const { orgId } = options
	const active = activeWrite.getStore()
	if (active && active.orgId === orgId && !active.done) {
		if (options.idempotency) {
			throw new Error(
				'withGiftCardWrite: idempotency is not allowed on a nested write',
			)
		}
		return fn(active.tx, active.ctx)
	}
	const idempotency = options.idempotency
	let committedHooks: Array<() => void | Promise<void>> = []

	const outcome = await runExclusive(orgId, async () => {
		const now = options.now ?? Date.now()
		const db = options.db ?? (await getTenantDb(orgId))
		return retryOnSqliteBusy(async () => {
			const hooks: Array<() => void | Promise<void>> = []
			let linkedCardId: string | null = null
			let entry: ActiveWrite | null = null
			try {
				const result = await runTenantTransaction(db, async (tx) => {
					if (idempotency) {
						const existing = await tx
							.select()
							.from(giftCardIdempotencyKeys)
							.where(
								and(
									eq(giftCardIdempotencyKeys.scope, idempotency.scope),
									eq(giftCardIdempotencyKeys.key, idempotency.key),
								),
							)
							.get()
						if (existing && existing.expiresAt > now) {
							if (existing.requestHash !== idempotency.requestHash) {
								throw new GiftCardDomainError('idempotency_conflict')
							}
							return {
								replayed: true as const,
								value: openResultFields(
									JSON.parse(existing.responseJson) as T,
									options.sealFields,
								),
							}
						}
					}
					const ctx: GiftCardWriteContext = {
						orgId,
						now,
						afterCommit: (hook) => {
							hooks.push(hook)
						},
						linkCard: (cardId) => {
							linkedCardId = cardId
						},
					}
					entry = { orgId, tx, ctx, done: false }
					const value = await activeWrite.run(entry, () => fn(tx, ctx))
					if (idempotency) {
						const record = {
							requestHash: idempotency.requestHash,
							statusCode: 200,
							responseJson: JSON.stringify(
								sealResultFields(value, options.sealFields) ?? null,
							),
							cardId: linkedCardId,
							createdAt: now,
							expiresAt: now + GIFT_CARD_IDEMPOTENCY_TTL_MS,
						}
						await tx
							.insert(giftCardIdempotencyKeys)
							.values({
								scope: idempotency.scope,
								key: idempotency.key,
								...record,
							})
							.onConflictDoUpdate({
								target: [
									giftCardIdempotencyKeys.scope,
									giftCardIdempotencyKeys.key,
								],
								set: record,
							})
					}
					return { replayed: false as const, value }
				})
				committedHooks = hooks
				return result
			} catch (error) {
				throw mapGiftCardDbError(error)
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
					'Gift card after-commit hook failed',
					error instanceof Error ? error.name : 'unknown',
				)
			}
		}
	}
	return outcome.value
}
