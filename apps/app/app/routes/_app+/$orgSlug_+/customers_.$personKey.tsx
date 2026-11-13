import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { PersonProfileScreen } from '#app/components/customers/person-profile-screen.tsx'
import { loadMemberNames } from '#app/utils/inventory/actors.server.ts'
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
	const { organizationId, userId, access } = await requirePeopleAccess(
		request,
		orgSlug,
	)
	// Flags and grants only: a customer's points never pass through App.
	const loyalty = await getLoyaltyCapabilities(request, organizationId)
	// Operator names only (control plane, no guest data): they label who
	// recorded a guest's marketing consent. The ids come from the region.
	const memberNames = access.customers
		? await loadMemberNames(organizationId)
		: {}
	return {
		orgSlug,
		personKey: params.personKey || '',
		loyalty,
		memberNames,
		currentUserId: userId,
	}
}

export default function CustomerProfileRoute() {
	const { orgSlug, personKey, loyalty, memberNames, currentUserId } =
		useLoaderData<typeof loader>()
	return (
		<PersonProfileScreen
			client={getPeopleClient(orgSlug)}
			orgSlug={orgSlug}
			personKey={personKey}
			loyalty={loyalty}
			memberNames={memberNames}
			currentUserId={currentUserId}
		/>
	)
}
