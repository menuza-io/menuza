import { ENV } from 'varlock/env'

/**
 * Asks App to purge an organization's public site KV cache. Fire-and-forget:
 * callers must not fail their own work when App is down or misconfigured.
 */
export function requestOrganizationSiteCachePurge(organizationId: string) {
	void purgeViaApp(organizationId).catch((error) => {
		console.error(
			'Failed to request site cache purge for organization',
			organizationId,
			error instanceof Error ? error.message : 'unknown error',
		)
	})
}

async function purgeViaApp(organizationId: string) {
	const base = ENV.APP_URL?.replace(/\/$/, '')
	const token = ENV.INTERNAL_COMMAND_TOKEN
	if (!base || !token) {
		console.error(
			'Skipping site cache purge: APP_URL or INTERNAL_COMMAND_TOKEN is not set.',
		)
		return
	}
	const response = await fetch(`${base}/resources/sites/cache-purge`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ organizationId }),
		signal: AbortSignal.timeout(15_000),
	})
	if (!response.ok) {
		console.error(
			'Site cache purge request failed for organization',
			organizationId,
			response.status,
		)
	}
}
