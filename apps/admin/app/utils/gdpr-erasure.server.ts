import { postToApp } from './app-service.server.ts'

export type AppErasureOutcome =
	| {
			ok: true
			processed: number
			failed: number
			held: number
			errors: string[]
	  }
	| { ok: false; error: string }

/**
 * Asks the App to run one due erasure request now
 * (`POST /resources/jobs/gdpr-erasure` with `{ requestId }`). The App owns
 * erasure: the sole-admin re-check, the claim, the regional staff erasure and
 * retries all live there, so Admin never deletes the account itself.
 */
export async function runErasureInApp(
	requestId: string,
): Promise<AppErasureOutcome> {
	const result = await postToApp(
		'/resources/jobs/gdpr-erasure',
		{ requestId },
		{ timeoutMs: 60_000 },
	)
	if (result.status === 'not_configured') {
		return { ok: false, error: 'APP_URL or INTERNAL_COMMAND_TOKEN is not set' }
	}
	if (result.status === 'unreachable') {
		return { ok: false, error: 'The App did not answer' }
	}
	const { response } = result
	const body = (await response.json().catch(() => null)) as {
		processed?: number
		failed?: number
		held?: number
		errors?: Array<{ error?: string }>
	} | null
	if (!response.ok || !body) {
		return { ok: false, error: `The App answered ${response.status}` }
	}
	return {
		ok: true,
		processed: body.processed ?? 0,
		failed: body.failed ?? 0,
		held: body.held ?? 0,
		errors: (body.errors ?? []).map((entry) => entry.error ?? 'unknown'),
	}
}
