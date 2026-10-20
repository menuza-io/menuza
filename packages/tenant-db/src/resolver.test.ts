import { afterEach, describe, expect, it } from 'vitest'
import {
	registerTenantDb,
	registerTenantDbTransactionRunner,
	resolveTenantDb,
	runTenantTransaction,
	setTenantDbResolver,
	unregisterTenantDb,
} from './resolver.ts'
import { type TenantDatabase, type TenantTransaction } from './types.ts'

const dbA = { name: 'a' } as unknown as TenantDatabase
const dbB = { name: 'b' } as unknown as TenantDatabase
const never = async () => {
	throw new Error('fallback must not run')
}

describe('tenant DB registry', () => {
	afterEach(() => {
		unregisterTenantDb('org_a')
		unregisterTenantDb('org_b')
		setTenantDbResolver(null)
	})

	it('serves each org its own handle at the same time', async () => {
		registerTenantDb('org_a', dbA)
		registerTenantDb('org_b', dbB)
		expect(await resolveTenantDb('org_a', {}, never)).toBe(dbA)
		expect(await resolveTenantDb('org_b', {}, never)).toBe(dbB)
	})

	it('keeps a handle after the request-scoped resolver is cleared', async () => {
		registerTenantDb('org_a', dbA)
		setTenantDbResolver(async () => dbB)
		setTenantDbResolver(null)
		expect(await resolveTenantDb('org_a', {}, never)).toBe(dbA)
	})

	it('only unregisters the handle it owns', async () => {
		registerTenantDb('org_a', dbA)
		unregisterTenantDb('org_a', dbB)
		expect(await resolveTenantDb('org_a', {}, never)).toBe(dbA)
		unregisterTenantDb('org_a', dbA)
		expect(await resolveTenantDb('org_a', {}, async () => dbB)).toBe(dbB)
	})
})

/**
 * A fake handle that mirrors drizzle's durable-sqlite driver: `transaction`
 * is `transactionSync`, so the savepoint closes as soon as the callback
 * returns its promise, and only writes made before the first `await` are
 * inside it. Writes after that go straight to the committed rows.
 */
function createSyncSavepointDb() {
	const state = { rows: [] as string[] }
	const handle = {
		insert(row: string) {
			state.rows.push(row)
		},
		transaction<T>(fn: (tx: unknown) => T): T {
			const snapshot = [...state.rows]
			try {
				return fn(handle)
			} catch (error) {
				state.rows = snapshot
				throw error
			}
		},
	}
	return { state, handle }
}

/** Mirrors `ctx.storage.transaction`: awaits the callback, rolls back on throw. */
function asyncStorageTransaction<T>(
	state: { rows: string[] },
	fn: () => Promise<T>,
): Promise<T> {
	const snapshot = [...state.rows]
	return fn().catch((error: unknown) => {
		state.rows = snapshot
		throw error
	})
}

describe('runTenantTransaction', () => {
	async function failAfterAwait(db: ReturnType<typeof createSyncSavepointDb>) {
		await runTenantTransaction(
			db.handle as unknown as TenantDatabase,
			async (tx) => {
				const h = tx as unknown as typeof db.handle
				h.insert('before-await')
				await Promise.resolve()
				h.insert('after-await')
				throw new Error('boom')
			},
		).catch(() => undefined)
	}

	it('falls back to the driver transaction without a registered runner', async () => {
		const db = createSyncSavepointDb()
		await failAfterAwait(db)
		// The sync savepoint cannot see past the await: this is the bug a
		// registered runner exists to fix.
		expect(db.state.rows).toEqual(['before-await', 'after-await'])
	})

	it('rolls back writes made before and after an await when a runner is registered', async () => {
		const db = createSyncSavepointDb()
		registerTenantDbTransactionRunner(db.handle, (fn) =>
			asyncStorageTransaction(db.state, fn),
		)
		await failAfterAwait(db)
		expect(db.state.rows).toEqual([])
	})

	it('commits and returns the callback result when nothing throws', async () => {
		const db = createSyncSavepointDb()
		registerTenantDbTransactionRunner(db.handle, (fn) =>
			asyncStorageTransaction(db.state, fn),
		)
		const result = await runTenantTransaction(
			db.handle as unknown as TenantDatabase,
			async (tx: TenantTransaction) => {
				;(tx as unknown as typeof db.handle).insert('a')
				await Promise.resolve()
				return 'done'
			},
		)
		expect(result).toBe('done')
		expect(db.state.rows).toEqual(['a'])
	})
})
