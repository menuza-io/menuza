import type { TenantDatabase } from './types.ts'

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
