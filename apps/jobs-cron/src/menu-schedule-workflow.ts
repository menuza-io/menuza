import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface MenuScheduleWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type MenuScheduleWorkflowParams = {
	scheduleId: string
	runAt: string
}

export const MENU_SCHEDULE_JOB_PATH = '/resources/jobs/menu-schedules'

/**
 * Wakes the App when a scheduled menu changeover is due (#149).
 *
 * Because `apps/jobs-cron/wrangler.jsonc` already uses all 5 Cloudflare cron
 * trigger slots, we mirror #180 (`WebsitePublishWorkflow`): this Workflow sleeps
 * until `goLiveAt` via `step.sleepUntil` (satisfying the within-5-minutes
 * criterion) and triggers `POST /resources/jobs/menu-schedules`, while the
 * hourly `0 * * * *` cron sweep acts as a fallback. The App claims each due
 * schedule atomically, so a wake-up for a cancelled, replaced, or already
 * applied schedule is a safe no-op.
 */
export class MenuScheduleWorkflow extends WorkflowEntrypoint<
	MenuScheduleWorkflowEnv,
	MenuScheduleWorkflowParams
> {
	async run(
		event: WorkflowEvent<MenuScheduleWorkflowParams>,
		step: WorkflowStep,
	) {
		const runAt = new Date(event.payload.runAt)
		if (!Number.isNaN(runAt.getTime()) && runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait-until-due', runAt)
		}
		await step.do(
			'apply-due-menu-schedules',
			{ retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
			async () => {
				const response = await fetch(
					`${this.env.APP_BASE_URL.replace(/\/$/, '')}${MENU_SCHEDULE_JOB_PATH}`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
						},
					},
				)
				if (!response.ok) {
					throw new Error(
						`${MENU_SCHEDULE_JOB_PATH} failed: ${response.status} ${response.statusText}`,
					)
				}
				return { status: response.status }
			},
		)
	}
}
