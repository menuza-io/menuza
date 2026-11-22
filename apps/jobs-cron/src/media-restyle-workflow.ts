import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

export interface MediaRestyleWorkflowEnv {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
}

export type MediaRestyleWorkflowParams = {
	runId: string
}

export const MEDIA_RESTYLE_JOB_PATH = '/resources/jobs/media-restyle'
const BATCH_TIMEOUT_MS = 280_000
export const MEDIA_RESTYLE_MAX_BATCHES = 600
export const MEDIA_RESTYLE_MAX_IDLE_BATCHES = 3
const FALLBACK_PAUSE = '1 hour'

type MediaRestyleBatchResult = {
	done: boolean
	paused: boolean
	resumeAt: string | null
	processed: number
}

function readBatchResult(value: unknown): MediaRestyleBatchResult {
	const record =
		value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
	return {
		done: record.done === true,
		paused: record.paused === true,
		resumeAt: typeof record.resumeAt === 'string' ? record.resumeAt : null,
		processed:
			typeof record.processed === 'number' &&
			Number.isFinite(record.processed) &&
			record.processed > 0
				? Math.floor(record.processed)
				: 0,
	}
}

/**
 * Restyles a menu's dish photos in the background (#146). The App does the
 * work (it holds the photos and the studio pipeline) in small batches; this
 * Workflow only wakes it with the run id. When the organization's daily
 * budget is reached the App says when to come back and this Workflow sleeps
 * until then. A run that keeps making no progress is left to the hourly
 * sweep. No cron slot is used. The payload is an id: no photo, no dish data.
 */
export class MediaRestyleWorkflow extends WorkflowEntrypoint<
	MediaRestyleWorkflowEnv,
	MediaRestyleWorkflowParams
> {
	async run(
		event: WorkflowEvent<MediaRestyleWorkflowParams>,
		step: WorkflowStep,
	) {
		let idle = 0
		for (let index = 0; index < MEDIA_RESTYLE_MAX_BATCHES; index += 1) {
			const result = await step.do(
				`batch-${index}`,
				{ retries: { limit: 2, delay: '60 seconds', backoff: 'exponential' } },
				async () => {
					const response = await fetch(
						`${this.env.APP_BASE_URL.replace(/\/$/, '')}${MEDIA_RESTYLE_JOB_PATH}`,
						{
							method: 'POST',
							headers: {
								Authorization: `Bearer ${this.env.INTERNAL_COMMAND_TOKEN}`,
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({ runId: event.payload.runId }),
							signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
						},
					)
					if (!response.ok) {
						throw new Error(
							`${MEDIA_RESTYLE_JOB_PATH} failed: ${response.status} ${response.statusText}`,
						)
					}
					return readBatchResult(await response.json().catch(() => ({})))
				},
			)
			if (result.done) return { batches: index + 1, done: true }
			if (result.paused) {
				idle = 0
				const resumeAt = result.resumeAt ? new Date(result.resumeAt) : null
				if (resumeAt && resumeAt.getTime() > Date.now()) {
					await step.sleepUntil(`resume-${index}`, resumeAt)
				} else {
					await step.sleep(`resume-${index}`, FALLBACK_PAUSE)
				}
				continue
			}
			idle = result.processed === 0 ? idle + 1 : 0
			if (idle >= MEDIA_RESTYLE_MAX_IDLE_BATCHES) {
				return { batches: index + 1, done: false, stopped: 'no_progress' }
			}
		}
		return { batches: MEDIA_RESTYLE_MAX_BATCHES, stopped: 'batch_cap' }
	}
}
