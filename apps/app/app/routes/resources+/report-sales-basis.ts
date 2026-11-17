import { requireUserId } from '@repo/auth'
import {
	SALES_BASIS_VALUES,
	type SalesBasis,
} from '@repo/common/sales-report-facts'
import { z } from 'zod'
import { type ActionFunctionArgs } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { setReportSalesBasis } from '#app/utils/reports/sales-basis.server.ts'

const bodySchema = z.object({
	orgSlug: z.string().min(1),
	basis: z.enum(SALES_BASIS_VALUES),
})

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return Response.json({ error: 'method_not_allowed' }, { status: 405 })
	}
	const userId = await requireUserId(request)
	let json: unknown
	try {
		json = await request.json()
	} catch {
		return Response.json({ error: 'invalid_json' }, { status: 400 })
	}
	const parsed = bodySchema.safeParse(json)
	if (!parsed.success) {
		return Response.json({ error: 'invalid_request' }, { status: 400 })
	}
	const organization = await requireUserOrganization(
		request,
		parsed.data.orgSlug,
	)
	await setReportSalesBasis(
		userId,
		organization.id,
		parsed.data.basis as SalesBasis,
	)
	return Response.json({ success: true, basis: parsed.data.basis })
}
