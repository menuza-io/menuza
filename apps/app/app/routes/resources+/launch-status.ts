/**
 * `POST /resources/launch-status` `{ organizationId }`, for Admin's Launch
 * card (internal command token). The same evaluator as the App's launch
 * checklist, over every active location, plus the days since sign-up and the
 * first real order's date (a timestamp from the region, never an order).
 * State and dates only: no guest, member or contact field.
 */
import { and, db, eq, Organization } from '@repo/database'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { loadLaunchFacts } from '#app/utils/dashboards/regional-home.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	isLaunchChecklistOn,
	loadLaunchChecklist,
} from '#app/utils/launch/launch.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const bodySchema = z.object({ organizationId: z.string().min(1).max(64) })

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
	const parsed = bodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}
	const [organization] = await db
		.select({
			id: Organization.id,
			createdAt: Organization.createdAt,
			dataRegion: Organization.dataRegion,
		})
		.from(Organization)
		.where(and(eq(Organization.id, parsed.data.organizationId)))
		.limit(1)
	if (!organization) {
		return Response.json(
			{ error: 'not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}
	const now = new Date()
	const facts = await loadLaunchFacts(organization)
	const [checklist, enabled] = await Promise.all([
		loadLaunchChecklist({
			organizationId: organization.id,
			userId: null,
			now,
			facts,
		}),
		isLaunchChecklistOn(organization.id),
	])
	return Response.json(
		{
			enabled,
			createdAt: organization.createdAt.toISOString(),
			daysSinceSignup: Math.floor(
				(now.getTime() - organization.createdAt.getTime()) / 86_400_000,
			),
			firstOrderAt: facts?.firstOrderAt ?? null,
			regionAnswered: facts !== null,
			locations: (checklist?.locations ?? []).map((location) => ({
				id: location.id,
				name: location.name,
				live: location.live,
				liveAt: location.liveAt,
				requiredDone: location.requiredDone,
				requiredTotal: location.requiredTotal,
				steps: location.steps.map((step) => ({
					key: step.key,
					optional: step.optional,
					state: step.state,
					completedAt: step.completedAt,
					skippedAt: step.skippedAt,
				})),
			})),
		},
		{ headers: NO_STORE },
	)
}
