import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface OccasionScheduleWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type OccasionScheduleWorkflowParams = {
	/** The instant to wake the App (ISO). */
	runAt: string
}

export const OCCASION_SCHEDULE_JOB_PATH = '/resources/jobs/occasion-schedule'

/**
 * The daily wake-up of the marketing calendar's Auto-schedule (#152). All five
 * cron trigger slots are in use, so this Workflow sleeps until `runAt` with
 * `step.sleepUntil` and then calls `POST /resources/jobs/occasion-schedule`;
 * the hourly sweep is the fallback. The App creates the Scheduled broadcasts of
 * the occasions that are 14 days away (once per organization, occasion and
 * year: a second wake-up creates nothing) and starts the next day's wake-up
 * itself. The payload is a time: no organization, no occasion, no guest.
 */
export class OccasionScheduleWorkflow extends WorkflowEntrypoint<
	OccasionScheduleWorkflowEnv,
	OccasionScheduleWorkflowParams
> {
	async run(
		event: WorkflowEvent<OccasionScheduleWorkflowParams>,
		step: WorkflowStep,
	) {
		const runAt = new Date(event.payload.runAt)
		if (!Number.isNaN(runAt.getTime()) && runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait-until-due', runAt)
		}
		await step.do(
			'schedule-occasions',
			{ retries: { limit: 3, delay: '60 seconds', backoff: 'exponential' } },
			async () => {
				const response = await fetch(
					`${this.env.APP_BASE_URL.replace(/\/$/, '')}${OCCASION_SCHEDULE_JOB_PATH}`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
							'Content-Type': 'application/json',
						},
						body: '{}',
						signal: AbortSignal.timeout(120_000),
					},
				)
				if (!response.ok) {
					throw new Error(
						`${OCCASION_SCHEDULE_JOB_PATH} failed: ${response.status} ${response.statusText}`,
					)
				}
				return { status: response.status }
			},
		)
	}
}
