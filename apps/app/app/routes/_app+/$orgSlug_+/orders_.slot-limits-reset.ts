/**
 * Confirm and reset order slot counters for one location (Orders page). Needs
 * menu write access (`orders:write` operator token).
 */
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { resetSlotLimitsThroughRegion } from '#app/utils/orders/slot-limits-reset.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

const slotLimitsResetSchema = z.strictObject({
	locationId: z.string().min(1).max(100),
})

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug ?? '',
		{ id: true, slug: true },
	)
	const userId = await requireMenuWrite(request, organization.id)
	const formData = await request.formData()
	const parsed = slotLimitsResetSchema.safeParse(
		Object.fromEntries(formData.entries()),
	)
	if (!parsed.success) {
		return data({ ok: false, error: 'invalid_request' }, { status: 400 })
	}
	const result = await resetSlotLimitsThroughRegion({
		request,
		orgSlug: organization.slug,
		organizationId: organization.id,
		userId,
		locationId: parsed.data.locationId,
	})
	if (!result.ok) {
		return data({ ok: false, error: result.error }, { status: result.status })
	}
	return data({ ok: true, error: null, slotsCleared: result.slotsCleared })
}
