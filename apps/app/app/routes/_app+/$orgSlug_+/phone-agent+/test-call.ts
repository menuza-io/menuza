import { type Route } from './+types/test-call.ts'
import { loadTestCallPage, startTestCall } from './test-call.server.ts'

/** Data for the test call sheet. */
export async function loader({ request, params }: Route.LoaderArgs) {
	return loadTestCallPage(request, params.orgSlug)
}

export async function action({ request, params }: Route.ActionArgs) {
	return startTestCall(request, params.orgSlug)
}
