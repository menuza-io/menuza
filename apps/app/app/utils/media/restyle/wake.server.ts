import { ENV } from 'varlock/env'

/**
 * Asks jobs-cron to run `MediaRestyleWorkflow` for a run (#146). The payload
 * carries only the run id. Best effort: the sweep (hourly) wakes a run that
 * never started.
 */
export async function wakeMediaRestyleWorkflow(
	runId: string,
): Promise<boolean> {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) return false
	try {
		const response = await fetch(
			`${workerUrl.replace(/\/$/u, '')}/workflows/media-restyle/start`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ runId }),
				signal: AbortSignal.timeout(5_000),
			},
		)
		return response.ok
	} catch {
		return false
	}
}
