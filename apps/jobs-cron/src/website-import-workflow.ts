import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface WebsiteImportWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type WebsiteImportWorkflowParams = {
	importId: string
}

export const WEBSITE_IMPORT_PATH = '/resources/jobs/website-import'

/**
 * Wakes the App to continue a website import (#140). The App does the fetch
 * behind the SSRF guards. The payload is an id only.
 */
export class WebsiteImportWorkflow extends WorkflowEntrypoint<
	WebsiteImportWorkflowEnv,
	WebsiteImportWorkflowParams
> {
	async run(
		event: WorkflowEvent<WebsiteImportWorkflowParams>,
		step: WorkflowStep,
	) {
		await step.do(
			'continue-website-import',
			{ retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' } },
			async () => {
				const response = await fetch(
					`${this.env.APP_BASE_URL.replace(/\/$/, '')}${WEBSITE_IMPORT_PATH}`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({ importId: event.payload.importId }),
					},
				)
				if (!response.ok) {
					throw new Error(
						`${WEBSITE_IMPORT_PATH} failed: ${response.status} ${response.statusText}`,
					)
				}
				return { status: response.status }
			},
		)
	}
}
