import { ENV } from 'varlock/env'

/**
 * The App Worker, reached through a Cloudflare service binding (`APP`).
 *
 * Admin asks the App to run work the App owns (GDPR erasure, print-shop
 * refunds and retries). On Workers a `fetch` to the App's public URL does not
 * reach the App Worker when both are on the same zone: the request never
 * arrives and hangs until the timeout (see tenant-api's `app-service.ts`). A
 * service binding goes straight to the Worker. `scripts/patch-wrangler.mjs`
 * adds it when `APP_WORKER_NAME` is set; without it (local dev, the Node
 * runtime) calls use the public `APP_URL` through global `fetch`.
 */
export type AppService = {
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

let boundApp: AppService | null = null

/** Call from every Worker entry that receives `env` (fetch, scheduled). */
export function bindAppService(service?: unknown) {
	boundApp =
		service && typeof (service as { fetch?: unknown }).fetch === 'function'
			? (service as AppService)
			: null
}

export function hasAppService() {
	return boundApp !== null
}

export type AppCommandResult =
	/** `APP_URL` or `INTERNAL_COMMAND_TOKEN` is missing. */
	| { status: 'not_configured' }
	/** No answer: a network error, or no answer before the timeout. */
	| { status: 'unreachable' }
	/** The App answered. A redirect is not followed and reads as not ok. */
	| { status: 'answered'; response: Response }

/**
 * POSTs JSON to an App route with the internal command token, over the `APP`
 * service binding when there is one. Never follows a redirect, so the bearer
 * token only ever goes to the App.
 */
export async function postToApp(
	path: string,
	body: unknown,
	options: { timeoutMs: number },
): Promise<AppCommandResult> {
	const base = ENV.APP_URL?.replace(/\/$/, '')
	const token = ENV.INTERNAL_COMMAND_TOKEN
	if (!base || !token) return { status: 'not_configured' }
	const app = boundApp
	const fetchImpl: AppService['fetch'] = app ? app.fetch.bind(app) : fetch
	try {
		const response = await fetchImpl(`${base}${path}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
			redirect: 'manual',
			signal: AbortSignal.timeout(options.timeoutMs),
		})
		return { status: 'answered', response }
	} catch {
		return { status: 'unreachable' }
	}
}
