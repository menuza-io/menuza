import { and, db, eq, OrganizationLocation, sql } from '@repo/database'
import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'

export const locationInputSchema = z.object({
	name: z.string().trim().min(1, 'Name is required').max(120),
	slug: z
		.string()
		.trim()
		.max(80)
		.optional()
		.transform((value) => (value ? value : null)),
	addressLine1: z.string().trim().max(200).optional().nullable(),
	addressLine2: z.string().trim().max(200).optional().nullable(),
	city: z.string().trim().max(100).optional().nullable(),
	state: z.string().trim().max(50).optional().nullable(),
	postalCode: z.string().trim().max(20).optional().nullable(),
	country: z.string().trim().max(2).optional().nullable(),
	timezone: z.string().trim().min(1).max(80).default('America/Chicago'),
	hoursJson: z.string().optional().nullable(),
	active: z.boolean().optional().default(true),
})

export type OrganizationLocationRow = typeof OrganizationLocation.$inferSelect

export async function listOrganizationLocations(organizationId: string) {
	return db
		.select()
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.orderBy(
			sql`CASE WHEN ${OrganizationLocation.isDefault} THEN 0 ELSE 1 END`,
			OrganizationLocation.name,
		)
}

export async function getDefaultOrganizationLocationId(
	organizationId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isDefault, true),
				eq(OrganizationLocation.active, true),
			),
		)
		.limit(1)
	return row?.id ?? null
}

/**
 * Ensures the restaurant has exactly one default active location (MVP: single branch).
 */
export async function ensureDefaultOrganizationLocation(options: {
	organizationId: string
	name?: string
}) {
	const existing = await getDefaultOrganizationLocationId(
		options.organizationId,
	)
	if (existing) return existing

	const [created] = await db
		.insert(OrganizationLocation)
		.values({
			id: createId(),
			organizationId: options.organizationId,
			name: options.name?.trim() || 'Main location',
			isDefault: true,
			active: true,
		})
		.returning({ id: OrganizationLocation.id })

	if (!created) {
		throw new Error('Failed to create default restaurant location')
	}

	return created.id
}

export async function createOrganizationLocation(
	organizationId: string,
	input: z.infer<typeof locationInputSchema>,
) {
	const parsed = locationInputSchema.parse(input)
	const [created] = await db
		.insert(OrganizationLocation)
		.values({
			id: createId(),
			organizationId,
			...parsed,
			isDefault: false,
		})
		.returning()
	return created
}

export async function updateOrganizationLocation(
	organizationId: string,
	locationId: string,
	input: z.infer<typeof locationInputSchema>,
) {
	const parsed = locationInputSchema.parse(input)
	const [updated] = await db
		.update(OrganizationLocation)
		.set(parsed)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.returning()
	return updated ?? null
}

export async function getOrganizationLocation(
	organizationId: string,
	locationId: string,
) {
	const [row] = await db
		.select()
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.limit(1)
	return row ?? null
}
