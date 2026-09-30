import {
	Integration as IntegrationTable,
	Organization as OrganizationTable,
	OrganizationLocation,
	and,
	asc,
	db,
	desc,
	eq,
	isNull,
} from '@repo/database'
import { type Integration } from './database-types.ts'
import { isLocationScopedIntegration } from './integration-scope.ts'

export async function assertLocationInOrganization(
	organizationId: string,
	organizationLocationId: string,
): Promise<void> {
	const [row] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, organizationLocationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!row) {
		throw new Error('Location not found for this organization.')
	}
}

export async function getDefaultOrganizationLocationId(
	organizationId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.createdAt),
		)
		.limit(1)
	return row?.id ?? null
}

/**
 * Ensures the org has at least one location (used before onboarding POS / GBP).
 * Returns the default (or first) location id.
 */
export async function ensureDefaultOrganizationLocation(
	organizationId: string,
): Promise<string> {
	const existing = await getDefaultOrganizationLocationId(organizationId)
	if (existing) return existing

	const [org] = await db
		.select({ name: OrganizationTable.name })
		.from(OrganizationTable)
		.where(eq(OrganizationTable.id, organizationId))
		.limit(1)

	const [created] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name: org?.name?.trim() || 'Main location',
			slug: 'main',
			isDefault: true,
			isActive: true,
		})
		.returning({ id: OrganizationLocation.id })

	if (!created?.id) {
		throw new Error('Failed to create the default restaurant location.')
	}
	return created.id
}

export function requireLocationIdForProvider(
	providerName: string,
	organizationLocationId: string | null | undefined,
): string {
	if (!isLocationScopedIntegration(providerName)) {
		return organizationLocationId ?? ''
	}
	if (!organizationLocationId?.trim()) {
		throw new Error('A restaurant location is required for this integration.')
	}
	return organizationLocationId.trim()
}

/** Resolves the Menuza location id used when connecting a location-scoped integration. */
export async function resolveOrganizationLocationIdForConnect(
	organizationId: string,
	providerName: string,
	organizationLocationId: string | null | undefined,
): Promise<string | null> {
	if (!isLocationScopedIntegration(providerName)) {
		return null
	}
	const trimmed = organizationLocationId?.trim()
	if (trimmed) {
		await assertLocationInOrganization(organizationId, trimmed)
		return trimmed
	}
	return ensureDefaultOrganizationLocation(organizationId)
}

export async function findScopedIntegration(
	organizationId: string,
	providerName: string,
	organizationLocationId: string | null | undefined,
): Promise<Integration | undefined> {
	if (isLocationScopedIntegration(providerName)) {
		const locationId = requireLocationIdForProvider(
			providerName,
			organizationLocationId,
		)
		await assertLocationInOrganization(organizationId, locationId)
		const [row] = await db
			.select()
			.from(IntegrationTable)
			.where(
				and(
					eq(IntegrationTable.organizationId, organizationId),
					eq(IntegrationTable.providerName, providerName),
					eq(IntegrationTable.organizationLocationId, locationId),
				),
			)
			.limit(1)
		return row
	}

	const [row] = await db
		.select()
		.from(IntegrationTable)
		.where(
			and(
				eq(IntegrationTable.organizationId, organizationId),
				eq(IntegrationTable.providerName, providerName),
				isNull(IntegrationTable.organizationLocationId),
			),
		)
		.limit(1)
	return row
}
