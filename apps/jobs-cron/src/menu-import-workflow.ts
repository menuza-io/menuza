import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface MenuImportWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type MenuImportWorkflowParams = {
	importId: string
}

export const MENU_IMPORT_PATH = '/resources/jobs/menu-import'

/**
 * Wakes the App to process an AI menu import (#73). The payload carries only
 * `importId` (no menu content, URLs, or PII). The App runs SSRF checks,
 * extraction, and draft persistence.
 */
export class MenuImportWorkflow extends WorkflowEntrypoint<
	MenuImportWorkflowEnv,
	MenuImportWorkflowParams
> {
	async run(
		event: WorkflowEvent<MenuImportWorkflowParams>,
		step: WorkflowStep,
	) {
		await step.do(
			'process-menu-import',
			{ retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' } },
			async () => {
				const response = await fetch(
					`${this.env.APP_BASE_URL.replace(/\/$/, '')}${MENU_IMPORT_PATH}`,
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
						`${MENU_IMPORT_PATH} failed: ${response.status} ${response.statusText}`,
					)
				}
				return { status: response.status }
			},
		)
	}
}
