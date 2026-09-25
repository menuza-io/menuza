import { and, db, eq, OrganizationLocation } from '@repo/database'
import { redirect, type ActionFunctionArgs } from 'react-router'
import { setSelectedLocation } from '#app/utils/location/location-cookie.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function loader() {
	return redirect('/')
}

export async function action({ request }: ActionFunctionArgs) {
	const formData = await request.formData()
	const orgSlug = formData.get('orgSlug') as string
	const locationId = (formData.get('locationId') as string) || 'all'

	if (!orgSlug) {
		return Response.json({ error: 'orgSlug is required' }, { status: 400 })
	}

	// Requires a signed-in user with access to the org before writing the cookie.
	const organization = await requireUserOrganization(request, orgSlug)

	// `all` is the only value that isn't a concrete location; everything else
	// must resolve to a location owned by this organization.
	if (locationId !== 'all') {
		const [location] = await db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organization.id),
				),
			)
			.limit(1)

		if (!location) {
			return Response.json({ error: 'Location not found' }, { status: 404 })
		}
	}

	const cookie = await setSelectedLocation(request, orgSlug, locationId)

	return Response.json(
		{ success: true, locationId },
		{
			headers: {
				'Set-Cookie': cookie,
			},
		},
	)
}
