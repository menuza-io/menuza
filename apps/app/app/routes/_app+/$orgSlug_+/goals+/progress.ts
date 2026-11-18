import { requireUserId } from '@repo/auth'
import { data } from 'react-router'
import { z } from 'zod'
import { loadLocationGoalProgress } from '#app/utils/goals/sales-goals.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import { type Route } from './+types/progress.ts'

const querySchema = z.object({
	month: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.optional(),
})

/** JSON progress for the Goals page and Home block (goals from control plane). */
export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	const url = new URL(request.url)
	const parsed = querySchema.safeParse({
		month: url.searchParams.get('month') ?? undefined,
	})
	const month =
		parsed.success && parsed.data.month
			? parsed.data.month
			: new Date().toISOString().slice(0, 7)
	const locationIds = await resolveReservationsLocationIds(
		userId,
		organization.id,
	)
	const progress = await loadLocationGoalProgress({
		organizationId: organization.id,
		month,
		actualByLocation: new Map(),
		locationIds,
	})
	return data({ month, progress })
}
