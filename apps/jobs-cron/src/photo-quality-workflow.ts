import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface PhotoQualityWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type PhotoQualityWorkflowParams = {
	organizationId: string
}

export const PHOTO_QUALITY_JOB_PATH = '/resources/jobs/photo-quality'
const BATCH_TIMEOUT_MS = 120_000
export const PHOTO_QUALITY_MAX_BATCHES = 24
export const PHOTO_QUALITY_PAUSE = '20 seconds'

type PhotoQualityBatchResult = {
	processed: number
	remaining: number
	limited: boolean
}

function readBatchResult(value: unknown): PhotoQualityBatchResult {
	const record =
		value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
	const count = (input: unknown) =>
		typeof input === 'number' && Number.isFinite(input) && input > 0
			? Math.floor(input)
			: 0
	return {
		processed: count(record.processed),
		remaining: count(record.remaining),
		limited: record.limited === true,
	}
}

/**
 * Scores the photos of one organization in the background (#145). The App
 * does the work (it holds the photos and the vision model) in small batches;
 * this Workflow only wakes it with the organization id, pauses between
 * batches and retries when it is unreachable. It stops when nothing is left,
 * when the organization's daily limit is reached (the hourly sweep resumes it
 * the next day) or when a batch makes no progress. No cron slot is used. The
 * payload is an id: no photo, no organization data.
 */
export class PhotoQualityWorkflow extends WorkflowEntrypoint<
	PhotoQualityWorkflowEnv,
	PhotoQualityWorkflowParams
> {
	async run(
		event: WorkflowEvent<PhotoQualityWorkflowParams>,
		step: WorkflowStep,
	) {
		for (let index = 0; index < PHOTO_QUALITY_MAX_BATCHES; index += 1) {
			const result = await step.do(
				`batch-${index}`,
				{ retries: { limit: 2, delay: '60 seconds', backoff: 'exponential' } },
				async () => {
					const response = await fetch(
						`${this.env.APP_BASE_URL.replace(/\/$/, '')}${PHOTO_QUALITY_JOB_PATH}`,
						{
							method: 'POST',
							headers: {
								Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({
								organizationId: event.payload.organizationId,
							}),
							signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
						},
					)
					if (!response.ok) {
						throw new Error(
							`${PHOTO_QUALITY_JOB_PATH} failed: ${response.status} ${response.statusText}`,
						)
					}
					return readBatchResult(await response.json().catch(() => ({})))
				},
			)
			if (result.remaining === 0 || result.limited || result.processed === 0) {
				return { batches: index + 1, ...result }
			}
			await step.sleep(`pause-${index}`, PHOTO_QUALITY_PAUSE)
		}
		return { batches: PHOTO_QUALITY_MAX_BATCHES, stopped: 'batch_cap' }
	}
}
