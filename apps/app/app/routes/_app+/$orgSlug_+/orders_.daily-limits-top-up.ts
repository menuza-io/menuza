/**
 * Add to, or set the amount left of, one dish's daily limit for today
 * (Orders page, #409). Needs menu write access (`orders:write` operator
 * token), like resetting the slot counters.
 */
import { data, type ActionFunctionArgs } from 'react-router'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { topUpDailyLimitThroughRegion } from '#app/utils/orders/daily-limit-top-up.server.ts'
import { parseDailyLimitTopUpForm } from '#app/utils/orders/daily-limit-top-up.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug ?? '',
		{ id: true, slug: true },
	)
	const userId = await requireMenuWrite(request, organization.id)
	const formData = await request.formData()
	const parsed = parseDailyLimitTopUpForm(
		Object.fromEntries(formData.entries()),
	)
	if (!parsed.ok) {
		return data({ ok: false, error: 'invalid_request' }, { status: 400 })
	}
	const result = await topUpDailyLimitThroughRegion({
		...parsed.data,
		request,
		orgSlug: organization.slug,
		organizationId: organization.id,
		userId,
	})
	if (!result.ok) {
		return data({ ok: false, error: result.error }, { status: result.status })
	}
	return data({ ok: true, error: null, row: result.row })
}
