import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface OperatorAlertsWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type OperatorAlertsWorkflowParams = {
	runAt: string
}

export const OPERATOR_ALERTS_JOB_PATH = '/resources/jobs/operator-alerts'

/**
 * Wakes the App when quiet hours end (#366), so alerts held for a member go out
 * on time instead of up to an hour late.
 *
 * `apps/jobs-cron/wrangler.jsonc` already uses all 5 Cloudflare cron slots, so
 * this mirrors `MenuScheduleWorkflow`: it sleeps until `runAt`
 * (`step.sleepUntil`) and calls `POST /resources/jobs/operator-alerts`, while
 * the hourly sweep is the fallback (it also reads push receipts, sends the pause
 * and busy-mode alerts and prunes the alert log). The App sends each held alert
 * once, so a wake-up that finds nothing due is a safe no-op. The payload is a
 * time: no member, no alert.
 */
export class OperatorAlertsWorkflow extends WorkflowEntrypoint<
	OperatorAlertsWorkflowEnv,
	OperatorAlertsWorkflowParams
> {
	async run(
		event: WorkflowEvent<OperatorAlertsWorkflowParams>,
		step: WorkflowStep,
	) {
		const runAt = new Date(event.payload.runAt)
		if (!Number.isNaN(runAt.getTime()) && runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait-until-quiet-hours-end', runAt)
		}
		await step.do(
			'send-held-alerts',
			{ retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
			async () => {
				const response = await fetch(
					`${this.env.APP_BASE_URL.replace(/\/$/, '')}${OPERATOR_ALERTS_JOB_PATH}`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
						},
					},
				)
				if (!response.ok) {
					throw new Error(
						`${OPERATOR_ALERTS_JOB_PATH} failed: ${response.status} ${response.statusText}`,
					)
				}
				return { status: response.status }
			},
		)
	}
}
