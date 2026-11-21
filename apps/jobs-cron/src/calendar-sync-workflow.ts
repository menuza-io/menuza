import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface CalendarSyncWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type CalendarSyncWorkflowParams = {
	sourceId: string
	runAt: string
}

export const CALENDAR_SYNC_JOB_PATH = '/resources/jobs/calendar-sync'

/**
 * Wakes the App when a connected Google Calendar is due for its next read
 * (#319). All five cron trigger slots are in use, so (like #149 and #180) this
 * Workflow sleeps until the source's `nextSyncAt` with `step.sleepUntil` and
 * then calls `POST /resources/jobs/calendar-sync`; the hourly sweep is the
 * fallback. The App reads the calendar, reconciles the events and schedules
 * the following wake-up itself, and it ignores a wake-up for a source that was
 * already synced meanwhile, so a late or duplicate one is harmless.
 * The payload is a source id and a time: no address, no event text.
 */
export class CalendarSyncWorkflow extends WorkflowEntrypoint<
	CalendarSyncWorkflowEnv,
	CalendarSyncWorkflowParams
> {
	async run(
		event: WorkflowEvent<CalendarSyncWorkflowParams>,
		step: WorkflowStep,
	) {
		const runAt = new Date(event.payload.runAt)
		if (!Number.isNaN(runAt.getTime()) && runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait-until-due', runAt)
		}
		await step.do(
			'sync-calendar',
			{ retries: { limit: 3, delay: '60 seconds', backoff: 'exponential' } },
			async () => {
				const response = await fetch(
					`${this.env.APP_BASE_URL.replace(/\/$/, '')}${CALENDAR_SYNC_JOB_PATH}`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({ sourceId: event.payload.sourceId }),
						signal: AbortSignal.timeout(60_000),
					},
				)
				if (!response.ok) {
					throw new Error(
						`${CALENDAR_SYNC_JOB_PATH} failed: ${response.status} ${response.statusText}`,
					)
				}
				return { status: response.status }
			},
		)
	}
}
