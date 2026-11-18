import { and, count, eq, sql } from 'drizzle-orm'
import { db } from './client.ts'
import {
	OrganizationLocationSettingPolicy,
	SSOConfiguration,
	SSOSession,
	User,
} from './schema.ts'

/** Lightweight connectivity probe used by Cloudflare HTTP healthchecks. */
export async function pingControlPlane() {
	await db.run(sql`SELECT 1`)
}

export async function countUsers() {
	const [row] = await db.select({ value: count() }).from(User)
	return row?.value ?? 0
}

export async function countSsoConfigurations(options?: { enabled?: boolean }) {
	const query = db.select({ value: count() }).from(SSOConfiguration)
	const [row] =
		options?.enabled === undefined
			? await query
			: await query.where(eq(SSOConfiguration.isEnabled, options.enabled))
	return row?.value ?? 0
}

export async function countSsoSessions() {
	const [row] = await db.select({ value: count() }).from(SSOSession)
	return row?.value ?? 0
}

/**
 * Registry setting ids head office has locked for an organization (#417). Writers
 * outside the App's location screens (integration imports) skip these so a lock
 * is not only a disabled field. Ids are those of `@repo/common`'s location
 * settings registry (`storeHours`, `onlineHours`, ...).
 */
export async function getLockedLocationSettingIds(
	organizationId: string,
): Promise<Set<string>> {
	const rows = await db
		.select({ settingId: OrganizationLocationSettingPolicy.settingId })
		.from(OrganizationLocationSettingPolicy)
		.where(
			and(
				eq(OrganizationLocationSettingPolicy.organizationId, organizationId),
				eq(OrganizationLocationSettingPolicy.locked, true),
			),
		)
	return new Set(rows.map((row) => row.settingId))
}
