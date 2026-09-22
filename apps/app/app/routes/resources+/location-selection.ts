import { redirect, type ActionFunctionArgs } from 'react-router'
import { setSelectedLocation } from '#app/utils/location/location-cookie.server.ts'

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
