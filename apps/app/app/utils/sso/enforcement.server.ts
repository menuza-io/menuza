/**
 * SSO Enforcement Service
 *
 * Checks if users are required to use SSO login based on their organization membership.
 * When enforced, users cannot use password or social login.
 */

import {
	and,
	db,
	eq,
	or,
	Organization,
	SSOConfiguration,
	User,
	UserOrganization,
} from '@repo/database'

export interface SSOEnforcementResult {
	enforced: boolean
	organizationId?: string
	organizationName?: string
	organizationSlug?: string
	message?: string
}

/**
 * Check if a user (by email) is required to use SSO login
 *
 * Returns enforcement info if the user belongs to an organization with enforced SSO.
 * This should be called before allowing password or social login.
 */
export async function checkSSOEnforcementByEmail(
	email: string,
): Promise<SSOEnforcementResult> {
	try {
		// Find user by email with their organization memberships
		const organizations = await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
				isEnabled: SSOConfiguration.isEnabled,
				enforceSSOLogin: SSOConfiguration.enforceSSOLogin,
			})
			.from(User)
			.innerJoin(UserOrganization, eq(UserOrganization.userId, User.id))
			.innerJoin(
				Organization,
				eq(UserOrganization.organizationId, Organization.id),
			)
			.leftJoin(
				SSOConfiguration,
				eq(SSOConfiguration.organizationId, Organization.id),
			)
			.where(
				and(
					eq(User.email, email.toLowerCase()),
					eq(UserOrganization.active, true),
				),
			)

		for (const org of organizations) {
			const ssoConfig = org

			// If org has SSO enabled AND enforced, block non-SSO login
			if (ssoConfig?.isEnabled && ssoConfig?.enforceSSOLogin) {
				return {
					enforced: true,
					organizationId: org.id,
					organizationName: org.name,
					organizationSlug: org.slug,
					message: `Your organization "${org.name}" requires SSO login. Please use the SSO login option.`,
				}
			}
		}

		return { enforced: false }
	} catch (error) {
		// On error, don't block login (fail open for availability)
		console.error('SSO enforcement check failed:', error)
		return { enforced: false }
	}
}

/**
 * Check if a user (by ID) is required to use SSO login
 */
export async function checkSSOEnforcementByUserId(
	userId: string,
): Promise<SSOEnforcementResult> {
	try {
		const organizations = await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
				isEnabled: SSOConfiguration.isEnabled,
				enforceSSOLogin: SSOConfiguration.enforceSSOLogin,
			})
			.from(UserOrganization)
			.innerJoin(User, eq(UserOrganization.userId, User.id))
			.innerJoin(
				Organization,
				eq(UserOrganization.organizationId, Organization.id),
			)
			.leftJoin(
				SSOConfiguration,
				eq(SSOConfiguration.organizationId, Organization.id),
			)
			.where(and(eq(User.id, userId), eq(UserOrganization.active, true)))

		for (const org of organizations) {
			const ssoConfig = org

			if (ssoConfig?.isEnabled && ssoConfig?.enforceSSOLogin) {
				return {
					enforced: true,
					organizationId: org.id,
					organizationName: org.name,
					organizationSlug: org.slug,
					message: `Your organization "${org.name}" requires SSO login.`,
				}
			}
		}

		return { enforced: false }
	} catch (error) {
		console.error('SSO enforcement check failed:', error)
		return { enforced: false }
	}
}

/**
 * Check SSO enforcement for whatever a person typed into a login form: an
 * email address or a username. Matching by email alone would let someone
 * dodge enforcement by signing in with their username.
 */
export async function checkSSOEnforcementByIdentifier(
	identifier: string,
): Promise<SSOEnforcementResult> {
	try {
		const [user] = await db
			.select({ id: User.id })
			.from(User)
			.where(
				or(
					eq(User.email, identifier.trim().toLowerCase()),
					eq(User.username, identifier),
					eq(User.username, identifier.trim().toLowerCase()),
				),
			)
			.limit(1)
		if (!user) return { enforced: false }
		return checkSSOEnforcementByUserId(user.id)
	} catch (error) {
		console.error('SSO enforcement check failed:', error)
		return { enforced: false }
	}
}

/**
 * Get the SSO login URL for an organization
 */
export function getSSOLoginUrl(organizationSlug: string): string {
	return `/auth/sso/${organizationSlug}`
}

/**
 * Error class for SSO enforcement violations
 */
export class SSOEnforcementError extends Error {
	public readonly organizationSlug: string
	public readonly ssoLoginUrl: string

	constructor(result: SSOEnforcementResult) {
		super(result.message || 'SSO login is required for your organization')
		this.name = 'SSOEnforcementError'
		this.organizationSlug = result.organizationSlug || ''
		this.ssoLoginUrl = getSSOLoginUrl(this.organizationSlug)
	}
}
