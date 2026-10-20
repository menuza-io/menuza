import type { TenantDatabase } from './types.ts'

type TenantDbResolver = (
	orgId: string,
	options?: { createIfMissing?: boolean },
) => Promise<TenantDatabase>

type ListTenantOrgIdsProvider = () => string[] | Promise<string[]>

const dbOrgIds = new WeakMap<object, string>()

/** Org id a handle returned by `resolveTenantDb` belongs to (usable as a lock key). */
export function getTenantDbOrgId(db: object): string | undefined {
	return dbOrgIds.get(db)
}

let tenantDbResolver: TenantDbResolver | null = null
let listTenantOrgIdsProvider: ListTenantOrgIdsProvider | null = null

/**
 * Handles registered per org. A Cloudflare isolate can host several `TenantOrg`
 * Durable Objects at once, and work queued after a response (message delivery,
 * journeys) outlives the request, so a single module-level resolver that is set
 * and cleared per request cannot serve them. A registered handle is looked up
 * by org id and stays valid until the owner unregisters it.
 */
const registeredTenantDbs = new Map<string, TenantDatabase>()

export function registerTenantDb(orgId: string, db: TenantDatabase) {
	registeredTenantDbs.set(orgId, db)
}

export function unregisterTenantDb(orgId: string, db?: TenantDatabase) {
	if (db && registeredTenantDbs.get(orgId) !== db) return
	registeredTenantDbs.delete(orgId)
}

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
	const db =
		registeredTenantDbs.get(orgId) ??
		(tenantDbResolver
			? await tenantDbResolver(orgId, options)
			: await fallback(orgId, options))
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
