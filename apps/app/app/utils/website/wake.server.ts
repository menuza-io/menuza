import { ENV } from 'varlock/env'

/**
 * Asks jobs-cron to wake the website publisher when a scheduled publish is due
 * (#180): a Workflow sleeps until then and calls the job route. Best effort:
 * the hourly sweep publishes anything a missed wake-up left behind, only
 * later. The request carries an id and a time, never page content.
 */
export async function wakeWebsitePublisherAt(scheduleId: string, runAt: Date) {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) return false
	try {
		const response = await fetch(
			`${workerUrl.replace(/\/$/, '')}/workflows/website-publish/start`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ scheduleId, runAt: runAt.toISOString() }),
				signal: AbortSignal.timeout(5_000),
			},
		)
		if (!response.ok) {
			console.error('Website publish wake-up refused', {
				scheduleId,
				status: response.status,
			})
			return false
		}
		return true
	} catch {
		console.error('Website publish wake-up failed', { scheduleId })
		return false
	}
}
