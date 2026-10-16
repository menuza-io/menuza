import { invariant } from '@epic-web/invariant'
import { requireUserId } from '@repo/auth'
import { and, db, eq, or, Organization, UserOrganization } from '@repo/database'
import { type Organization as OrganizationRow } from '@repo/database/types'
import { userHasOrgAccess } from '#app/utils/organization/organizations.server.ts'

/**
 * Load an organization by slug for the authenticated user.
 * Throws a 404 if the organization doesn't exist or user is not a member.
 *
 * @param request - The request object
 * @param orgSlug - The organization slug from route params
 * @param columns - Optional organization fields to return
 * @returns The organization with selected fields
 */
export function requireUserOrganization(
	request: Request,
	orgSlug: string | undefined,
): Promise<OrganizationRow>
export function requireUserOrganization<K extends keyof OrganizationRow>(
	request: Request,
	orgSlug: string | undefined,
	columns: Record<K, true>,
): Promise<Pick<OrganizationRow, K>>
export async function requireUserOrganization(
	request: Request,
	orgSlug: string | undefined,
	columns?: Partial<Record<keyof OrganizationRow, true>>,
): Promise<OrganizationRow | Partial<OrganizationRow>> {
	const userId = await requireUserId(request)
	invariant(orgSlug, 'orgSlug is required')

	const [organization] = await db
		.select()
		.from(Organization)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, Organization.id),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.where(
			and(
				or(eq(Organization.slug, orgSlug), eq(Organization.id, orgSlug)),
				eq(Organization.active, true),
			),
		)
		.limit(1)

	if (!organization) {
		throw new Response('Not Found', { status: 404 })
	}

	const row = organization.Organization
	if (!columns) return row
	const selected: Partial<OrganizationRow> = {}
	for (const key of Object.keys(columns) as Array<keyof OrganizationRow>) {
		;(selected as Record<string, unknown>)[key as string] = row[key]
	}
	return selected
}

/**
 * Validates organization exists and user has access to it.
 * Common helper for API routes that need organization validation.
 * Throws Response with appropriate status codes if validation fails.
 *
 * @param request - The request object
 * @param orgSlug - The organization slug from route params
 * @returns The organization with id
 */
export async function validateOrgAccess(
	request: Request,
	orgSlug: string | undefined,
): Promise<{ id: string }> {
	if (!orgSlug) {
		throw new Response('Missing orgSlug', { status: 400 })
	}

	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(
			and(
				or(eq(Organization.slug, orgSlug), eq(Organization.id, orgSlug)),
				eq(Organization.active, true),
			),
		)
		.limit(1)

	if (!organization) {
		throw new Response('Organization not found', { status: 404 })
	}

	await userHasOrgAccess(request, organization.id)

	return organization
}
