import { invariant } from '@epic-web/invariant'
import { ENV } from 'varlock/env'
import { getBoundTenantApiService } from '#app/utils/tenant-api-service.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

/**
 * POSTs a command to the regional node's `/internal/staff/*` surface,
 * authenticated with `INTERNAL_COMMAND_TOKEN`. Server to server only: the body
 * carries ids and the response carries ids or counts (see
 * `@repo/staffing` `internal-api`). The US node is reached through the bound
 * Worker service when there is one, like every other US call from the App.
 */
export async function postRegionalStaffInternal({
	dataRegion,
	path,
	body,
	timeoutMs = 10_000,
}: {
	dataRegion: string
	/** For example `link-user`; no leading slash. */
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
	return fetchImpl(`${tenantApiUrl}/internal/staff/${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
		// Workers fetch supports only 'follow' and 'manual'. Never follow: an
		// internal command must not be replayed, with its token, to another origin.
		redirect: 'manual',
		signal: AbortSignal.timeout(timeoutMs),
	})
}
