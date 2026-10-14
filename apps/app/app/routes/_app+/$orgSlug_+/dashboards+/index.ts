import { requireUserId } from '@repo/auth'
import { redirect } from 'react-router'
import { handleCreateDashboardAction } from '#app/utils/dashboards/actions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { type Route } from './+types/index.ts'

/** Dashboards are listed in the switcher on Home, so the list itself is Home. */
export async function loader({ request, params }: Route.LoaderArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		slug: true,
	})
	return redirect(`/${organization.slug}`)
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	return handleCreateDashboardAction({ request, userId, organization })
}
