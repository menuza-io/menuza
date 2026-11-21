import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	processHeroVideo,
	sweepHeroVideos,
} from '#app/utils/website/hero-video/service.server.ts'

/**
 * Makes a hero video from a restaurant's photos in the background (#301).
 * - `{ generationId }`: the Workflow's job (`HeroVideoWorkflow`): claim the
 *   request and render it. Only one caller wins a request.
 * - An empty body (the hourly `0 * * * *` sweep): re-drives requests that were
 *   never woken or whose render went quiet, and fails ones out of attempts.
 * The payload is an id: no photo, no organization data.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const text = await request.text().catch(() => '')
	let generationId = ''
	if (text.trim()) {
		try {
			const body = JSON.parse(text) as { generationId?: unknown }
			generationId =
				typeof body.generationId === 'string' ? body.generationId.trim() : ''
		} catch {
			return Response.json({ success: false }, { status: 400 })
		}
	}
	if (!generationId) {
		return Response.json({ success: true, ...(await sweepHeroVideos()) })
	}
	if (!/^[a-z0-9]{8,64}$/iu.test(generationId)) {
		return Response.json({ success: false }, { status: 400 })
	}
	const outcome = await processHeroVideo(generationId)
	// A passing problem: not a success, so the workflow's retries run.
	if (!outcome.ok && outcome.retry) {
		return Response.json(
			{ success: false, generationId, error: outcome.error, retry: true },
			{ status: 503 },
		)
	}
	return Response.json({
		success: outcome.ok,
		generationId,
		...(outcome.ok ? { status: outcome.status } : { error: outcome.error }),
	})
}
