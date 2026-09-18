import { requireUserId } from '@repo/auth'
import { combineHeaders } from '@repo/common'
import { setSelectedRestaurantLocationId } from '@repo/common/restaurant-location-cookie'
import { redirect, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'

import { getUserOrganizations } from '#app/utils/organization/organizations.server.ts'

const SetLocationSchema = z.object({
	organizationId: z.string().min(1),
	locationId: z
		.string()
		.optional()
		.transform((value) => (value && value.length > 0 ? value : null)),
})

export async function action({ request }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const formData = await request.formData()
	const parsed = SetLocationSchema.safeParse(Object.fromEntries(formData))

	if (!parsed.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	const { organizationId, locationId } = parsed.data
	const userOrganizations = await getUserOrganizations(userId)
	const membership = userOrganizations.find(
		(row) => row.organization.id === organizationId,
	)

	if (!membership) {
		return Response.json({ error: 'Forbidden' }, { status: 403 })
	}

	const setCookie = await setSelectedRestaurantLocationId(
		request,
		organizationId,
		locationId,
	)

	const referer = request.headers.get('Referer')
	const fallback = `/${membership.organization.slug}`
	const target =
		referer && referer.includes(membership.organization.slug)
			? new URL(referer).pathname + new URL(referer).search
			: fallback

	return redirect(target, {
		headers: combineHeaders({ 'Set-Cookie': setCookie }),
	})
}
