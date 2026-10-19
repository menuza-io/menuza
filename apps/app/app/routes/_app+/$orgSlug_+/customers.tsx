import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { PeopleListScreen } from '#app/components/customers/people-list-screen.tsx'
import { requirePeopleAccess } from '#app/utils/people/people-access.server.ts'
import { getPeopleClient } from '#app/utils/people/people-api.ts'

/**
 * Customers is the one people screen: everyone who signed in, ordered or booked
 * a table. The loader only decides what the member may see and whether to offer
 * "New reservation"; the list itself is fetched by the browser from the
 * regional tenant-api with a short-lived token, so no customer data transits
 * this server.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { access, canBook } = await requirePeopleAccess(request, orgSlug)
	return { orgSlug, access, canBook }
}

export default function CustomersRoute() {
	const { orgSlug, access, canBook } = useLoaderData<typeof loader>()
	return (
		<PeopleListScreen
			client={getPeopleClient(orgSlug)}
			orgSlug={orgSlug}
			access={access}
			canBook={canBook}
		/>
	)
}
