import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface SocialPostWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type SocialPostWorkflowParams = { postId: string; runAt: string }

export const SOCIAL_PUBLISH_PATH = '/resources/jobs/social-publish'

/**
 * Wakes the App when a scheduled social post is due. The App publishes every
 * post whose time has come and claims each one once, so a wake-up for a post
 * that was rescheduled, deleted or already sent does nothing: nothing ever
 * needs cancelling. The payload carries ids and a time only.
 */
export class SocialPostWorkflow extends WorkflowEntrypoint<
	SocialPostWorkflowEnv,
	SocialPostWorkflowParams
> {
	async run(
		event: WorkflowEvent<SocialPostWorkflowParams>,
		step: WorkflowStep,
	) {
		const runAt = new Date(event.payload.runAt)
		if (!Number.isNaN(runAt.getTime()) && runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait-until-due', runAt)
		}
		await step.do(
			'publish-due-posts',
			{ retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
			async () => {
				const response = await fetch(
					`${this.env.APP_BASE_URL.replace(/\/$/, '')}${SOCIAL_PUBLISH_PATH}`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
						},
					},
				)
				if (!response.ok) {
					throw new Error(
						`${SOCIAL_PUBLISH_PATH} failed: ${response.status} ${response.statusText}`,
					)
				}
				return { status: response.status }
			},
		)
	}
}
