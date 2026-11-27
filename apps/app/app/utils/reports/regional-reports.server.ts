import { invariant } from '@epic-web/invariant'
import { ENV } from 'varlock/env'
import { getBoundTenantApiService } from '#app/utils/tenant-api-service.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

/**
 * POSTs to the regional node's `/internal/reports/*` surface (#121, #221),
 * authenticated with `INTERNAL_COMMAND_TOKEN`. Server to server only: the body
 * carries ids, member emails and a report definition, the answer a status per
 * recipient or aggregate totals, never a guest record.
 */
export async function postRegionalReports({
	dataRegion,
	path,
	body,
	timeoutMs = 60_000,
}: {
	dataRegion: string
	/** For example `send`; no leading slash. */
	path: string
	body: Record<string, unknown>
	timeoutMs?: number
}): Promise<Response> {
	const token = ENV.INTERNAL_COMMAND_TOKEN
	invariant(
		token && token.length >= 16,
		'INTERNAL_COMMAND_TOKEN must be configured with >= 16 chars',
	)
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(dataRegion)
	const isUs = (dataRegion || 'us').toLowerCase() !== 'ksa'
	const boundService = isUs ? getBoundTenantApiService() : null
	const fetchImpl = boundService ? boundService.fetch.bind(boundService) : fetch
	return fetchImpl(`${tenantApiUrl}/internal/reports/${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
		redirect: 'manual',
		signal: AbortSignal.timeout(timeoutMs),
	})
}
