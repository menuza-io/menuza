import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { PersonProfileScreen } from '#app/components/customers/person-profile-screen.tsx'
import { requirePeopleAccess } from '#app/utils/people/people-access.server.ts'
import { getPeopleClient } from '#app/utils/people/people-api.ts'

/**
 * One person: `c_<customerId>` or `g_<guestId>`. A guest key resolves to the
 * linked customer, a merged guest to the survivor (the screen follows the
 * canonical key the API returns).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	await requirePeopleAccess(request, orgSlug)
	return { orgSlug, personKey: params.personKey || '' }
}

export default function CustomerProfileRoute() {
	const { orgSlug, personKey } = useLoaderData<typeof loader>()
	return (
		<PersonProfileScreen
			client={getPeopleClient(orgSlug)}
			orgSlug={orgSlug}
			personKey={personKey}
		/>
	)
}
