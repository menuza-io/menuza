import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { PersonProfileScreen } from '#app/components/customers/person-profile-screen.tsx'
import { getLoyaltyCapabilities } from '#app/utils/loyalty/access.server.ts'
import { requirePeopleAccess } from '#app/utils/people/people-access.server.ts'
import { getPeopleClient } from '#app/utils/people/people-api.ts'

/**
 * One person: `c_<customerId>` or `g_<guestId>`. A guest key resolves to the
 * linked customer, a merged guest to the survivor (the screen follows the
 * canonical key the API returns).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { organizationId } = await requirePeopleAccess(request, orgSlug)
	// Flags and grants only: a customer's points never pass through App.
	const loyalty = await getLoyaltyCapabilities(request, organizationId)
	return { orgSlug, personKey: params.personKey || '', loyalty }
}

export default function CustomerProfileRoute() {
	const { orgSlug, personKey, loyalty } = useLoaderData<typeof loader>()
	return (
		<PersonProfileScreen
			client={getPeopleClient(orgSlug)}
			orgSlug={orgSlug}
			personKey={personKey}
			loyalty={loyalty}
		/>
	)
}
