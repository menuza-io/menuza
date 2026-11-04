import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { publishDueSocialPosts } from '#app/utils/social/posts.server.ts'

/**
 * Publishes the social posts whose scheduled time has come and finishes
 * interrupted ones (INTERNAL_COMMAND_TOKEN). jobs-cron calls it when a post is
 * due (SocialPostWorkflow) and hourly as a sweep.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await publishDueSocialPosts()
	return Response.json({
		success: true,
		...result,
		timestamp: new Date().toISOString(),
	})
}
