import { fetchNoRedirect } from './fetch-no-redirect.ts'

/**
 * The App Worker, reached through a Cloudflare service binding (`APP`).
 *
 * This node calls the App for organization flags, staffing scope facts, job
 * postings and manager alerts. On Workers a `fetch` to the App's public URL
 * does not reach the App Worker when both are on the same zone: the request
 * never arrives and hangs until the timeout, so every lookup failed and
 * operators saw `Organization not found`. A service binding goes straight to
 * the Worker. It is bound by `scripts/patch-wrangler.mjs` when `APP_WORKER_NAME`
 * is set; without it (local dev, the Node/OCI runtime) calls use the public
 * `APP_URL` through global `fetch`, as before.
 */
export type AppService = {
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

let boundApp: AppService | null = null

/** Call from every entry that receives `env` (Worker fetch, Durable Object). */
export function bindAppService(service?: unknown) {
	boundApp =
		service && typeof (service as { fetch?: unknown }).fetch === 'function'
			? (service as AppService)
			: null
}

export function hasAppService() {
	return boundApp !== null
}

/** `fetch` for an App URL: the service binding when bound, else global fetch. */
export function appFetchImpl(): typeof fetch {
	const app = boundApp
	return app ? (app.fetch.bind(app) as typeof fetch) : fetch
}

/**
 * A request to the App that must not follow or hand back a redirect (see
 * `fetchNoRedirect`), over the service binding when there is one.
 */
export function fetchApp(
	input: string | URL | Request,
	init: RequestInit = {},
): Promise<Response> {
	return fetchNoRedirect(input, init, appFetchImpl())
}
