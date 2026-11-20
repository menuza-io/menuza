import { SERVING_DOMAIN_STATUSES } from '@repo/common/domains'
import {
	and,
	db,
	eq,
	inArray,
	or,
	Organization,
	SiteDomain,
	sql,
} from '@repo/database'

/**
 * The one way a public site endpoint finds an organization by host (#139).
 * A host matches when it is the primary (`Organization.customDomain`, kept for
 * one release) or any SiteDomain of the organization, primary or redirecting,
 * that is active or pending. A secondary host answers with the organization so
 * Sites can redirect it to `customDomain`; the data is the same.
 */
export function siteHostCondition(host: string) {
	const normalized = host.trim().toLowerCase().split(':')[0] ?? ''
	return or(
		and(
			eq(Organization.customDomain, normalized),
			inArray(Organization.customDomainStatus, [...SERVING_DOMAIN_STATUSES]),
		),
		// Raw names for SiteDomain: the relational query builder (`db.query`) rewrites
		// every interpolated column to its own table alias, which would break this.
		sql`exists (select 1 from "SiteDomain" as "sd" where "sd"."organizationId" = ${Organization.id} and "sd"."hostname" = ${normalized} and "sd"."status" in ('active', 'pending'))`,
	)!
}

/** The organization a host belongs to (any status but expired), for ownership checks. */
export async function findHostOwner(hostname: string) {
	const [row] = await db
		.select({
			organizationId: SiteDomain.organizationId,
			status: SiteDomain.status,
			isPrimary: SiteDomain.isPrimary,
		})
		.from(SiteDomain)
		.where(eq(SiteDomain.hostname, hostname.toLowerCase()))
		.limit(1)
	if (row && row.status !== 'expired') return row
	// Not yet copied into SiteDomain (before the backfill reached it).
	const [legacy] = await db
		.select({ organizationId: Organization.id })
		.from(Organization)
		.where(
			and(
				eq(Organization.customDomain, hostname.toLowerCase()),
				// An expired host no longer holds the name.
				sql`coalesce(${Organization.customDomainStatus}, '') <> 'expired'`,
			),
		)
		.limit(1)
	return legacy
		? {
				organizationId: legacy.organizationId,
				status: 'pending',
				isPrimary: true,
			}
		: null
}
