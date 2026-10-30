import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	loyaltyIdempotencyKeys,
	provisionTenantDb,
} from '@repo/tenant-db'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runExclusive } from '../services/order-service.ts'
import { activateProgram } from '../services/loyalty-test-fixture.ts'
import { OrgLockReentryError } from './concurrency.ts'
import {
	activeLoyaltyTx,
	hashLoyaltyRequest,
	withLoyaltyWrite,
} from './loyalty-write.ts'

/**
 * The loyalty write gate's lock hazards: re-entering the organization lock,
 * writes that outlive their transaction, the clock read before the lock, and
 * idempotency on a nested write.
 */

let ORG = ''
let counter = 0
let dir: string

beforeEach(async () => {
	ORG = `org_lty_write_${++counter}`
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lty-write-'))
	vi.stubEnv('TENANT_DB_DIR', dir)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	await provisionTenantDb(ORG)
	await activateProgram(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(dir, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

function withinMs<T>(promise: Promise<T>, ms: number) {
	return Promise.race([
		promise.then(
			(value) => ({ settled: 'resolved' as const, value }),
			(error: unknown) => ({ settled: 'rejected' as const, error }),
		),
		new Promise<{ settled: 'hung' }>((resolve) =>
			setTimeout(() => resolve({ settled: 'hung' }), ms),
		),
	])
}

describe('withLoyaltyWrite lock hazards', () => {
	it('a loyalty write inside an order-lock callback fails fast instead of deadlocking', async () => {
		const outcome = await withinMs(
			runExclusive(ORG, () =>
				withLoyaltyWrite({ orgId: ORG }, async () => 'done'),
			),
			1000,
		)
		expect(outcome.settled).toBe('rejected')
		expect((outcome as { error: unknown }).error).toBeInstanceOf(
			OrgLockReentryError,
		)
		// The lock is free again afterwards.
		await expect(
			withLoyaltyWrite({ orgId: ORG }, async () => 'after'),
		).resolves.toBe('after')
	})

	it('a write started inside a loyalty callback but run after commit takes the full path', async () => {
		let outerTx: unknown = null
		let lateTx: unknown = null
		let late: Promise<unknown> = Promise.resolve()
		await withLoyaltyWrite({ orgId: ORG }, async (tx) => {
			outerTx = tx
			late = new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
				withLoyaltyWrite({ orgId: ORG }, async (tx) => {
					lateTx = tx
					expect(activeLoyaltyTx(ORG)).toBe(tx)
					await tx.run(sql`SELECT 1`)
					return 'ok'
				}),
			)
		})
		await expect(late).resolves.toBe('ok')
		expect(lateTx).not.toBeNull()
		expect(lateTx).not.toBe(outerTx)
	})

	it('a nested call inside the running transaction still joins it', async () => {
		await withLoyaltyWrite({ orgId: ORG }, async (outer) => {
			const inner = await withLoyaltyWrite({ orgId: ORG }, async (tx) => tx)
			expect(inner).toBe(outer)
		})
	})

	it('ctx.now is taken when the lock is acquired, not before', async () => {
		let releasedAt = 0
		const first = withLoyaltyWrite({ orgId: ORG }, async () => {
			await new Promise((resolve) => setTimeout(resolve, 200))
			releasedAt = Date.now()
		})
		const second = withLoyaltyWrite({ orgId: ORG }, async (_tx, ctx) => ctx.now)
		await first
		const secondNow = await second
		expect(secondNow).toBeGreaterThanOrEqual(releasedAt - 5)
	})

	it('an explicit now is still honoured', async () => {
		const now = Date.UTC(2026, 0, 10, 12)
		await expect(
			withLoyaltyWrite({ orgId: ORG, now }, async (_tx, ctx) => ctx.now),
		).resolves.toBe(now)
	})

	it('refuses an idempotency record on a nested write and stores nothing', async () => {
		const idempotency = {
			scope: 'test:nested',
			key: 'nested-key-1',
			requestHash: hashLoyaltyRequest({ a: 1 }),
		}
		await expect(
			withLoyaltyWrite({ orgId: ORG }, async () =>
				withLoyaltyWrite({ orgId: ORG, idempotency }, async () => 'inner'),
			),
		).rejects.toThrow(/idempotency/i)
		const db = await (await import('@repo/tenant-db')).getTenantDb(ORG)
		expect(await db.select().from(loyaltyIdempotencyKeys).all()).toEqual([])
	})
})
