/**
 * Pause online orders and busy mode for one location (Orders page). Action
 * only: the Orders loader reads the current state. Needs menu write access,
 * the same permission as marking dishes unavailable, and the location inside
 * the member's location scope. Many locations at once: the Locations page
 * (`bulk-ordering` intent), which calls the same writer.
 */
import { data, type ActionFunctionArgs } from 'react-router'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'
import { applyOrderingControl } from '#app/utils/location/ordering-controls.server.ts'
import { orderingControlSchema } from '#app/utils/location/ordering-pause.ts'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug ?? '',
		{ id: true, slug: true },
	)
	const userId = await requireMenuWrite(request, organization.id)
	const formData = await request.formData()
	const parsed = orderingControlSchema.safeParse(
		Object.fromEntries(formData.entries()),
	)
	if (!parsed.success) {
		return data({ ok: false, error: 'invalid_request' }, { status: 400 })
	}
	// A member limited to some locations pauses only those, here and in bulk.
	const scope = await resolveMemberLocationIds(userId, organization.id)
	if (scope !== null && !scope.includes(parsed.data.locationId)) {
		return data(
			{ ok: false, error: 'location_not_allowed' },
			{ status: 403 },
		)
	}
	const result = await applyOrderingControl({
		organization,
		userId,
		control: parsed.data,
		request,
	})
	if (!result.ok) {
		return data({ ok: false, error: result.error }, { status: result.status })
	}
	return data({ ok: true, error: null })
}
