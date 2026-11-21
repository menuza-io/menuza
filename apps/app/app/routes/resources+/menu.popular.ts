import {
	menuPopularPayloadSchema,
	menuPopularResultSchema,
} from '@repo/common/menu-popular'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { applyAutoPopularBadges } from '#app/utils/menu/auto-popular.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /resources/menu/popular`: receives daily top-selling item IDs from the
 * regional `tenant-api` and updates `OrganizationMenuItem.isPopular` for
 * `popularMode = 'auto'` items.
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only; payload is strict
 * (`{ orgId, itemIds, windowDays }`).
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}

	const raw = await request.json().catch(() => null)
	const parsed = menuPopularPayloadSchema.safeParse(raw)
	if (!parsed.success || !parsed.data.orgId) {
		return Response.json(
			{
				error: 'invalid_request',
				issues: parsed.success
					? [{ path: 'orgId', code: 'too_small' }]
					: parsed.error.issues.slice(0, 10).map((issue) => ({
							path: issue.path.join('.'),
							code: issue.code,
						})),
			},
			{ status: 400, headers: NO_STORE },
		)
	}

	const outcome = await applyAutoPopularBadges({
		...parsed.data,
		orgId: parsed.data.orgId,
	})

	if (outcome.status === 'not_found') {
		return Response.json(
			{ error: 'org_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}

	return Response.json(menuPopularResultSchema.parse(outcome.result), {
		headers: NO_STORE,
	})
}
