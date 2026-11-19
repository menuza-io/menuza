import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { refreshGooglePostStates } from '#app/utils/social/google-posts.server.ts'
import { publishDueSocialPosts } from '#app/utils/social/posts.server.ts'

/**
 * Fallback hourly sweep for scheduled social posts that missed their workflow
 * wake-up, plus review-state polling for Google posts held by Google.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const [published, googleReview] = await Promise.all([
		publishDueSocialPosts(),
		refreshGooglePostStates(),
	])
	return Response.json({
		success: true,
		...published,
		googleReview,
		timestamp: new Date().toISOString(),
	})
}
