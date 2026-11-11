/**
 * Pause online orders and busy mode for one location (Orders page). Action
 * only: the Orders loader reads the current state. Needs menu write access,
 * the same permission as marking dishes unavailable.
 */
import { data, type ActionFunctionArgs } from 'react-router'
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
