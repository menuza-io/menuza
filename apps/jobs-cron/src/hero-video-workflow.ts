import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface HeroVideoWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type HeroVideoWorkflowParams = {
	generationId: string
}

export const HERO_VIDEO_JOB_PATH = '/resources/jobs/hero-video'
const RENDER_TIMEOUT_MS = 280_000

/**
 * Makes a hero video from a restaurant's photos in the background (#301). The
 * App does the work (it holds the photos and the renderer); this Workflow only
 * wakes it with the request id and retries when it is unreachable. No cron
 * slot is used: the hourly sweep is the fallback, and a render that keeps
 * failing ends as a failed request the operator is told about. The payload is
 * an id: no photo, no organization data.
 */
export class HeroVideoWorkflow extends WorkflowEntrypoint<
	HeroVideoWorkflowEnv,
	HeroVideoWorkflowParams
> {
	async run(event: WorkflowEvent<HeroVideoWorkflowParams>, step: WorkflowStep) {
		await step.do(
			'render-hero-video',
			{ retries: { limit: 2, delay: '60 seconds', backoff: 'exponential' } },
			async () => {
				const response = await fetch(
					`${this.env.APP_BASE_URL.replace(/\/$/, '')}${HERO_VIDEO_JOB_PATH}`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({ generationId: event.payload.generationId }),
						signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
					},
				)
				if (!response.ok) {
					throw new Error(
						`${HERO_VIDEO_JOB_PATH} failed: ${response.status} ${response.statusText}`,
					)
				}
				return { status: response.status }
			},
		)
	}
}
