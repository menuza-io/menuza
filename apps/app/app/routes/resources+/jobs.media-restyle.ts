import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	processRestyleRun,
	sweepRestyleRuns,
} from '#app/utils/media/restyle/process.server.ts'

/**
 * Restyles a menu's dish photos in the background (#146).
 * - `{ runId }`: the Workflow's job (`MediaRestyleWorkflow`): claim the next
 *   few dishes of the run and make their drafts. Answers
 *   `{ done, paused, resumeAt, processed }`: `paused` with a `resumeAt` when
 *   the daily budget is spent (the Workflow sleeps until then), `paused` with
 *   none while the kill switch is on. A passing problem answers 503 so the
 *   Workflow retries.
 * - An empty body (the hourly sweep): goes on with paused runs whose budget
 *   day came, wakes runs that went quiet and prunes drafts nobody chose in 30
 *   days. Answers `{ swept, pruned }`.
 * The payload is an id: no photo, no dish data.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const text = await request.text().catch(() => '')
	let runId = ''
	if (text.trim()) {
		try {
			const body = JSON.parse(text) as { runId?: unknown }
			runId = typeof body.runId === 'string' ? body.runId.trim() : ''
		} catch {
			return Response.json({ success: false }, { status: 400 })
		}
	}
	if (!runId) {
		return Response.json({ success: true, ...(await sweepRestyleRuns()) })
	}
	if (!/^[A-Za-z0-9_-]{8,64}$/u.test(runId)) {
		return Response.json({ success: false }, { status: 400 })
	}
	const outcome = await processRestyleRun(runId)
	if (outcome.retry) {
		return Response.json(
			{ success: false, runId, retry: true, processed: outcome.processed },
			{ status: 503 },
		)
	}
	return Response.json({
		success: true,
		runId,
		done: outcome.done,
		paused: outcome.paused,
		resumeAt: outcome.resumeAt ? outcome.resumeAt.toISOString() : null,
		processed: outcome.processed,
	})
}
