import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { pruneAllMenuSnapshots } from '#app/utils/menu/snapshot.server.ts'
import { type Route } from './+types/jobs.menu-snapshot-prune.ts'

export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	await requireInternalCommandAuth(request)
	const { deleted } = await pruneAllMenuSnapshots()

	return Response.json({
		success: true,
		deleted,
		timestamp: new Date().toISOString(),
	})
}
