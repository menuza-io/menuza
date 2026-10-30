import { ENV } from 'varlock/env'

/**
 * Asks jobs-cron to wake the publisher when a scheduled post is due (a
 * Workflow that sleeps until then). Best effort: the hourly sweep publishes
 * anything a missed wake-up left behind, only later. Sends ids and a time.
 */
export async function wakeSocialPublisherAt(postId: string, runAt: Date) {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) return false
	try {
		const response = await fetch(
			`${workerUrl.replace(/\/$/, '')}/workflows/social-post/start`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ postId, runAt: runAt.toISOString() }),
				signal: AbortSignal.timeout(5_000),
			},
		)
		if (!response.ok) {
			console.error('Social publish wake-up refused', {
				postId,
				status: response.status,
			})
			return false
		}
		return true
	} catch {
		console.error('Social publish wake-up failed', { postId })
		return false
	}
}
