import type { TenantDatabase, TenantTransaction } from './types.ts'

type TenantDbResolver = (
	orgId: string,
	options?: { createIfMissing?: boolean },
) => Promise<TenantDatabase>

type ListTenantOrgIdsProvider = () => string[] | Promise<string[]>

const dbOrgIds = new WeakMap<object, string>()

/** Org id a handle returned by `getTenantDb` belongs to (used as the write-lock key). */
export function getTenantDbOrgId(db: object): string | undefined {
	return dbOrgIds.get(db)
}

let tenantDbResolver: TenantDbResolver | null = null
let listTenantOrgIdsProvider: ListTenantOrgIdsProvider | null = null

export function setTenantDbResolver(resolver: TenantDbResolver | null) {
	tenantDbResolver = resolver
}

export function getTenantDbResolver() {
	return tenantDbResolver
}

export function setListTenantOrgIdsProvider(
	provider: ListTenantOrgIdsProvider | null,
) {
	listTenantOrgIdsProvider = provider
}

export async function resolveTenantDb(
	orgId: string,
	options: { createIfMissing?: boolean } = {},
	fallback: TenantDbResolver,
): Promise<TenantDatabase> {
	const db = tenantDbResolver
		? await tenantDbResolver(orgId, options)
		: await fallback(orgId, options)
	dbOrgIds.set(db, orgId)
	return db
}

export async function resolveTenantOrgIds(
	fallback: () => string[],
): Promise<string[]> {
	if (listTenantOrgIdsProvider) {
		return await listTenantOrgIdsProvider()
	}
	return fallback()
}

type AsyncTransactionRunner = <T>(fn: () => Promise<T>) => Promise<T>

const transactionRunners = new WeakMap<object, AsyncTransactionRunner>()

/**
 * Registers a runtime-specific async transaction for a database handle.
 *
 * Drizzle's Durable Object driver wraps `transaction()` in
 * `storage.transactionSync`, which does not await an async callback: only
 * code before the first `await` is inside the savepoint, and a later throw
 * does not roll anything back. The Durable Object registers
 * `ctx.storage.transaction` here (the async variant, which does roll back).
 * Statements issued on the handle inside `fn` are part of that transaction.
 */
export function registerTenantDbTransactionRunner(
	db: object,
	runner: AsyncTransactionRunner,
) {
	transactionRunners.set(db, runner)
}

/**
 * Runs `fn` in one real transaction on either runtime. libsql keeps the
 * driver's own `db.transaction`; a handle with a registered runner (Durable
 * Object SQLite) uses that runner and passes the handle itself as `tx`.
 */
export async function runTenantTransaction<T>(
	db: TenantDatabase,
	fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
	const runner = transactionRunners.get(db)
	if (!runner) return db.transaction(fn)
	return runner(() => fn(db as unknown as TenantTransaction))
}
