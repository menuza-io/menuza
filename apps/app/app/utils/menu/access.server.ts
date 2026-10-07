import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	checkRateLimit,
	MENU_MUTATION_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

/**
 * Require read access before loading any menu data. Each child loader must
 * call this independently: React Router can skip parent loaders on data requests.
 * Built-in members and viewers keep read access; only roles with
 * `read:menu:any` (or admin) may view catering/online menus.
 */
export async function requireMenuRead(
	request: Request,
	organizationId: string,
): Promise<string> {
	return requireUserWithOrganizationPermission(
		request,
		organizationId,
		ORG_PERMISSIONS.READ_MENU_ANY,
	)
}

/**
 * Require write access to an organization's menus and apply the shared menu
 * mutation rate limit. Every menu/drop mutation action funnels through this
 * so permission checks cannot be forgotten and a single member cannot amplify
 * writes (e.g. mass reorder) into a DoS.
 */
export async function requireMenuWrite(
	request: Request,
	organizationId: string,
): Promise<string> {
	const userId = await requireUserWithOrganizationPermission(
		request,
		organizationId,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)

	const { allowed, resetAt } = await checkRateLimit(
		{ type: 'user', value: userId },
		MENU_MUTATION_RATE_LIMIT,
	)

	if (!allowed) {
		const retryAfter = Math.max(
			0,
			Math.ceil((resetAt.getTime() - Date.now()) / 1000),
		)
		throw new Response('Too many menu changes. Please try again shortly.', {
			status: 429,
			headers: {
				'Retry-After': retryAfter.toString(),
				'X-RateLimit-Reset': resetAt.toISOString(),
			},
		})
	}

	return userId
}
