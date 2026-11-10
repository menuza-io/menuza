import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	invAuditLog,
	invIdempotencyKeys,
	invItems,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runExclusive } from '../services/order-service.ts'
import { OrgLockReentryError } from './concurrency.ts'
import { InventoryError } from './inventory-http.ts'
import {
	activeInventoryTx,
	hashInventoryRequest,
	mapInventoryDbError,
	withInventoryWrite,
} from './inventory-write.ts'

let ORG = ''
let counter = 0
let dir: string

beforeEach(async () => {
	ORG = `org_inv_write_${++counter}`
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-write-'))
	vi.stubEnv('TENANT_DB_DIR', dir)
	vi.stubEnv('DATA_REGION', 'us')
	await provisionTenantDb(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => {})
	fs.rmSync(dir, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

const audit = (id: string, at: number) => ({
	id,
	actorKind: 'operator' as const,
	action: 'test',
	resourceType: 'test',
	resourceId: id,
	createdAt: at,
})

describe('withInventoryWrite', () => {
	it('commits one transaction and runs after-commit hooks once it has', async () => {
		const seen: string[] = []
		const result = await withInventoryWrite(
			{ orgId: ORG, now: 1234 },
			async (tx, ctx) => {
				await tx.insert(invAuditLog).values(audit('a1', ctx.now))
				ctx.afterCommit(() => {
					seen.push('after')
				})
				seen.push('inside')
				return 'ok'
			},
		)
		expect(result).toBe('ok')
		expect(seen).toEqual(['inside', 'after'])
		const db = await getTenantDb(ORG)
		expect(await db.select().from(invAuditLog)).toHaveLength(1)
	})

	it('rolls back everything when the callback throws, and runs no hook', async () => {
		const hook = vi.fn()
		await expect(
			withInventoryWrite({ orgId: ORG }, async (tx, ctx) => {
				await tx.insert(invAuditLog).values(audit('a1', 1))
				ctx.afterCommit(hook)
				throw new InventoryError('not_found', 404)
			}),
		).rejects.toMatchObject({ code: 'not_found' })
		expect(hook).not.toHaveBeenCalled()
		const db = await getTenantDb(ORG)
		expect(await db.select().from(invAuditLog)).toHaveLength(0)
	})

	it('a nested write for the same organization joins the open transaction instead of waiting on the lock', async () => {
		await withInventoryWrite({ orgId: ORG }, async (outer) => {
			expect(activeInventoryTx(ORG)).toBe(outer)
			const inner = await withInventoryWrite({ orgId: ORG }, async (tx) => tx)
			expect(inner).toBe(outer)
			await expect(
				withInventoryWrite(
					{
						orgId: ORG,
						idempotency: { scope: 's', key: 'k', requestHash: 'h' },
					},
					async () => null,
				),
			).rejects.toThrow('idempotency is not allowed on a nested write')
		})
		expect(activeInventoryTx(ORG)).toBeNull()
	})

	it('called inside another holder of the organization lock, it fails fast (the lock is not re-entrant)', async () => {
		await expect(
			runExclusive(ORG, () =>
				withInventoryWrite({ orgId: ORG }, async () => 'never'),
			),
		).rejects.toBeInstanceOf(OrgLockReentryError)
		await expect(
			withInventoryWrite({ orgId: ORG }, async () => 'after'),
		).resolves.toBe('after')
	})

	it('replays an idempotent write without running it again, and refuses the key for another request', async () => {
		const idempotency = {
			scope: 'test:create',
			key: 'key-0001',
			requestHash: hashInventoryRequest({ a: 1 }),
		}
		let runs = 0
		const write = () =>
			withInventoryWrite({ orgId: ORG, idempotency }, async (tx, ctx) => {
				runs += 1
				await tx.insert(invAuditLog).values(audit(`a${runs}`, ctx.now))
				return { runs }
			})
		expect(await write()).toEqual({ runs: 1 })
		expect(await write()).toEqual({ runs: 1 })
		expect(runs).toBe(1)
		const db = await getTenantDb(ORG)
		const record = await db
			.select()
			.from(invIdempotencyKeys)
			.where(eq(invIdempotencyKeys.key, 'key-0001'))
			.get()
		expect(record?.expiresAt).toBeGreaterThan(Date.now())

		await expect(
			withInventoryWrite(
				{
					orgId: ORG,
					idempotency: {
						...idempotency,
						requestHash: hashInventoryRequest({ a: 2 }),
					},
				},
				async () => 'other',
			),
		).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 })
	})

	it('turns constraint and trigger failures into inventory codes without the driver message', async () => {
		await withInventoryWrite({ orgId: ORG }, async (tx) => {
			await tx
				.insert(invItems)
				.values({ id: 'i1', name: 'Rice', baseUnit: 'g' })
		})
		const error = await withInventoryWrite({ orgId: ORG }, async (tx) => {
			await tx
				.insert(invItems)
				.values({ id: 'i2', name: 'RICE', baseUnit: 'g' })
		}).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(InventoryError)
		expect(error).toMatchObject({ code: 'name_taken', status: 409 })
		expect(String((error as Error).message)).not.toContain('RICE')

		expect(
			mapInventoryDbError(
				new Error('SQLITE_CONSTRAINT: inventory count is closed'),
			),
		).toMatchObject({ code: 'count_closed' })
		expect(
			mapInventoryDbError(new Error('x', { cause: 'inventory unit in use' })),
		).toMatchObject({ code: 'unit_in_use' })
		const other = new Error('disk I/O error')
		expect(mapInventoryDbError(other)).toBe(other)
	})
})
