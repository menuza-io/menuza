import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface MenuSyncWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type MenuSyncWorkflowParams = {
	runAt: string
}

export const MENU_SYNC_JOB_PATH = '/resources/jobs/menu-sync'

/**
 * Wakes the App to drain due `MenuSyncOutbox` rows (#74) right when an
 * availability update, 15-minute coalesced push, or retry backoff timer is due.
 *
 * `apps/jobs-cron/wrangler.jsonc` keeps its exact 5 Cloudflare cron slots, so
 * this mirrors `OperatorAlertsWorkflow`: it sleeps until `runAt`
 * (`step.sleepUntil`) and calls `POST /resources/jobs/menu-sync`, while the
 * 15-minute and 03:00 (`?nightly=1`) sweeps serve as the fallback.
 * The payload is a timestamp only: no PII, no credentials.
 */
export class MenuSyncWorkflow extends WorkflowEntrypoint<
	MenuSyncWorkflowEnv,
	MenuSyncWorkflowParams
> {
	async run(event: WorkflowEvent<MenuSyncWorkflowParams>, step: WorkflowStep) {
		const runAt = new Date(event.payload.runAt)
		if (!Number.isNaN(runAt.getTime()) && runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait-until-menu-sync-due', runAt)
		}
		await step.do(
			'drain-menu-sync-outbox',
			{ retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
			async () => {
				const response = await fetch(
					`${this.env.APP_BASE_URL.replace(/\/$/, '')}${MENU_SYNC_JOB_PATH}`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
						},
					},
				)
				if (!response.ok) {
					throw new Error(
						`${MENU_SYNC_JOB_PATH} failed: ${response.status} ${response.statusText}`,
					)
				}
				return { status: response.status }
			},
		)
	}
}
