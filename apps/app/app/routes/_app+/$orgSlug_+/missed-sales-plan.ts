import { requireUserId } from '@repo/auth'
import { data, type LoaderFunctionArgs } from 'react-router'
import { loadMissedPlanEntries } from '#app/utils/location/missed-estimate.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import { hasAdminReportAccess } from '#app/utils/staffing/report-grants.server.ts'

/**
 * `GET /:orgSlug/missed-sales-plan?mode=latest|today`: the windows the browser
 * sends to its region to estimate the sales missed while online ordering was
 * paused (#176). Times only. Needs the report grant (the estimate is a sales
 * figure) and only covers the member's own locations; without the grant it is
 * a 404, so the pause card and the Today line simply do not show it.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	if (!(await hasAdminReportAccess(userId, organization.id))) {
		throw new Response('Not Found', { status: 404 })
	}
	const locationIds = await resolveReservationsLocationIds(
		userId,
		organization.id,
	)
	const url = new URL(request.url)
	const now = new Date()
	const entries = await loadMissedPlanEntries(organization.id, {
		now,
		locationIds,
		mode:
			url.searchParams.get('mode') === 'today'
				? { kind: 'today' }
				: { kind: 'latest', withinDays: 14 },
	})
	return data({ entries }, { headers: { 'Cache-Control': 'private, no-store' } })
}
