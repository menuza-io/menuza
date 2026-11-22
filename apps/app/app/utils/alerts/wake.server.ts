import { ENV } from 'varlock/env'

export const OPERATOR_ALERTS_START_PATH = '/workflows/operator-alerts/start'

/**
 * Best-effort wake-up of `OperatorAlertsWorkflow` for the moment quiet hours end
 * (`sleepUntil`). With no worker configured or a failed call the hourly sweep
 * still sends the held alert, up to an hour late.
 */
export async function wakeOperatorAlertsAt(runAt: Date): Promise<boolean> {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) return false
	try {
		const response = await fetch(
			`${workerUrl.replace(/\/$/, '')}${OPERATOR_ALERTS_START_PATH}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ runAt: runAt.toISOString() }),
				signal: AbortSignal.timeout(5_000),
			},
		)
		void response.body?.cancel().catch(() => undefined)
		return response.ok
	} catch {
		return false
	}
}
