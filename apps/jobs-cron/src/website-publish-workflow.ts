import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface WebsitePublishWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type WebsitePublishWorkflowParams = {
	scheduleId: string
	runAt: string
}

export const WEBSITE_PUBLISH_PATH = '/resources/jobs/website-publish'

/**
 * Wakes the App when a scheduled website publish is due (#180). The App
 * publishes every schedule whose time has come and claims each one once, so a
 * wake-up for a schedule that was cancelled, replaced or already published
 * does nothing: nothing ever needs cancelling here. The payload carries an id
 * and a time only, never page content.
 */
export class WebsitePublishWorkflow extends WorkflowEntrypoint<
	WebsitePublishWorkflowEnv,
	WebsitePublishWorkflowParams
> {
	async run(
		event: WorkflowEvent<WebsitePublishWorkflowParams>,
		step: WorkflowStep,
	) {
		const runAt = new Date(event.payload.runAt)
		if (!Number.isNaN(runAt.getTime()) && runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait-until-due', runAt)
		}
		await step.do(
			'publish-due-schedules',
			{ retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
			async () => {
				const response = await fetch(
					`${this.env.APP_BASE_URL.replace(/\/$/, '')}${WEBSITE_PUBLISH_PATH}`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
						},
					},
				)
				if (!response.ok) {
					throw new Error(
						`${WEBSITE_PUBLISH_PATH} failed: ${response.status} ${response.statusText}`,
					)
				}
				return { status: response.status }
			},
		)
	}
}
